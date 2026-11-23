import { z } from "zod";
import { notebookSchema, type Notebook } from "@lecturelens/contracts";
import { getSupabaseAdmin } from "../lib/supabase.js";
import { AppError } from "../lib/errors.js";
import type { GenerationEvidence } from "../modules/ai/generation-evidence.js";
import { logger } from "../lib/logger.js";
export function learningStorageError(operation: string, error?: { code?: string }): never {
  const schema = ["PGRST202", "PGRST205", "42883", "42P01", "3F000"].includes(error?.code ?? "");
  const permission = error?.code === "42501";
  logger.error(
    {
      operation,
      storageCode: error?.code ?? "connection",
      remedy: schema
        ? "Apply the local forward-only migrations 001–012 to an approved development database, then reload the PostgREST schema."
        : permission
          ? "Restore service_role table/schema/RPC permissions from the local migrations."
          : "Check the backend database URL, server credential and connection.",
    },
    "YouTube storage operation failed; no provider request should be retried without checking its saved job",
  );
  throw new AppError(
    schema
      ? "Lecture storage is not ready yet. Please contact support; no new transcript request was started."
      : permission
        ? "Lecture storage needs a connection repair. Please contact support; no new transcript request was started."
        : "Lecture storage could not be reached. Please try again later; no new transcript request was started.",
    {
      statusCode: 503,
      code: schema
        ? "LEARNING_SCHEMA_MISSING"
        : permission
          ? "LEARNING_STORAGE_FORBIDDEN"
          : "LEARNING_STORAGE_UNAVAILABLE",
    },
  );
}
export async function learningRpc(name: string, params: Record<string, unknown>): Promise<unknown> {
  try {
    const { data, error } = await getSupabaseAdmin().rpc(name, params);
    if (error) learningStorageError(name, error);
    return data;
  } catch (error) {
    if (error instanceof AppError) throw error;
    learningStorageError(name);
  }
}
const claimSchema = z.object({
  status: z.enum(["ready", "reserved", "pending", "missing", "cooldown"]),
  identity: z.string(),
  token: z.uuid().optional(),
  notebook: notebookSchema.optional(),
});
export interface YouTubeNotebookStore {
  claim(
    videoId: string,
    transcriptId: string,
    output: string,
    model: string,
    prompt: string,
    checkOnly: boolean,
  ): Promise<z.infer<typeof claimSchema>>;
  evidence(
    identity: string,
    token: string,
    event: GenerationEvidence,
    checkpoint?: Notebook,
  ): Promise<void>;
  finish(identity: string, token: string, notebook: Notebook): Promise<void>;
  fail(identity: string, token: string, code: string, safe: boolean): Promise<void>;
}
export const youtubeNotebookStore: YouTubeNotebookStore = {
  async claim(video, transcript, output, model, prompt, check) {
    return claimSchema.parse(
      await learningRpc("claim_youtube_notebook", {
        p_video_id: video,
        p_transcript_id: transcript,
        p_output: output,
        p_model: model,
        p_prompt: prompt,
        p_schema: 2,
        p_check: check,
      }),
    );
  },
  async evidence(identity, token, event, checkpoint) {
    if (
      (await learningRpc("youtube_notebook_evidence", {
        p_identity: identity,
        p_token: token,
        p_event: event,
        p_checkpoint: checkpoint ?? null,
      })) !== true
    )
      learningStorageError("youtube_notebook_evidence");
  },
  async finish(identity, token, notebook) {
    if (
      (await learningRpc("finish_youtube_notebook", {
        p_identity: identity,
        p_token: token,
        p_payload: notebookSchema.parse(notebook),
      })) !== true
    )
      learningStorageError("finish_youtube_notebook");
  },
  async fail(identity, token, code, safe) {
    if (
      (await learningRpc("fail_youtube_notebook", {
        p_identity: identity,
        p_token: token,
        p_code: code,
        p_safe: safe,
      })) !== true
    )
      learningStorageError("fail_youtube_notebook");
  },
};
