import { z } from "zod";
import { env } from "../config/env.js";
import { learningRpc } from "./youtube-notebooks.js";
import { localExtractionRepository } from "./local-youtube.repository.js";

export interface ExtractionRepository {
  reserve(
    sourceId: string,
    language: string,
  ): Promise<{
    disposition: "cached" | "pending" | "failed" | "busy" | "reserved" | "unavailable" | "cooldown";
    token: string | null;
  }>;
  recordRun(sourceId: string, language: string, token: string, runId: string): Promise<boolean>;
  finish(
    sourceId: string,
    language: string,
    token: string,
    text: string,
    metadata: Record<string, unknown>,
  ): Promise<boolean>;
  fail(sourceId: string, language: string, token: string, code: string): Promise<boolean>;
}
const rpc = learningRpc;
const parameters = (sourceId: string, language: string, token: string) => ({
  p_source_id: sourceId,
  p_language: language,
  p_token: token,
});
const hostedExtractionRepository: ExtractionRepository = {
  async reserve(sourceId, language) {
    const data = await rpc(
      language === "auto" ? "reserve_automatic_captions" : "reserve_transcript_extraction",
      {
        p_source_id: sourceId,
        ...(language === "auto" ? {} : { p_language: language }),
      },
    );
    return z
      .array(
        z.object({
          disposition: z.enum([
            "cached",
            "pending",
            "failed",
            "busy",
            "reserved",
            "unavailable",
            "cooldown",
          ]),
          token: z.uuid().nullable(),
        }),
      )
      .length(1)
      .parse(data)[0]!;
  },
  async recordRun(sourceId, language, token, runId) {
    return (
      (await rpc(language === "auto" ? "record_automatic_caption_run" : "record_transcript_run", {
        ...(language === "auto"
          ? { p_source_id: sourceId, p_token: token }
          : parameters(sourceId, language, token)),
        p_run_id: runId,
      })) === true
    );
  },
  async finish(sourceId, language, token, text, metadata) {
    return (
      (await rpc(
        language === "auto" ? "finish_automatic_captions" : "finish_transcript_extraction",
        {
          ...(language === "auto"
            ? { p_source_id: sourceId, p_token: token }
            : parameters(sourceId, language, token)),
          p_text: text,
          p_metadata: metadata,
        },
      )) === true
    );
  },
  async fail(sourceId, language, token, code) {
    return (
      (await rpc(language === "auto" ? "fail_automatic_captions" : "fail_transcript_extraction", {
        ...(language === "auto"
          ? { p_source_id: sourceId, p_token: token }
          : parameters(sourceId, language, token)),
        p_code: code,
      })) === true
    );
  },
};

export const extractionRepository: ExtractionRepository =
  env.WORKSPACE_YOUTUBE_STORE === "local" ? localExtractionRepository : hostedExtractionRepository;
