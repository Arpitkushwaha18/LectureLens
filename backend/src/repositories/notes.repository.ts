import { z } from "zod";
import {
  transcriptSegmentSchema,
  transcriptMetadataSchema,
  type TranscriptMetadata,
  type DetailedNotes,
} from "@lecturelens/contracts";
import { getSupabaseAdmin } from "../lib/supabase.js";
import { AppError } from "../lib/errors.js";
import { NotesGenerationError } from "../modules/ai/gemini-notes.js";
import type { GenerationEvidence } from "../modules/ai/generation-evidence.js";
import { NOTES_PROMPT_VERSION, NOTES_SETTINGS } from "../modules/ai/gemini-notes.js";
import { FENCED_JOB_MESSAGE } from "../lib/job-message.js";
import { retryDelay, definitiveFailure } from "../modules/ai/generation-lifecycle.js";
import { env } from "../config/env.js";
import { learningRpc, learningStorageError } from "./youtube-notebooks.js";
import { localNotesRepository } from "./local-youtube.repository.js";

export type TranscriptRow = {
  id: string;
  text_content: string;
  content_hash: string;
  provenance: "manual" | "authorized_youtube" | "licensed_provider";
  reused: boolean;
  metadata?: {
    segments?: import("@lecturelens/contracts").TranscriptSegment[];
    requestedLanguage?: "en" | "hi";
    returnedLanguage?: string;
    extractedAt?: string;
    sourceMetadata?: TranscriptMetadata["sourceMetadata"];
    providerId?: string;
    providerVersion?: string;
    captionSelection?: "provider_default" | "human" | "automatic" | "unknown";
    translationStatus?: "not_requested" | "reported_original" | "reported_translated" | "unknown";
  };
};
export type Reservation = {
  content_id: string;
  job_id: string | null;
  disposition: "reused" | "reserved" | "existing_job" | "failed";
};
export type SavedNotes = {
  payload: unknown;
  transcript_id: string;
  content_hash: string;
  provenance: TranscriptRow["provenance"];
};
export type JobState = {
  status: string;
  leased_until: string | null;
  available_at: string;
  last_error_code: string | null;
  failure_kind?: string | null;
  request_may_have_been_sent?: boolean | null;
};
export interface NotesRepository {
  evidence?(
    jobId: string,
    token: string,
    event: GenerationEvidence,
    checkpoint?: DetailedNotes,
  ): Promise<void>;
  ensureSource(videoId: string): Promise<string>;
  findTranscript(sourceId: string, language: string): Promise<TranscriptRow | null>;
  findBestTranscript?(sourceId: string): Promise<TranscriptRow | null>;
  acquireTranscript(
    sourceId: string,
    text: string,
    language: string,
    provenance: string,
    providerId: string,
    providerVersion: string,
  ): Promise<TranscriptRow>;
  reserve(sourceId: string, transcriptId: string, model: string): Promise<Reservation>;
  claim(jobId: string): Promise<string | null>;
  finish(jobId: string, token: string, notes: DetailedNotes): Promise<boolean>;
  fail(
    jobId: string,
    token: string,
    code: string,
    retryable: boolean,
    retryAfterSeconds?: number,
  ): Promise<boolean>;
  guardGeneration?(sourceId: string, transcriptId: string, model: string): Promise<void>;
  guardLocalGeneration?(sourceId: string, transcriptId: string, outputType: string): Promise<void>;
  read(videoId: string, contentId: string): Promise<SavedNotes | null>;
  job(jobId: string): Promise<JobState | null>;
}
function databaseError(): never {
  // Never attach raw PostgREST/driver responses (may contain secrets/input).
  throw new AppError(
    "The learning database could not complete this operation. Check the migrations and backend connection.",
    { statusCode: 503, code: "DATABASE_UNAVAILABLE" },
  );
}
async function rpc(name: string, parameters: Record<string, unknown>) {
  try {
    return await learningRpc(name, parameters);
  } catch (error) {
    if (error instanceof AppError) throw error;
    databaseError();
  }
}
const transcriptRowSchema = z.object({
  id: z.uuid(),
  text_content: z.string(),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  provenance: z.enum(["manual", "authorized_youtube", "licensed_provider"]),
  reused: z.boolean().default(true),
  metadata: z
    .object({
      segments: z.array(transcriptSegmentSchema).optional(),
      requestedLanguage: z.enum(["en", "hi"]).optional(),
      returnedLanguage: z.string().optional(),
      extractedAt: z.string().optional(),
      sourceMetadata: transcriptMetadataSchema.shape.sourceMetadata,
      providerId: z.string().optional(),
      providerVersion: z.string().optional(),
      captionSelection: z.enum(["provider_default", "human", "automatic", "unknown"]).optional(),
      translationStatus: z
        .enum(["not_requested", "reported_original", "reported_translated", "unknown"])
        .optional(),
    })
    .optional(),
});
function parseTranscript(value: unknown): TranscriptRow {
  const parsed = transcriptRowSchema.safeParse(value);
  if (!parsed.success) databaseError();
  return parsed.data;
}
export function hostedJobBlocksLocalGeneration(job: {
  status: string;
  last_error_code: string | null;
}) {
  // Active legacy jobs could still be picked up by a hosted worker. Even a
  // definitive previous rejection does not authorize concurrent stores to retry.
  if (["queued", "retry_wait", "running"].includes(job.status)) return true;
  if (["failed", "cancelled"].includes(job.status))
    return !definitiveFailure(String(job.last_error_code));
  return !["succeeded"].includes(job.status);
}
export const hostedNotesRepository: NotesRepository = {
  async guardLocalGeneration(sourceId, transcriptId, outputType) {
    // Read the legacy hosted fence before changing storage. Never bypass an unknown
    // paid outcome just because local generation does not require new hosted RPCs.
    const { data, error } = await getSupabaseAdmin()
      .from("generation_jobs")
      .select("status,last_error_code,generated_content!inner(source_id,transcript_id,output_type)")
      .eq("generated_content.source_id", sourceId)
      .eq("generated_content.transcript_id", transcriptId)
      .eq("generated_content.output_type", outputType)
      .in("status", ["queued", "retry_wait", "running", "failed", "cancelled"]);
    if (error) databaseError();
    if (data?.some(hostedJobBlocksLocalGeneration))
      throw new AppError(FENCED_JOB_MESSAGE, { code: "JOB_RECOVERY_REQUIRED", statusCode: 503 });
  },
  async evidence(jobId, token, event, checkpoint) {
    const { data, error } = await getSupabaseAdmin().rpc("record_generation_evidence", {
      p_job_id: jobId,
      p_token: token,
      p_event: event,
      p_checkpoint: checkpoint ?? null,
    });
    if (error || !data)
      throw new NotesGenerationError(
        "GENERATION_AUDIT_UNAVAILABLE",
        "Generation auditing is unavailable. Operator approval/application of migration 006 is required before a new request.",
        false,
        503,
      );
  },
  async guardGeneration(sourceId, transcriptId, model) {
    const { data, error } = await getSupabaseAdmin()
      .from("generation_jobs")
      .select(
        "status,last_error_code,operator_resolution,operation_identity,failure_kind,generated_content!inner(source_id,transcript_id,output_type,model_identifier)",
      )
      .eq("generated_content.source_id", sourceId)
      .eq("generated_content.transcript_id", transcriptId)
      .eq("generated_content.output_type", "detailed_notes")
      .in("status", ["running", "failed", "cancelled"]);
    if (error)
      throw new NotesGenerationError(
        "GENERATION_AUDIT_UNAVAILABLE",
        "Generation lifecycle migration 007 is unavailable. No new request was dispatched.",
        false,
        503,
      );
    if (
      data?.some(
        (job) =>
          (job.status === "running" &&
            (job.generated_content as unknown as { model_identifier: string }).model_identifier !==
              model) ||
          (["failed", "cancelled"].includes(job.status) &&
            !definitiveFailure(String(job.last_error_code)) &&
            job.operator_resolution !== "retry_approved"),
      )
    )
      throw new AppError(FENCED_JOB_MESSAGE, { code: "JOB_RECOVERY_REQUIRED", statusCode: 503 });
  },
  async ensureSource(videoId) {
    const data = await rpc("ensure_youtube_source", { p_video_id: videoId });
    const parsed = z.uuid().safeParse(data);
    if (!parsed.success) databaseError();
    return parsed.data;
  },
  async findTranscript(sourceId, language) {
    const { data, error } = await getSupabaseAdmin()
      .from("transcripts")
      .select("id,text_content,content_hash,provenance,metadata")
      .eq("source_id", sourceId)
      .eq("language", language)
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) learningStorageError("find_transcript", error);
    return data ? parseTranscript(data) : null;
  },
  async findBestTranscript(sourceId) {
    const { data, error } = await getSupabaseAdmin()
      .from("transcripts")
      .select("id,text_content,content_hash,provenance,metadata,language")
      .eq("source_id", sourceId)
      .eq("provenance", "licensed_provider")
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
      .order("version", { ascending: false })
      .limit(50);
    if (error) learningStorageError("find_best_transcript", error);
    const ranked = (data ?? [])
      .filter((row) => row.metadata?.sourceMetadata?.source !== "audio")
      .sort(
        (a, b) =>
          Number(b.metadata?.captionSelection === "human") -
          Number(a.metadata?.captionSelection === "human"),
      );
    const selected = ranked[0];
    return selected
      ? parseTranscript({
          ...selected,
          metadata: {
            ...selected.metadata,
            returnedLanguage: selected.metadata?.returnedLanguage ?? selected.language,
          },
        })
      : null;
  },
  async acquireTranscript(sourceId, text, language, provenance, providerId, providerVersion) {
    const data = await rpc("acquire_youtube_transcript", {
      p_source_id: sourceId,
      p_text: text,
      p_language: language,
      p_provenance: provenance,
      p_provider_id: providerId,
      p_provider_version: providerVersion,
    });
    return parseTranscript(z.array(z.unknown()).parse(data)[0]);
  },
  async reserve(sourceId, transcriptId, model) {
    const data = await rpc("reserve_generation", {
      p_source_id: sourceId,
      p_transcript_id: transcriptId,
      p_output_type: "detailed_notes",
      p_language: "en",
      p_model_identifier: model,
      p_prompt_version: NOTES_PROMPT_VERSION,
      p_output_schema_version: 1,
      p_generation_settings: NOTES_SETTINGS,
    });
    const parsed = z
      .object({
        content_id: z.uuid(),
        job_id: z.uuid().nullable(),
        disposition: z.enum(["reused", "reserved", "existing_job", "failed"]),
      })
      .safeParse(z.array(z.unknown()).parse(data)[0]);
    if (!parsed.success) databaseError();
    return parsed.data;
  },
  async claim(jobId) {
    return (await rpc("claim_generation", { p_job_id: jobId })) as string | null;
  },
  async finish(jobId, token, notes) {
    return (
      (await rpc("finish_generation", { p_job_id: jobId, p_token: token, p_payload: notes })) ===
      true
    );
  },
  async fail(jobId, token, code, retryable, retryAfterSeconds = 60) {
    const { data, error } = await getSupabaseAdmin()
      .from("generation_jobs")
      .select("attempts")
      .eq("id", jobId)
      .eq("lease_token", token)
      .maybeSingle();
    if (error) databaseError();
    if (!data) return false;
    return (
      (await rpc("fail_generation_attempt", {
        p_job_id: jobId,
        p_token: token,
        p_code: code,
        p_retryable: retryable,
        p_delay_seconds: retryable ? retryDelay(data.attempts, retryAfterSeconds) : 0,
      })) === true
    );
  },
  async read(videoId, contentId) {
    return (
      (
        (await rpc("read_youtube_notes", { p_video_id: videoId, p_content_id: contentId })) as
          SavedNotes[] | null
      )?.[0] ?? null
    );
  },
  async job(jobId) {
    const { data, error } = await getSupabaseAdmin()
      .from("generation_jobs")
      .select(
        "status,leased_until,available_at,last_error_code,failure_kind,request_may_have_been_sent",
      )
      .eq("id", jobId)
      .maybeSingle();
    if (error) databaseError();
    return data;
  },
};

export const notesRepository: NotesRepository =
  env.WORKSPACE_YOUTUBE_STORE === "local" ? localNotesRepository : hostedNotesRepository;
