import {
  canonicalVideoSourceSchema,
  transcriptProviderOutcomeSchema,
} from "@lecturelens/contracts";
import { env } from "../config/env.js";
import { AppError } from "../lib/errors.js";
import {
  TranscriptExtractionError,
  createTranscriptFetchProvider,
  transcriptFailureMessage,
} from "../modules/extraction/transcriptfetch-transcript.js";
import {
  unavailableTranscriptProvider,
  type TranscriptProvider,
} from "../modules/extraction/transcript-provider.js";
import { notesRepository, type NotesRepository } from "../repositories/notes.repository.js";
import {
  extractionRepository,
  type ExtractionRepository,
} from "../repositories/transcript-extraction.repository.js";
import { logger } from "../lib/logger.js";

export function createFencedTranscriptProvider(
  provider: TranscriptProvider,
  resources: Pick<NotesRepository, "ensureSource">,
  jobs: ExtractionRepository,
): TranscriptProvider {
  return {
    async acquire(source, language) {
      source = canonicalVideoSourceSchema.parse(source);
      if (language !== "auto" && language !== "en" && language !== "hi")
        return {
          schemaVersion: 1,
          status: "unavailable",
          reason: "language_unavailable",
          message:
            "Automatic transcripts support English and Hindi selections. Choose a supported language.",
        };
      const sourceId = await resources.ensureSource(source.videoId);
      const reservation = await jobs.reserve(sourceId, language);
      if (reservation.disposition === "unavailable")
        return {
          schemaVersion: 1,
          status: "unavailable",
          reason: "captions_unavailable",
          message:
            "This lecture has no usable transcript. Try another lecture or paste your notes.",
        };
      if (reservation.disposition === "cooldown")
        return {
          schemaVersion: 1,
          status: "temporarily_failed",
          message:
            "Lecture checking is waiting briefly after a temporary problem. Please check again in a minute.",
        };
      if (["pending", "cached", "busy"].includes(reservation.disposition))
        throw new AppError("Shared transcript extraction is pending.", {
          statusCode: 409,
          code: "EXTRACTION_PENDING",
        });
      if (reservation.disposition === "failed" || !reservation.token)
        return {
          schemaVersion: 1,
          status: "temporarily_failed",
          message:
            "A previous transcript check did not finish safely. We have not started another request. Please contact support or use another lecture.",
        };
      const token = reservation.token;
      let outcome;
      try {
        outcome = transcriptProviderOutcomeSchema.parse(
          await provider.acquire(source, language, async (id) => {
            if (!(await jobs.recordRun(sourceId, language, token, id)))
              throw new Error("Extraction lease lost");
          }),
        );
        if (outcome.status !== "available") {
          await jobs.fail(
            sourceId,
            language,
            token,
            outcome.status === "unavailable"
              ? "TRANSCRIPT_UNAVAILABLE"
              : "TRANSCRIPT_REQUEST_FAILED",
          );
          return outcome;
        }
        if (
          outcome.transcript.metadata.videoId !== source.videoId ||
          (language !== "auto" && outcome.transcript.metadata.language !== language) ||
          !outcome.transcript.segments
        )
          throw new TranscriptExtractionError(
            "TRANSCRIPT_INVALID_OUTPUT",
            "The extracted transcript did not match this video/language.",
          );
      } catch (error) {
        if (error instanceof AppError) throw error;
        const code =
          error instanceof TranscriptExtractionError ? error.code : "TRANSCRIPT_INVALID_OUTPUT";
        logger.warn(
          { videoId: source.videoId, code },
          "Caption acquisition failed; no transcript content logged",
        );
        await jobs.fail(
          sourceId,
          language,
          token,
          error instanceof TranscriptExtractionError ? error.code : "TRANSCRIPT_INVALID_OUTPUT",
        );
        return {
          schemaVersion: 1,
          status: "temporarily_failed",
          message: transcriptFailureMessage(code),
        };
      }
      // Uncertain commit outcomes stay fenced; never replay a paid provider call.
      if (
        !(await jobs.finish(sourceId, language, token, outcome.transcript.text, {
          segments: outcome.transcript.segments,
          ...(language === "auto"
            ? {
                language: outcome.transcript.metadata.language,
                captionSelection:
                  outcome.transcript.metadata.captionSelection ?? "provider_default",
                translationStatus: outcome.transcript.metadata.translationStatus ?? "unknown",
              }
            : { requestedLanguage: language }),
          ...(outcome.transcript.metadata.returnedLanguage
            ? { returnedLanguage: outcome.transcript.metadata.returnedLanguage }
            : {}),
          extractedAt: outcome.transcript.metadata.obtainedAt,
          providerId: outcome.transcript.metadata.provider.id,
          providerVersion: outcome.transcript.metadata.provider.version,
          ...(outcome.transcript.metadata.sourceMetadata
            ? { sourceMetadata: outcome.transcript.metadata.sourceMetadata }
            : {}),
          ...(outcome.transcript.metadata.usage
            ? { usage: outcome.transcript.metadata.usage }
            : {}),
        }))
      )
        return {
          schemaVersion: 1,
          status: "temporarily_failed",
          message:
            "The extraction lease expired. No transcript was published. Operator review is needed before retrying.",
        };
      return outcome;
    },
  };
}
export const configuredTranscriptProvider = env.TRANSCRIPTFETCH_API_KEY
  ? createFencedTranscriptProvider(
      createTranscriptFetchProvider({
        apiKey: env.TRANSCRIPTFETCH_API_KEY,
        maxCharacters: env.TRANSCRIPT_MAX_CHARACTERS,
        maxDurationSeconds: env.TRANSCRIPT_MAX_DURATION_SECONDS,
      }),
      notesRepository,
      extractionRepository,
    )
  : unavailableTranscriptProvider;
