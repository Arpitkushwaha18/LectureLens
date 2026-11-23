import { createHash } from "node:crypto";
import { ZodError } from "zod";
import {
  detailedNotesSchema,
  notesRequestSchema,
  notesOutcomeSchema,
  parseYouTubeUrl,
  manualNotesTranscriptSchema,
  transcriptProviderOutcomeSchema,
  type NotesOutcome,
} from "@lecturelens/contracts";
import { AppError } from "../lib/errors.js";
import { withGenerationEvidence } from "../modules/ai/generation-evidence.js";
import { FENCED_JOB_MESSAGE } from "../lib/job-message.js";
import { getConfiguredGemini, NotesGenerationError } from "../modules/ai/gemini-notes.js";
import { type TranscriptProvider } from "../modules/extraction/transcript-provider.js";
import { configuredTranscriptProvider } from "./transcript-extraction.service.js";
import {
  hostedNotesRepository,
  type NotesRepository,
  type SavedNotes,
} from "../repositories/notes.repository.js";

export function createNotesService(
  repository: NotesRepository,
  gemini: typeof getConfiguredGemini = getConfiguredGemini,
  provider: TranscriptProvider = configuredTranscriptProvider,
  // Validate local model/key settings before spending a transcript credit.
  requireGenerationConfiguration: () => void = () => {
    if (gemini === getConfiguredGemini) getConfiguredGemini();
  },
) {
  // A modest per-process cost/concurrency gate; database claims enforce identity
  // exclusivity across all processes. Not a production distributed quota system.
  let running = 0;
  return async (
    input: unknown,
    onStage?: (stage: "extracting" | "preparing" | "generating") => void,
  ): Promise<NotesOutcome> => {
    const request = notesRequestSchema.parse(input);
    const source = parseYouTubeUrl(request.url);
    onStage?.("extracting");
    const sourceId = await repository.ensureSource(source.videoId);
    let transcript = await repository.findTranscript(sourceId, request.transcriptLanguage);
    if (!transcript) {
      if (request.checkOnly) return { status: "extracting", source, retryAfterSeconds: 3 };
      requireGenerationConfiguration();
      if (request.transcript) {
        transcript = await repository.acquireTranscript(
          sourceId,
          request.transcript,
          request.transcriptLanguage,
          "manual",
          "youtube_show_transcript",
          "manual-v1",
        );
      } else {
        let outcome;
        try {
          outcome = transcriptProviderOutcomeSchema.parse(
            await provider.acquire(source, request.transcriptLanguage),
          );
        } catch (error) {
          if (error instanceof AppError && error.code === "EXTRACTION_PENDING")
            return { status: "extracting", source, retryAfterSeconds: 3 };
          throw error;
        }
        if (outcome.status !== "available")
          return { status: "transcript_required", source, provider: outcome };
        const supplied = outcome.transcript;
        const contentHash = createHash("sha256").update(supplied.text, "utf8").digest("hex");
        if (
          supplied.metadata.videoId !== source.videoId ||
          supplied.metadata.language.toLowerCase() !== request.transcriptLanguage ||
          (supplied.metadata.contentHash && supplied.metadata.contentHash !== contentHash) ||
          (supplied.metadata.expiresAt && Date.parse(supplied.metadata.expiresAt) <= Date.now())
        )
          throw new AppError("The transcript provider returned an unusable transcript.", {
            statusCode: 502,
            code: "TRANSCRIPT_INVALID",
          });
        // Expiring providers need an explicit retention implementation.
        if (supplied.metadata.expiresAt)
          throw new AppError("Provider transcript expiry is not supported by this MVP.", {
            statusCode: 503,
            code: "TRANSCRIPT_PROVIDER_UNSUPPORTED",
          });
        transcript = await repository.acquireTranscript(
          sourceId,
          manualNotesTranscriptSchema.parse(supplied.text),
          request.transcriptLanguage,
          supplied.metadata.provenance,
          supplied.metadata.provider.id,
          supplied.metadata.provider.version,
        );
        // The fenced provider inserted metadata atomically. The legacy acquisition
        // RPC returns text-only columns, so read back the timestamped row for display.
        const stored = await repository.findTranscript(sourceId, request.transcriptLanguage);
        if (stored?.id === transcript.id)
          transcript = { ...stored, reused: stored.content_hash !== contentHash };
      }
    }
    // No model is guessed. Even cache lookup uses the exact server configuration.
    const configured = gemini(true);
    onStage?.("preparing");
    const reservation = await repository.reserve(sourceId, transcript.id, configured.model);
    function ready(saved: SavedNotes, cached: boolean): NotesOutcome {
      const parsed = detailedNotesSchema.safeParse(saved.payload);
      if (!parsed.success)
        throw new AppError(
          "Saved notes do not match the output contract. Operator review is required.",
          { statusCode: 503, code: "CACHE_INVALID" },
        );
      return notesOutcomeSchema.parse({
        status: "ready",
        source,
        contentId: reservation.content_id,
        cached,
        transcript: {
          id: saved.transcript_id,
          contentHash: saved.content_hash,
          provenance: saved.provenance,
          reused: transcript!.reused,
          language: transcript!.metadata?.returnedLanguage ?? request.transcriptLanguage,
        },
        notes: parsed.data,
      });
    }
    const saved = await repository.read(source.videoId, reservation.content_id);
    if (saved) return ready(saved, true);
    if (reservation.disposition === "reused")
      throw new AppError("The cached notes are no longer available. Try again.", {
        statusCode: 409,
        code: "CACHE_CHANGED",
      });
    if (!reservation.job_id)
      throw new AppError("The generation reservation is invalid.", {
        statusCode: 503,
        code: "JOB_INVALID",
      });
    const job = await repository.job(reservation.job_id);
    if (
      reservation.disposition === "failed" ||
      job?.status === "failed" ||
      job?.status === "cancelled"
    )
      throw new AppError(FENCED_JOB_MESSAGE, { statusCode: 503, code: "JOB_RECOVERY_REQUIRED" });
    if (job?.status === "running" && job.leased_until && Date.parse(job.leased_until) <= Date.now())
      throw new AppError(FENCED_JOB_MESSAGE, { statusCode: 503, code: "JOB_RECOVERY_REQUIRED" });
    const processing = (): NotesOutcome => ({
      status: "processing",
      source,
      contentId: reservation.content_id,
      retryAfterSeconds:
        job?.status === "retry_wait"
          ? Math.min(
              300,
              Math.max(2, Math.ceil((Date.parse(job.available_at) - Date.now()) / 1000)),
            )
          : 3,
    });
    if (running >= 2) return processing();
    if (request.checkOnly) {
      if (job?.status === "running") return processing();
      const delay =
        Math.max(0, Math.ceil((Date.parse(job?.available_at ?? "") - Date.now()) / 1000)) || 0;
      throw new NotesGenerationError(
        job?.last_error_code ?? "GENERATION_NOT_SENT",
        "Generation failed. You can try again.",
        delay > 0 || !job?.last_error_code,
        503,
        Math.max(1, delay),
      );
    }
    gemini();
    await repository.guardGeneration?.(sourceId, transcript.id, configured.model);
    running++;
    try {
      const token = await repository.claim(reservation.job_id);
      if (!token) {
        const completed = await repository.read(source.videoId, reservation.content_id);
        return completed ? ready(completed, true) : processing();
      }
      let notes;
      onStage?.("generating");
      try {
        notes = detailedNotesSchema.parse(
          await withGenerationEvidence(
            (event) => repository.evidence?.(reservation.job_id!, token, event),
            () => configured.generate(manualNotesTranscriptSchema.parse(transcript.text_content)),
          ),
        );
        await repository.evidence?.(reservation.job_id, token, { kind: "validated" }, notes);
      } catch (error) {
        const failure =
          error instanceof NotesGenerationError
            ? error
            : error instanceof ZodError
              ? new NotesGenerationError(
                  "GEMINI_INVALID_OUTPUT",
                  "Generation failed. You can try again.",
                )
              : new NotesGenerationError("GEMINI_UNCERTAIN", FENCED_JOB_MESSAGE);
        await repository.fail(
          reservation.job_id,
          token,
          failure.code,
          failure.retryable,
          failure.retryAfterSeconds,
        );
        if (failure.retryable) {
          const updated = await repository.job(reservation.job_id);
          throw new NotesGenerationError(
            failure.code,
            failure.message,
            true,
            failure.statusCode,
            Math.max(1, Math.ceil((Date.parse(updated?.available_at ?? "") - Date.now()) / 1000)) ||
              failure.retryAfterSeconds,
          );
        }
        throw failure;
      }
      // If persistence fails after a paid call, leave the running claim fenced.
      // Do not reset/replay it automatically with an uncertain database outcome.
      if (!(await repository.finish(reservation.job_id, token, notes)))
        throw new AppError(
          "The generation lease expired or the resource changed. No notes were published.",
          { statusCode: 409, code: "JOB_LEASE_LOST" },
        );
      const persisted = await repository.read(source.videoId, reservation.content_id);
      if (!persisted)
        throw new AppError("Generated notes could not be read back.", {
          statusCode: 503,
          code: "RESULT_UNAVAILABLE",
        });
      return ready(persisted, false);
    } finally {
      running--;
    }
  };
}
// The legacy endpoint keeps its hosted-storage contract. The workspace uses
// the locally selectable repository through its own service.
export const generateDetailedNotes = createNotesService(hostedNotesRepository);
