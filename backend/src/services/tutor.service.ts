import { createHash } from "node:crypto";
import { z } from "zod";
import { notebookSchema } from "@lecturelens/contracts";
import { getConfiguredStudyGemini } from "../modules/ai/gemini-study.js";
import { workspaceCache } from "../repositories/workspace-cache.js";
import { withGenerationEvidence } from "../modules/ai/generation-evidence.js";
import { NotesGenerationError } from "../modules/ai/gemini-notes.js";
import { studentGenerationFailure } from "../modules/ai/generation-lifecycle.js";
import { AppError } from "../lib/errors.js";
import { detectSourceLanguage } from "../modules/extraction/language.js";
export const tutorRequestSchema = z.strictObject({ prompt: z.string().trim().min(3).max(4000) });
export function createTutorService(
  deps = { cache: workspaceCache, gemini: getConfiguredStudyGemini },
) {
  return async (input: unknown, ownerId: string) => {
    const { prompt } = tutorRequestSchema.parse(input);
    const configured = deps.gemini(true),
      cache = deps.cache();
    const legacyKey = createHash("sha256")
      .update(
        JSON.stringify({
          ownerId,
          prompt,
          model: configured.model,
          version: "urtutor-question-v1",
          schema: 2,
        }),
      )
      .digest("hex");
    const previousOperation =
      configured.model.startsWith("freegg:") && process.env.GEMINI_MODEL
        ? createHash("sha256")
            .update(
              JSON.stringify({
                ownerId,
                prompt,
                model: process.env.GEMINI_MODEL,
                version: "urtutor-question-v1",
                schema: 2,
              }),
            )
            .digest("hex")
        : legacyKey;
    const key = createHash("sha256").update(`${legacyKey}:english-v2`).digest("hex");
    const saved = cache.material(key);
    if (saved) return { notebook: saved, cached: true };
    if (!cache.checkState(key, legacyKey, previousOperation).safe)
      throw new AppError("Your answer is not ready yet.", {
        code: "TUTOR_PENDING",
        statusCode: 409,
      });
    deps.gemini();
    const token = cache.claim(key, legacyKey, {
      model: configured.model,
      sourceId: `private-question:${ownerId}`,
      legacyOperation: previousOperation,
      leaseMs: configured.model.startsWith("freegg:") ? 360000 : 120000,
    });
    if (!token)
      throw new AppError(
        "Your previous answer has not finished safely yet. You can ask a different question without waiting here.",
        { code: "TUTOR_PENDING", statusCode: 409 },
      );
    try {
      const notebook = notebookSchema.parse(
        await withGenerationEvidence(
          (e) => cache.evidence(key, token, e),
          () =>
            configured.generate(prompt, "detailed_notes", {
              task: "tutor",
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
      );
      cache.checkpoint(key, token, notebook);
      cache.finish(key, token, notebook);
      return { notebook, cached: false };
    } catch (error) {
      const failure =
        error instanceof NotesGenerationError
          ? error
          : new NotesGenerationError(
              "GEMINI_UNCERTAIN",
              "Your answer could not be completed safely.",
            );
      cache.fail(key, token, failure.code, failure.retryable, failure.retryAfterSeconds);
      const safe = studentGenerationFailure(failure.code);
      throw new AppError(
        safe.retryable
          ? "This answer could not be completed. You can try again later or ask another question."
          : "This answer did not finish safely. You can ask another question; no duplicate request was started.",
        { code: "TUTOR_FAILED", statusCode: 503 },
      );
    }
  };
}
export const askTutor = createTutorService();
