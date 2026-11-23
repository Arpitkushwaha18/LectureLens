import { createHash } from "node:crypto";
import { z } from "zod";
import {
  generationSelectionV2Schema,
  parseYouTubeUrl,
  legacyNotesToNotebook,
  transcriptProviderOutcomeSchema,
  workspaceResultSchema,
  transcriptTextSchema,
  type WorkspaceEvent,
  type WorkspaceResult,
  type ExtractedSource,
  type GenerationOutputTypeV2,
  type Notebook as NotebookData,
  flashcardCountSchema,
  quizCountSchema,
  studyPreferencesSchema,
  type PublicSource,
} from "@lecturelens/contracts";
import {
  extractDocument,
  validateDocumentUpload,
  safeDocumentName,
} from "../modules/extraction/documents.js";
import {
  getConfiguredStudyGemini,
  STUDY_PROMPT_VERSION,
  STUDY_SETTINGS,
} from "../modules/ai/gemini-study.js";
import { NotesGenerationError } from "../modules/ai/gemini-notes.js";
import { notesRepository } from "../repositories/notes.repository.js";
import { workspaceCache, type WorkspaceCache } from "../repositories/workspace-cache.js";
import { configuredTranscriptProvider } from "./transcript-extraction.service.js";
import { generateDetailedNotes } from "./notes.service.js";
import { AppError } from "../lib/errors.js";
import { FENCED_JOB_MESSAGE } from "../lib/job-message.js";
import { definitiveFailure, studentGenerationFailure } from "../modules/ai/generation-lifecycle.js";
import { withGenerationEvidence } from "../modules/ai/generation-evidence.js";
import { env } from "../config/env.js";
import { generationBudget } from "../modules/ai/source-preparation.js";
import type { StudyLibrary } from "../repositories/study-library.js";
import { detectSourceLanguage } from "../modules/extraction/language.js";
import {
  youtubeNotebookStore,
  type YouTubeNotebookStore,
} from "../repositories/youtube-notebooks.js";
import { videoVerifier } from "./video-verification.js";
import { studyPreferenceIdentity, resolveOutputLanguage } from "../modules/ai/study-preferences.js";

export const workspaceRequestSchema = z.strictObject({
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
type Dependencies = {
  cache: () => WorkspaceCache;
  extract: typeof extractDocument;
  gemini: typeof getConfiguredStudyGemini;
  resources: typeof notesRepository;
  provider: typeof configuredTranscriptProvider;
  youtubeNotes: typeof generateDetailedNotes;
  notesStore?: YouTubeNotebookStore;
  verify?: typeof videoVerifier.assert;
};
export function createWorkspaceService(overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = {
    cache: workspaceCache,
    extract: extractDocument,
    gemini: getConfiguredStudyGemini,
    resources: notesRepository,
    provider: configuredTranscriptProvider,
    youtubeNotes: generateDetailedNotes,
    notesStore:
      Object.keys(overrides).length || env.WORKSPACE_YOUTUBE_STORE === "local"
        ? undefined
        : youtubeNotebookStore,
    verify: Object.keys(overrides).length ? undefined : videoVerifier.assert,
    ...overrides,
  };
  return async (
    input: unknown,
    file: { buffer: Buffer; originalname: string } | undefined,
    emit: (event: WorkspaceEvent) => void,
    signal?: AbortSignal,
    context?: { ownerId: string; library: StudyLibrary },
  ): Promise<WorkspaceResult> => {
    const parsedRequest = workspaceRequestSchema.parse(input);
    const request = {
      ...parsedRequest,
      preferences: { ...parsedRequest.preferences, outputLanguage: "en" as const },
    };
    const promptIdentity = studyPreferenceIdentity(request.preferences);
    let percent = 0;
    const progress = (next: number, message: string) => {
      percent = Math.max(percent, next);
      emit({ event: "progress", percent, message });
    };
    progress(0, "Starting your study set");
    const stage = (
      stage: "validating" | "extracting" | "preparing" | "generating" | "rendering",
      message: string,
    ) => emit({ event: "stage", stage, message });
    stage("validating", "Validating source and selected study outputs");
    if (request.sourceType === "youtube" && file)
      throw new AppError("A YouTube source accepts a URL, not an uploaded file.", {
        code: "SOURCE_INVALID",
        statusCode: 400,
      });
    const canonical = request.sourceType === "youtube" ? parseYouTubeUrl(request.url) : null;
    if (canonical) deps.verify?.(request.verificationToken, canonical.videoId);
    progress(10, "Your source is valid");
    if (!canonical && !file)
      throw new AppError("Choose a file before continuing.", {
        code: "FILE_REQUIRED",
        statusCode: 400,
      });
    stage("extracting", canonical ? "Fetching the lecture transcript" : "Reading your document");
    const cache = deps.cache();
    for (const outputType of request.outputTypes)
      emit({
        event: "stage",
        stage: "extracting",
        outputType,
        outputStatus: "queued",
        message: `${outputType.replaceAll("_", " ")} is queued while the source is read`,
      });
    const localYouTube =
      Boolean(deps.notesStore) ||
      (env.WORKSPACE_YOUTUBE_STORE === "local" && !overrides.youtubeNotes);
    let hostedTranscript: { sourceId: string; transcriptId: string } | undefined;
    const fallback = async (_message: string): Promise<WorkspaceResult> => {
      throw new AppError(
        "This lecture has no usable transcript. Try another lecture or paste your notes.",
        { code: "TRANSCRIPT_UNAVAILABLE", statusCode: 422 },
      );
    };
    let source: ExtractedSource;
    if (canonical) {
      const sourceId = await deps.resources.ensureSource(canonical.videoId);
      const findTranscript = () =>
        request.transcriptLanguage === "auto" && deps.resources.findBestTranscript
          ? deps.resources.findBestTranscript(sourceId)
          : deps.resources.findTranscript(
              sourceId,
              request.transcriptLanguage === "auto" ? "en" : request.transcriptLanguage,
            );
      let transcript = await findTranscript();
      if (!transcript) {
        if (request.checkOnly)
          return {
            status: "pending",
            message: FENCED_JOB_MESSAGE,
            retrySafe: false,
            retryAfterSeconds: 3,
          };
        const unavailable = cache.unavailableCaptions(
          canonical.videoId,
          request.transcriptLanguage,
        );
        if (unavailable) return fallback(unavailable);
        // Check local key/model settings before any paid caption extraction.
        // Missing caption-provider configuration remains a distinct, honest error.
        if (deps.provider === configuredTranscriptProvider && !process.env.TRANSCRIPTFETCH_API_KEY)
          throw new AppError(
            "Set TRANSCRIPTFETCH_API_KEY in backend/.env and restart the backend. No captions request was made.",
            { code: "TRANSCRIPT_NOT_CONFIGURED", statusCode: 503 },
          );
        deps.gemini();
        let outcome;
        try {
          outcome = transcriptProviderOutcomeSchema.parse(
            await deps.provider.acquire(canonical, request.transcriptLanguage),
          );
        } catch (error) {
          if (error instanceof AppError && error.code === "EXTRACTION_PENDING")
            return {
              status: "pending",
              message:
                "Shared caption extraction is already running. Check again shortly; no duplicate request was started.",
              retryAfterSeconds: 3,
            };
          throw error;
        }
        if (outcome.status !== "available") {
          if (
            outcome.status === "unavailable" &&
            ["captions_unavailable", "language_unavailable", "access_denied"].includes(
              outcome.reason,
            )
          ) {
            cache.rememberUnavailableCaptions(
              canonical.videoId,
              request.transcriptLanguage,
              outcome.message,
            );
            return fallback(outcome.message);
          }
          throw new AppError(outcome.message, { code: "TRANSCRIPT_UNAVAILABLE", statusCode: 503 });
        }
        transcript = await findTranscript();
        if (!transcript)
          throw new AppError("Caption persistence was not confirmed. No notes were generated.", {
            code: "TRANSCRIPT_PERSISTENCE",
            statusCode: 503,
          });
      }
      const duration = (transcript.metadata?.segments ?? []).reduce(
        (end, cue) => Math.max(end, cue.start + cue.duration),
        transcript.metadata?.sourceMetadata?.duration ?? 0,
      );
      if (duration > 18000)
        throw new AppError("Please choose a lecture of five hours or less.", {
          code: "VIDEO_DURATION_LIMIT",
          statusCode: 422,
        });
      source = {
        kind: "youtube",
        name: canonical.canonicalUrl,
        text: transcriptTextSchema.parse(transcript.text_content),
        warnings: [],
        language:
          transcript.metadata?.returnedLanguage ?? detectSourceLanguage(transcript.text_content),
        captionSelection: transcript.metadata?.captionSelection ?? "unknown",
        ...(transcript.metadata?.segments ? { segments: transcript.metadata.segments } : {}),
      };
      hostedTranscript = { sourceId, transcriptId: transcript.id };
    } else {
      validateDocumentUpload(
        file!.buffer,
        file!.originalname,
        request.sourceType as "pdf" | "spreadsheet",
      );
      const identity = `${context?.ownerId ?? "test"}:${request.sourceType}:parser-ocr-v3:${createHash("sha256").update(file!.buffer).digest("hex")}`;
      const existing = cache.extraction(identity);
      source =
        existing && (!existing.partial || request.allowPartial)
          ? { ...existing, name: safeDocumentName(file!.originalname) }
          : await deps.extract(
              file!.buffer,
              file!.originalname,
              request.sourceType as "pdf" | "spreadsheet",
              (message) => stage("extracting", message),
              undefined,
              { signal, previous: existing ?? undefined },
            );
      cache.saveExtraction(identity, source);
    }
    progress(30, "Your source is ready");
    stage("preparing", "Preparing your study material");
    source = { ...source, language: source.language ?? detectSourceLanguage(source.text) };
    const publicSource: PublicSource =
      source.kind === "youtube"
        ? { kind: "youtube", name: source.name, language: source.language, warnings: [] }
        : (source as PublicSource);
    const outputLanguage = resolveOutputLanguage(request.preferences, source.language);
    emit({ event: "source", source: publicSource });
    if (source.partial && !request.allowPartial)
      return workspaceResultSchema.parse({
        status: "extracted",
        source: publicSource,
        message:
          "Some pages or images could not be read. Review the failures, retry them, or explicitly use only the successfully extracted content.",
        retryable: source.retryable ?? false,
      });
    if (
      source.partial &&
      !source.pages?.some((page) => page.text.trim()) &&
      !source.sheets?.some((sheet) =>
        [
          ...sheet.headers,
          ...sheet.rows.flat(),
          ...(sheet.images ?? []).map((image) => image.text),
        ].some((text) => text.trim()),
      )
    )
      return workspaceResultSchema.parse({
        status: "extracted",
        source: publicSource,
        message:
          "No reliably readable content is available. Improve the scan before generating notes.",
        retryable: true,
      });
    const materials: Extract<WorkspaceResult, { status: "ready" }>["materials"] = [];
    progress(40, "Checking your selected materials");
    const failures: NotesGenerationError[] = [];
    const complete = async (
      outputType: GenerationOutputTypeV2,
      notebook: NotebookData,
      cached: boolean,
      _key: string,
    ) => {
      const material = {
        outputType,
        cached,
        notebook,
        language: outputLanguage,
      };
      materials.push(material);
      emit({ event: "material", material });
      emit({
        event: "stage",
        stage: "generating",
        message: cached ? "Reused a saved resource" : "Your resource is saved and ready",
        outputType,
        outputStatus: "ready",
      });
      progress(
        Math.floor(40 + (50 * materials.length) / request.outputTypes.length),
        cached ? "Reused your saved notes" : "Your material is ready",
      );
    };
    for (const outputType of request.outputTypes) {
      signal?.throwIfAborted();
      if (
        canonical &&
        hostedTranscript &&
        deps.notesStore &&
        ["detailed_notes", "short_notes"].includes(outputType)
      ) {
        const configured = deps.gemini(true);
        stage("preparing", "Checking saved notes for this lecture");
        const claim = await deps.notesStore.claim(
          canonical.videoId,
          hostedTranscript.transcriptId,
          outputType,
          configured.model,
          promptIdentity,
          true,
        );
        if (claim.status === "ready" && claim.notebook) {
          await complete(outputType, claim.notebook, true, claim.identity);
          continue;
        }
        if (request.checkOnly || claim.status === "pending" || claim.status === "cooldown") {
          if (claim.status === "missing")
            throw new NotesGenerationError(
              "GENERATION_NOT_SENT",
              "Generation failed. You can try again.",
              true,
              503,
              1,
            );
          return {
            status: "pending",
            message: FENCED_JOB_MESSAGE,
            retrySafe: claim.status === "cooldown",
            retryAfterSeconds: 60,
          };
        }
        // Keep historical SQLite and hosted paid-operation fences authoritative.
        const hash = createHash("sha256").update(source.text).digest("hex");
        const op = createHash("sha256")
          .update(
            JSON.stringify({
              source: source.kind,
              contentHash: hash,
              outputType,
              language: "en",
              sourceId: canonical.videoId,
            }),
          )
          .digest("hex");
        const legacy = createHash("sha256")
          .update(JSON.stringify({ source: source.kind, text: source.text, outputType }))
          .digest("hex");
        if (!cache.checkState(claim.identity, op, legacy).safe)
          return {
            status: "pending",
            message: FENCED_JOB_MESSAGE,
            retrySafe: false,
            retryAfterSeconds: 3,
          };
        deps.gemini();
        const reserved = await deps.notesStore.claim(
          canonical.videoId,
          hostedTranscript.transcriptId,
          outputType,
          configured.model,
          promptIdentity,
          false,
        );
        if (reserved.status === "ready" && reserved.notebook) {
          await complete(outputType, reserved.notebook, true, reserved.identity);
          continue;
        }
        if (reserved.status !== "reserved" || !reserved.token)
          return {
            status: "pending",
            message: FENCED_JOB_MESSAGE,
            retrySafe: false,
            retryAfterSeconds: 3,
          };
        const token = reserved.token;
        emit({
          event: "stage",
          stage: "generating",
          outputType,
          outputStatus: "generating",
          message: `Creating your ${outputType.replaceAll("_", " ")}`,
        });
        let notebook: NotebookData;
        try {
          notebook = await withGenerationEvidence(
            (event) => deps.notesStore!.evidence(reserved.identity, token, event),
            () =>
              configured.generate(source.text, outputType, {
                preferences: request.preferences,
                sourceLanguage: source.language,
              }),
          );
          await deps.notesStore.evidence(
            reserved.identity,
            token,
            { kind: "response", httpStatus: 200 },
            notebook,
          );
        } catch (error) {
          if (error instanceof AppError && !(error instanceof NotesGenerationError)) throw error;
          const failure =
            error instanceof NotesGenerationError
              ? error
              : new NotesGenerationError("GEMINI_UNCERTAIN", FENCED_JOB_MESSAGE);
          await deps.notesStore.fail(
            reserved.identity,
            token,
            failure.code,
            definitiveFailure(failure.code),
          );
          emit({
            event: "stage",
            stage: "generating",
            outputType,
            outputStatus: definitiveFailure(failure.code) ? "failed" : "blocked",
            message: studentGenerationFailure(failure.code).message,
          });
          failures.push(failure);
          continue;
        }
        emit({
          event: "stage",
          stage: "generating",
          outputType,
          outputStatus: "saving",
          message: "Saving your notes",
        });
        await deps.notesStore.finish(reserved.identity, token, notebook);
        await complete(outputType, notebook, false, reserved.identity);
        continue;
      }
      if (canonical && outputType === "detailed_notes" && !localYouTube) {
        // The hosted service also checks cached/terminal state without dispatching.
        const outcome = await deps.youtubeNotes(
          {
            url: canonical.canonicalUrl,
            transcriptLanguage:
              request.transcriptLanguage === "auto" ? source.language : request.transcriptLanguage,
            ...(request.checkOnly ? { checkOnly: true } : {}),
          },
          (current) => {
            if (current !== "extracting")
              stage(
                current,
                current === "generating"
                  ? "Generating detailed notes from the actual captions"
                  : "Checking shared notes cache",
              );
          },
        );
        if (outcome.status === "processing" || outcome.status === "extracting")
          return {
            status: "pending",
            message: FENCED_JOB_MESSAGE,
            retrySafe: false,
            retryAfterSeconds: outcome.retryAfterSeconds,
          };
        if (outcome.status !== "ready")
          throw new AppError(
            "Shared transcript changed while preparing notes. Check backend state before retrying.",
            { code: "SOURCE_CHANGED", statusCode: 503 },
          );
        await complete(
          outputType,
          legacyNotesToNotebook(outcome.notes),
          outcome.cached,
          createHash("sha256")
            .update(
              JSON.stringify({
                source: canonical.videoId,
                text: source.text,
                outputType,
                model: deps.gemini(true).model,
                prompt: STUDY_PROMPT_VERSION,
                language: source.language,
                schema: 2,
              }),
            )
            .digest("hex"),
        );
        continue;
      }
      const configured = deps.gemini(true);
      const contentHash = canonical
        ? createHash("sha256").update(source.text).digest("hex")
        : createHash("sha256").update(file!.buffer).digest("hex");
      const key = createHash("sha256")
        .update(
          JSON.stringify({
            source: source.kind,
            contentHash,
            ...(canonical ? { sourceId: canonical.videoId } : {}),
            text: source.text,
            outputType,
            model: configured.model,
            prompt: promptIdentity,
            schema: 2,
            language: request.transcriptLanguage,
            settings: STUDY_SETTINGS,
            ...(context ? { ownerId: context.ownerId } : {}),
            ...(outputType === "flashcards"
              ? { count: request.flashcardCount }
              : outputType === "mcq_quiz"
                ? { count: request.quizCount }
                : {}),
            thinkingBudget: configured.model.startsWith("gemini-2.5-flash") ? 0 : null,
          }),
        )
        .digest("hex");
      const legacyOperation = createHash("sha256")
        .update(JSON.stringify({ source: source.kind, text: source.text, outputType }))
        .digest("hex");
      const operation = createHash("sha256")
        .update(
          JSON.stringify({
            source: source.kind,
            contentHash,
            outputType,
            language: "en",
            ...(canonical ? { sourceId: canonical.videoId } : {}),
          }),
        )
        .digest("hex");
      // Historical paid fences remain checked, but incompatible legacy outputs are not reused.
      const saved = cache.material(key);
      if (saved) {
        await complete(outputType, saved, true, key);
        continue;
      }
      if (hostedTranscript && localYouTube)
        await deps.resources.guardLocalGeneration?.(
          hostedTranscript.sourceId,
          hostedTranscript.transcriptId,
          outputType,
        );
      if (request.checkOnly) {
        const state = cache.checkState(key, operation, legacyOperation);
        if (!state.safe)
          return {
            status: "pending",
            message: FENCED_JOB_MESSAGE,
            retrySafe: false,
            retryAfterSeconds: 3,
          };
        throw new NotesGenerationError(
          state.code,
          "Generation failed. You can try again.",
          state.delay > 0 || state.code === "GENERATION_NOT_SENT",
          503,
          Math.max(1, state.delay),
        );
      }
      deps.gemini();
      const token = cache.claim(key, operation, {
        model: configured.model,
        sourceId: `${source.kind}:${contentHash}`,
        legacyOperation,
        leaseMs: configured.model.startsWith("freegg:")
          ? 360000
          : generationBudget(source.text.length, true).timeoutMs + 60000,
      });
      if (!token) {
        const completed = cache.material(key);
        if (completed) {
          await complete(outputType, completed, true, key);
          continue;
        }
        return {
          status: "pending",
          retrySafe: cache.retrySafe(key),
          message: cache.retrySafe(key)
            ? "A safe retry is waiting for its cooldown. No new request was started."
            : FENCED_JOB_MESSAGE,
          retryAfterSeconds: cache.retryAfter(key),
        };
      }
      stage(
        "generating",
        `Generating ${outputType.replaceAll("_", " ")} from the extracted source`,
      );
      emit({
        event: "stage",
        stage: "generating",
        message: {
          detailed_notes: "Creating your detailed notes",
          short_notes: "Preparing your revision sheet",
          flashcards: "Designing your flashcards",
          mcq_quiz: "Building your quiz",
          mindmap: "Connecting your mind map",
          sample_question_paper: "Writing your practice paper",
        }[outputType],
        outputType,
        outputStatus: "generating",
      });
      let notebook;
      try {
        if (signal?.aborted) {
          cache.cancelBeforeSend(key, token);
          throw new NotesGenerationError(
            "GENERATION_CANCELLED_BEFORE_SEND",
            "Generation failed. You can try again.",
          );
        }
        notebook = await withGenerationEvidence(
          (event) => cache.evidence(key, token, event),
          () =>
            configured.generate(source.text, outputType, {
              flashcardCount: request.flashcardCount,
              quizCount: request.quizCount,
              preferences: request.preferences,
              sourceLanguage: source.language,
            }),
        );
        cache.checkpoint(key, token, notebook);
      } catch (error) {
        const failure =
          error instanceof NotesGenerationError
            ? error
            : new NotesGenerationError(
                "GEMINI_UNCERTAIN",
                "Generation did not complete reliably. Operator review is needed before retrying.",
              );
        cache.fail(key, token, failure.code, failure.retryable, failure.retryAfterSeconds);
        emit({
          event: "stage",
          stage: "generating",
          message: studentGenerationFailure(failure.code).message,
          outputType,
          outputStatus: definitiveFailure(failure.code) ? "failed" : "blocked",
        });
        failures.push(
          failure.retryable
            ? new NotesGenerationError(
                failure.code,
                failure.message,
                true,
                failure.statusCode,
                cache.retryAfter(key),
              )
            : failure,
        );
        continue;
      }
      // Persistence failures after generation leave the paid claim fenced.
      cache.finish(key, token, notebook);
      await complete(outputType, notebook, false, key);
    }
    if (failures.length) throw failures.find((f) => !definitiveFailure(f.code)) ?? failures[0];
    stage("rendering", "Validated study material is ready for notebook rendering");
    progress(95, "Opening your study set");
    progress(100, "Your study set is ready");
    return workspaceResultSchema.parse({ status: "ready", source: publicSource, materials });
  };
}
export const processWorkspace = createWorkspaceService();
