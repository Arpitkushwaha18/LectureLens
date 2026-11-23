import { FENCED_JOB_MESSAGE } from "../../lib/job-message.js";
// Only known, definitive outcomes release a paid fence. Unknown codes fail closed.
export const DEFINITIVE_FAILURES = [
  "GEMINI_QUOTA",
  "GEMINI_TEMPORARY",
  "GEMINI_CREDENTIALS",
  "GEMINI_MODEL_NOT_FOUND",
  "GENERATION_ENDPOINT_RETIRED",
  "GEMINI_REQUEST_INVALID",
  "GEMINI_INVALID_OUTPUT",
  "GEMINI_CONFIGURATION",
  "GEMINI_MODEL_UNAVAILABLE",
  "GEMINI_MODEL_LIMIT",
  "GEMINI_NOT_CONFIGURED",
  "GENERATION_AUDIT_UNAVAILABLE",
  "GENERATION_NOT_SENT",
  "GENERATION_CANCELLED_BEFORE_SEND",
] as const;
export function definitiveFailure(code: string) {
  return (DEFINITIVE_FAILURES as readonly string[]).includes(code);
}
export function rejectionCode(status: number) {
  if ([401, 403].includes(status)) return "GEMINI_CREDENTIALS";
  if (status === 400) return "GEMINI_REQUEST_INVALID";
  if (status === 404) return "GEMINI_MODEL_NOT_FOUND";
  if (status === 410) return "GENERATION_ENDPOINT_RETIRED";
  if (status === 429) return "GEMINI_QUOTA";
  return "GEMINI_TEMPORARY";
}
export function retryDelay(attempt: number, retryAfter = 60, random: () => number = Math.random) {
  return Math.max(
    retryAfter,
    Math.min(300, Math.ceil(60 * 2 ** ((Math.max(1, attempt) - 1) % 3) * (1 + random() * 0.25))),
  );
}
export function studentGenerationFailure(code: string) {
  if (!definitiveFailure(code)) return { message: FENCED_JOB_MESSAGE, retryable: false };
  if (
    [
      "GEMINI_CREDENTIALS",
      "GEMINI_NOT_CONFIGURED",
      "GENERATION_AUDIT_UNAVAILABLE",
      "GEMINI_MODEL_NOT_FOUND",
      "GENERATION_ENDPOINT_RETIRED",
      "GEMINI_MODEL_UNAVAILABLE",
      "GEMINI_MODEL_LIMIT",
      "GEMINI_REQUEST_INVALID",
      "GEMINI_CONFIGURATION",
    ].includes(code)
  )
    return { message: "Generation failed. You can try again.", retryable: false };
  return { message: "Generation failed. You can try again.", retryable: true };
}
