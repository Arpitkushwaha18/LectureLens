import { z } from "zod";
import {
  generationSelectionV2Schema,
  flashcardCountSchema,
  quizCountSchema,
  studyPreferencesSchema,
  parseYouTubeUrl,
  notebookSchema,
  workspaceResultSchema,
  type WorkspaceEvent,
  type WorkspaceResult,
  type ExtractedSource,
  type PublicSource,
} from "@lecturelens/contracts";
import {
  extractDocument,
  validateDocumentUpload,
  safeDocumentName,
} from "../modules/extraction/documents.js";
import {
  getConfiguredStudyGemini,
  getConfiguredTutorGemini,
  getConfiguredLongTutor,
} from "../modules/ai/gemini-study.js";
import {
  createTranscriptFetchProvider,
  TranscriptExtractionError,
} from "../modules/extraction/transcriptfetch-transcript.js";
import { NotesGenerationError } from "../modules/ai/gemini-notes.js";
import { detectSourceLanguage } from "../modules/extraction/language.js";
import { resolveOutputLanguage } from "../modules/ai/study-preferences.js";
import { AppError } from "../lib/errors.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { classifyGeminiError } from "../modules/ai/gemini-notes.js";

const requestSchema = z.strictObject({
  sourceType: z.enum(["youtube", "pdf", "spreadsheet"]),
  url: z.string().max(2048).optional(),
  transcriptLanguage: z.enum(["auto", "en", "hi"]).default("auto"),
  verificationToken: z.string().max(200).optional(),
  flashcardCount: flashcardCountSchema,
  quizCount: quizCountSchema,
  preferences: studyPreferencesSchema,
  subject: z.string().trim().min(1).max(180).optional(),
  outputTypes: generationSelectionV2Schema.shape.outputTypes,
  allowPartial: z.boolean().default(false),
  checkOnly: z.boolean().default(false),
});

/** Request-local only: no repository, disk cache, Supabase, auth or paid-call ledger. */
export function createTemporaryWorkspaceService(
  deps = {
    extract: extractDocument,
    gemini: getConfiguredStudyGemini,
    transcript: () => {
      if (!env.TRANSCRIPTFETCH_API_KEY)
        throw new AppError(
          "Lecture transcripts are unavailable right now. Please upload a document instead.",
          { code: "TRANSCRIPT_NOT_CONFIGURED", statusCode: 503 },
        );
      return createTranscriptFetchProvider({
        apiKey: env.TRANSCRIPTFETCH_API_KEY,
        maxCharacters: env.TRANSCRIPT_MAX_CHARACTERS,
        maxDurationSeconds: env.TRANSCRIPT_MAX_DURATION_SECONDS,
      });
    },
  },
) {
  return async (
    input: unknown,
    file: { buffer: Buffer; originalname: string } | undefined,
    emit: (event: WorkspaceEvent) => void,
    signal?: AbortSignal,
  ): Promise<WorkspaceResult> => {
    const request = requestSchema.parse(input);
    const stage = (
      name: "validating" | "extracting" | "preparing" | "generating" | "rendering",
      message: string,
    ) => emit({ event: "stage", stage: name, message });
    stage("validating", "Checking your source");
    const configured = deps.gemini();
    let source: ExtractedSource;
    if (request.sourceType === "youtube") {
      if (file)
        throw new AppError("Use a lecture URL without an uploaded file.", {
          code: "SOURCE_INVALID",
          statusCode: 400,
        });
      const canonical = parseYouTubeUrl(request.url);
      stage("extracting", "Fetching this lecture’s transcript");
      try {
        const outcome = await deps.transcript().acquire(canonical, request.transcriptLanguage);
        if (outcome.status !== "available")
          throw new AppError(
            "This lecture has no usable transcript. Try another lecture or upload a document.",
            { code: "TRANSCRIPT_UNAVAILABLE", statusCode: 422 },
          );
        source = {
          kind: "youtube",
          name: outcome.transcript.metadata.sourceMetadata?.title ?? canonical.canonicalUrl,
          text: outcome.transcript.text,
          segments: outcome.transcript.segments,
          language:
            outcome.transcript.metadata.returnedLanguage ??
            detectSourceLanguage(outcome.transcript.text),
          warnings: [],
          captionSelection: outcome.transcript.metadata.captionSelection ?? "unknown",
        };
      } catch (error) {
        if (error instanceof TranscriptExtractionError)
          throw new AppError(
            "We couldn’t retrieve this lecture right now. Retry or upload a document.",
            { code: error.code, statusCode: 503 },
          );
        throw error;
      }
    } else {
      if (!file)
        throw new AppError("Choose a document first.", { code: "FILE_REQUIRED", statusCode: 400 });
      validateDocumentUpload(file.buffer, file.originalname, request.sourceType);
      stage("extracting", "Reading your document");
      source = await deps.extract(
        file.buffer,
        file.originalname,
        request.sourceType,
        (message) => stage("extracting", message),
        undefined,
        { signal },
      );
    }
    signal?.throwIfAborted();
    const publicSource: PublicSource =
      source.kind === "youtube"
        ? {
            kind: "youtube",
            name: source.name,
            language: source.language,
            warnings: source.warnings,
          }
        : source;
    emit({ event: "source", source: publicSource });
    emit({ event: "progress", percent: 30, message: "Your source is ready" });
    if (source.partial && !request.allowPartial)
      return workspaceResultSchema.parse({
        status: "extracted",
        source: publicSource,
        message: "Some content could not be read. Review it before using the readable portion.",
        retryable: true,
      });
    const materials: Extract<WorkspaceResult, { status: "ready" }>["materials"] = [];
    const failures: NonNullable<Extract<WorkspaceResult, { status: "ready" }>["failures"]> = [];
    for (const outputType of request.outputTypes) {
      signal?.throwIfAborted();
      emit({
        event: "stage",
        stage: "generating",
        outputType,
        outputStatus: "generating",
        message: `Preparing ${outputType.replaceAll("_", " ")}`,
      });
      try {
        const notebook = notebookSchema.parse(
          await configured.generate(source.text, outputType, {
            preferences: request.preferences,
            sourceLanguage: source.language ?? detectSourceLanguage(source.text),
            flashcardCount: request.flashcardCount,
            quizCount: request.quizCount,
            ...(source.kind === "pdf" && file
              ? {
                  pdf: {
                    data: file.buffer.toString("base64"),
                    name: safeDocumentName(file.originalname),
                  },
                }
              : {}),
          }),
        );
        const material = {
          outputType,
          notebook,
          cached: false,
          language: resolveOutputLanguage(
            request.preferences,
            source.language ?? detectSourceLanguage(source.text),
          ),
        };
        materials.push(material);
        emit({ event: "material", material });
        emit({
          event: "stage",
          stage: "rendering",
          outputType,
          outputStatus: "ready",
          message: "Ready to study",
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        const code = error instanceof NotesGenerationError ? error.code : "GENERATION_FAILED";
        logger.warn(
          { code, outputType },
          "Study generation failed; no source or provider content logged",
        );
        failures.push({
          outputType,
          code,
          message: "This material couldn’t be prepared. You can retry it.",
          retryable: true,
        });
        emit({
          event: "stage",
          stage: "generating",
          outputType,
          outputStatus: "failed",
          message: "Retry this material",
        });
      }
      emit({
        event: "progress",
        percent:
          30 + Math.floor((65 * (materials.length + failures.length)) / request.outputTypes.length),
        message: "Preparing your study set",
      });
    }
    if (!materials.length)
      throw new AppError("Your study set couldn’t be prepared right now. Please retry.", {
        code: "GENERATION_FAILED",
        statusCode: 503,
      });
    return workspaceResultSchema.parse({
      status: "ready",
      source: publicSource,
      materials,
      ...(failures.length ? { completionStatus: "partially_completed", failures } : {}),
    });
  };
}
export const processTemporaryWorkspace = createTemporaryWorkspaceService();
export const tutorInputSchema = z.strictObject({
  prompt: z.string().trim().min(3).max(4000),
  answerMode: z.enum(["auto", "quick", "detailed"]).default("auto"),
});
export function tutorAnswerMode(prompt: string, mode: "auto" | "quick" | "detailed") {
  return mode === "auto"
    ? /\b(detailed|comprehensive|essay|in[- ]depth|in detail|long answer|full notes|complete notes|step.by.step guide)\b/i.test(
        prompt,
      )
      ? "detailed"
      : "quick"
    : mode;
}
export async function askTemporaryTutor(input: unknown) {
  const { prompt, answerMode } = tutorInputSchema.parse(input);
  const mode = tutorAnswerMode(prompt, answerMode),
    provider = mode === "detailed" ? "FreeGG" : "Gemini";
  try {
    const configured =
      mode === "detailed" ? getConfiguredLongTutor() : getConfiguredTutorGemini(true);
    return {
      notebook: notebookSchema.parse(
        await configured.generate(prompt, "detailed_notes", {
          task: "tutor",
          ...(mode === "detailed" ? { answerLength: "detailed" as const } : {}),
          preferences: {
            notesStyle: "classroom",
            tone: "academic",
            format: "mixed",
            examples: "simple",
            outputLanguage: "en",
          },
          sourceLanguage: detectSourceLanguage(prompt),
        }),
      ),
      cached: false,
      provider,
      answerMode: mode,
    };
  } catch (error) {
    const failure = classifyGeminiError(error);
    logger.warn(
      { code: failure.code, provider },
      "Ask failed; no prompt or provider response logged",
    );
    const messages: Record<string, string> = {
      GEMINI_TEMPORARY: "Gemini is busy right now. Please try again shortly.",
      GEMINI_QUOTA: "Gemini's request limit was reached. Please wait before trying again.",
      GEMINI_NOT_CONFIGURED: "Ask needs GEMINI_API_KEY configured on the backend.",
      GEMINI_CREDENTIALS:
        "Gemini rejected the backend API key or its permissions. The server configuration needs attention.",
      GEMINI_MODEL_NOT_FOUND:
        "The configured Gemini Ask model is unavailable. The server configuration needs attention.",
      GEMINI_TIMEOUT: "Gemini took too long to answer. Please try again.",
      GEMINI_INVALID_OUTPUT: "Gemini returned an incomplete answer. Please try again.",
    };
    const message =
      mode === "detailed"
        ? failure.code === "GEMINI_NOT_CONFIGURED"
          ? "Detailed answers need FREEGG_API_KEY configured on the backend."
          : "FreeGG could not complete this detailed answer. Please retry, or choose Quick for a shorter Gemini answer."
        : (messages[failure.code] ?? "Gemini could not be reached right now. Please try again.");
    throw new AppError(message, { code: failure.code, statusCode: failure.statusCode });
  }
}
