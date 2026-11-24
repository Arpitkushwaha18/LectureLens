import { NotesGenerationError } from "./gemini-notes.js";

function retryableProviderError(
  code: string,
  message: string,
  status: number,
  retryAfter: number,
  sameProviderRetrySafe: boolean,
) {
  return Object.assign(new NotesGenerationError(code, message, true, status, retryAfter), {
    sameProviderRetrySafe,
  });
}

export function providerFailure(error: unknown): NotesGenerationError {
  if (error instanceof NotesGenerationError && error.code.startsWith("AI_")) return error;
  const object = error as {
    status?: number;
    name?: string;
    code?: string;
    retryAfterSeconds?: number;
    headers?: Headers | Record<string, string>;
  };
  const header =
    object?.headers instanceof Headers
      ? object.headers.get("retry-after")
      : object?.headers?.["retry-after"];
  const seconds = header
    ? /^\d+(\.\d+)?$/.test(header)
      ? Number(header)
      : Math.ceil((Date.parse(header) - Date.now()) / 1000)
    : object?.retryAfterSeconds;
  const retryAfter = Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds!)) : 1;
  const status = object?.status ?? (error instanceof NotesGenerationError ? error.statusCode : 0);
  const code = object?.code ?? "";
  if (
    [401, 403, 404, 410].includes(status) ||
    /CREDENTIALS|MODEL_NOT_FOUND|NOT_CONFIGURED|ENDPOINT_RETIRED/.test(code)
  )
    return new NotesGenerationError(
      "AI_CONFIGURATION",
      "AI credentials, model or endpoint are not configured correctly. Contact the administrator.",
      false,
      503,
    );
  if ([400, 413, 422].includes(status) || /REQUEST_INVALID/.test(code))
    return new NotesGenerationError(
      "AI_REQUEST_INVALID",
      "The AI provider rejected this input. Check the source or configured model limits.",
      false,
      422,
    );
  if (status === 429 || code.endsWith("_QUOTA"))
    return retryableProviderError(
      "AI_QUOTA",
      "AI quota is temporarily exhausted. Please retry later.",
      429,
      retryAfter,
      true,
    );
  if (/INVALID_OUTPUT/.test(code))
    return new NotesGenerationError(
      "AI_INVALID_OUTPUT",
      "The AI returned incomplete or invalid material. No partial output was published.",
      false,
      502,
    );
  if (
    ["AbortError", "TimeoutError", "APIConnectionTimeoutError"].includes(object?.name ?? "") ||
    code.endsWith("_TIMEOUT")
  )
    return retryableProviderError(
      "AI_TIMEOUT",
      "The AI provider timed out. Please retry later.",
      503,
      retryAfter,
      false,
    );
  if (
    status >= 500 ||
    /TEMPORARY|NETWORK|NOT_SENT/.test(code) ||
    object?.name === "APIConnectionError" ||
    error instanceof TypeError
  )
    return retryableProviderError(
      "AI_TEMPORARY",
      "The AI provider is temporarily unavailable. Please retry later.",
      503,
      retryAfter,
      status >= 500 && status <= 599 && !/TIMEOUT|NETWORK|NOT_SENT/.test(code),
    );
  return new NotesGenerationError(
    "AI_FAILED",
    "AI generation failed. No unvalidated material was published.",
    false,
    502,
  );
}
