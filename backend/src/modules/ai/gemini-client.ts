import { GoogleGenAI } from "@google/genai";
import { env } from "../../config/env.js";
import { NotesGenerationError, classifyGeminiError } from "./gemini-notes.js";
import { recordGenerationEvidence } from "./generation-evidence.js";
import { logger } from "../../lib/logger.js";
export function geminiClient(key: string, retryTemporaryOnce = false) {
  return new GoogleGenAI({
    apiKey: key,
    vertexai: false,
    enterprise: false,
    apiVersion: "v1beta",
    httpOptions: {
      baseUrl: "https://generativelanguage.googleapis.com/",
      apiVersion: "v1beta",
      timeout: 60000,
      retryOptions: { attempts: 1 },
      fetch: async (url, options) => {
        const paid = String(url).includes(":generateContent");
        if (paid) await recordGenerationEvidence({ kind: "dispatch" });
        let response: Response;
        try {
          response = await globalThis.fetch(
            url,
            paid ? { ...options, redirect: "error" } : options,
          );
          // Quick Ask only: retry one explicit 503 rejection, never an unknown
          // transport/timeout outcome and never a quota or long Retry-After.
          if (
            paid &&
            retryTemporaryOnce &&
            response.status === 503 &&
            !response.headers.has("retry-after")
          ) {
            const body = (await response
              .clone()
              .json()
              .catch(() => null)) as { error?: { details?: { retryDelay?: string }[] } } | null;
            const details = Array.isArray(body?.error?.details) ? body.error.details : [];
            if (!details.some((detail) => detail?.retryDelay)) {
              await recordGenerationEvidence({ kind: "response", httpStatus: 503 });
              await response.body?.cancel();
              await new Promise((resolve) => setTimeout(resolve, 400));
              await recordGenerationEvidence({ kind: "dispatch" });
              response = await globalThis.fetch(url, { ...options, redirect: "error" });
            }
          }
        } catch (error) {
          const code = (error as { cause?: { code?: string } })?.cause?.code;
          // DNS resolution/connection refusal prove no HTTP request was delivered.
          // Reset, timeout and errors after connecting do not establish that fact.
          if (paid && ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(code ?? "")) {
            await recordGenerationEvidence({
              kind: "not_sent",
              classification: "GENERATION_NOT_SENT",
            });
            throw new NotesGenerationError(
              "GENERATION_NOT_SENT",
              "Generation failed. You can try again.",
              true,
              503,
            );
          }
          throw error;
        }
        if (paid)
          await recordGenerationEvidence({
            kind: "response",
            httpStatus: response.status,
            ...([429, 500, 502, 503, 504].includes(response.status)
              ? {
                  retryAfterSeconds: classifyGeminiError({
                    status: response.status,
                    headers: response.headers,
                  }).retryAfterSeconds,
                }
              : {}),
            requestId:
              response.headers.get("x-request-id") ||
              response.headers.get("x-goog-request-id") ||
              undefined,
          });
        if (!response.ok) {
          // Keep provider diagnostics private; preserve Retry-After before SDK discards headers.
          const body = (await response
            .clone()
            .json()
            .catch(() => null)) as { error?: { details?: unknown } } | null;
          const details = Array.isArray(body?.error?.details) ? body.error.details : [];
          const retry = details.find(
            (detail) =>
              detail &&
              typeof detail === "object" &&
              detail["@type"] === "type.googleapis.com/google.rpc.RetryInfo",
          );
          const retryDelay =
            typeof retry?.retryDelay === "string" && /^\d+(?:\.\d+)?s$/.test(retry.retryDelay)
              ? Math.ceil(Number(retry.retryDelay.slice(0, -1)))
              : undefined;
          if (paid)
            logger.warn(
              { status: response.status, retryAfterSeconds: retryDelay },
              "Gemini rejected generation; no source content or provider message logged",
            );
          const keyInvalid = JSON.stringify(body?.error?.details || []).includes("API_KEY_INVALID");
          throw classifyGeminiError({
            status: keyInvalid ? 401 : response.status,
            headers: response.headers,
            retryAfterSeconds: retryDelay,
          });
        }
        return response;
      },
    },
  });
}
/** GET model metadata only: no generateContent call and no token/credit spend. */
let startupFailure: NotesGenerationError | undefined;
export function assertGeminiStartup() {
  if (startupFailure) throw startupFailure;
}
export async function validateGeminiStartup() {
  if (!env.GEMINI_API_KEY || !env.GEMINI_MODEL)
    throw new NotesGenerationError(
      "GEMINI_NOT_CONFIGURED",
      "Set GEMINI_API_KEY and GEMINI_MODEL in backend/.env; generation is disabled.",
      false,
      503,
    );
  try {
    const model = await geminiClient(env.GEMINI_API_KEY).models.get({ model: env.GEMINI_MODEL });
    if (
      model.name !== `models/${env.GEMINI_MODEL}` ||
      !model.supportedActions?.includes("generateContent")
    )
      throw new NotesGenerationError(
        "GEMINI_MODEL_UNAVAILABLE",
        "Configured Gemini model does not support generateContent.",
        false,
        503,
      );
    if (
      !model.inputTokenLimit ||
      model.inputTokenLimit < 604096 ||
      !model.outputTokenLimit ||
      model.outputTokenLimit < 8192
    )
      throw new NotesGenerationError(
        "GEMINI_MODEL_LIMIT",
        "Configured model cannot accept the source/output limits.",
        false,
        503,
      );
    startupFailure = undefined;
    return model;
  } catch (error) {
    startupFailure = classifyGeminiError(error);
    throw startupFailure;
  }
}
