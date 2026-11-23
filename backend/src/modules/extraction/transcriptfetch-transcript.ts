import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { TranscriptFetch, APIError, APITimeoutError, VERSION } from "transcriptfetch";
import {
  canonicalVideoSourceSchema,
  transcriptTextSchema,
  MAX_TRANSCRIPT_CHARACTERS,
  MAX_TRANSCRIPT_SEGMENTS,
  transcriptLanguageSchema,
  transcriptSegmentSchema,
  transcriptProviderOutcomeSchema,
  parseYouTubeUrl,
} from "@lecturelens/contracts";
import type { TranscriptProvider } from "./transcript-provider.js";
import { detectSourceLanguage } from "./language.js";

export class TranscriptExtractionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const failureMessages: Record<string, string> = {
  TRANSCRIPT_ACCESS_DENIED:
    "Lecture checking is unavailable because the service connection needs attention. Please contact support.",
  TRANSCRIPT_CREDITS_REQUIRED:
    "Lecture checking is temporarily paused. Please contact support or use your own document.",
  TRANSCRIPT_RATE_LIMITED:
    "Too many lectures are being checked right now. Please wait a minute and check again.",
  TRANSCRIPT_TIMEOUT:
    "This lecture took too long to check. We are keeping your previous request safe; please check again later.",
  TRANSCRIPT_INVALID_OUTPUT:
    "We couldn’t read the transcript returned for this lecture. Try another lecture or paste your notes.",
  TRANSCRIPT_UPSTREAM_UNAVAILABLE:
    "The transcript service could not be reached right now. Please try again shortly.",
  TRANSCRIPT_PROXY_UNAVAILABLE:
    "Lecture checking is temporarily unavailable for all videos. Please contact support.",
  TRANSCRIPT_REQUEST_FAILED:
    "We could not retrieve this lecture’s transcript. Try again later or paste your notes.",
  TRANSCRIPT_AUDIO_DISABLED:
    "This lecture did not return a usable transcript. Audio transcription is not enabled.",
  TRANSCRIPT_JOB_FAILED:
    "Transcript checking did not complete. Try another lecture or paste your notes.",
};
export function transcriptFailureMessage(code: string): string {
  return (
    failureMessages[code] ??
    "We could not check this lecture safely. Please try another lecture or paste your notes."
  );
}
/** Kept as an alias so existing imports keep working while the UI moves to transcript wording. */
export const captionFailureMessage = transcriptFailureMessage;
/** A single cue as delivered by the SDK. It may carry extra fields (e.g. `speaker`
 * from diarization), so strip them before building the internal transcript. */
const wireSegmentSchema = z
  .object({
    start: z.number().finite().nonnegative(),
    duration: z.number().finite().nonnegative(),
    text: z.string().trim().min(1).max(100000),
  })
  .passthrough();
const wireSegmentsSchema = z.array(wireSegmentSchema).min(1).max(MAX_TRANSCRIPT_SEGMENTS);
const nullableText = z.string().max(2000).nullish();
const wireMetadataSchema = z
  .object({
    platform: z.string().nullish(),
    source: z.string().nullish(),
    language: z.string().nullish(),
    duration: z.number().finite().nonnegative().nullish(),
    title: nullableText,
    channel: nullableText,
    url: nullableText,
    thumbnail_url: nullableText,
    thumbnailUrl: nullableText,
  })
  .passthrough();
const responseSchema = z.object({
  kind: z.string(),
  videoId: z.string(),
  platform: z.string().nullish(),
  title: nullableText,
  channel: nullableText,
  url: nullableText,
  thumbnailUrl: nullableText,
  duration: z.number().finite().nonnegative().nullish(),
  language: z.string().max(35).nullish(),
  source: z.string().nullish(),
  segments: wireSegmentsSchema,
  usage: z
    .object({
      creditsSpent: z.number().finite().nonnegative(),
      balance: z.number().finite().nonnegative().nullable(),
      bytes: z.number().finite().nonnegative(),
    })
    .nullish(),
});
export interface TranscriptFetchConfig {
  apiKey: string;
  maxCharacters?: number;
  maxDurationSeconds?: number;
}
function invalid(): never {
  throw new TranscriptExtractionError(
    "TRANSCRIPT_INVALID_OUTPUT",
    "The transcript response was invalid or exceeded the configured limits. Operator review is needed before retrying.",
  );
}
/** Only store language tags the contracts accept. Novel BCP-47 tags and
 * diarization metadata must never turn a usable transcript into an error. */
function safeLanguage(value: unknown): string | undefined {
  const parsed = transcriptLanguageSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Official SDK owns requests/errors/idempotency. The injected transport bounds
 * downloads and validates wire timing before the SDK can replace invalid values with 0. */
export function createTranscriptFetchProvider(
  config: TranscriptFetchConfig,
  dependencies: {
    fetch?: typeof fetch;
    timeoutMs?: number;
    now?: () => number;
    maxRetries?: number;
  } = {},
): TranscriptProvider {
  if (!config.apiKey || config.apiKey.length > 4096 || /\s/.test(config.apiKey))
    throw new Error("Invalid backend TranscriptFetch configuration");
  const maxCharacters = config.maxCharacters ?? MAX_TRANSCRIPT_CHARACTERS;
  const maxDuration = config.maxDurationSeconds ?? 18000;
  if (
    !Number.isInteger(maxCharacters) ||
    maxCharacters < 1 ||
    maxCharacters > MAX_TRANSCRIPT_CHARACTERS ||
    !Number.isInteger(maxDuration) ||
    maxDuration < 1 ||
    maxDuration > 18000
  )
    throw new Error("Invalid transcript limits");
  return {
    async acquire(input, requestedLanguage, onRun) {
      const source = canonicalVideoSourceSchema.parse(input);
      if (requestedLanguage !== "auto" && requestedLanguage !== "en" && requestedLanguage !== "hi")
        return {
          schemaVersion: 1,
          status: "unavailable",
          reason: "language_unavailable",
          message:
            "The legacy caption selection is not supported. UrTutor detects the transcript language automatically.",
        };
      let transportError: TranscriptExtractionError | undefined;
      const timeoutMs = dependencies.timeoutMs ?? 120000;
      const boundedFetch: typeof fetch = async (url, init) => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        init?.signal?.addEventListener("abort", abort, { once: true });
        if (init?.signal?.aborted) controller.abort();
        const timer = setTimeout(abort, timeoutMs);
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          const response = await (dependencies.fetch ?? fetch)(url, {
            ...init,
            signal: controller.signal,
            redirect: "error",
          });
          const declared = response.headers.get("content-length");
          if (declared && (!/^\d+$/.test(declared) || Number(declared) > 8000000)) {
            await response.body?.cancel();
            invalid();
          }
          reader = response.body?.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          if (reader)
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              size += chunk.value.byteLength;
              if (size > 8000000) invalid();
              chunks.push(chunk.value);
            }
          const body = Buffer.concat(chunks).toString("utf8");
          let json: unknown;
          try {
            json = JSON.parse(body);
          } catch {
            if (response.ok) invalid();
          }
          const envelope = z
            .object({
              ok: z.boolean(),
              status: z.string().nullish(),
              data: z.record(z.string(), z.unknown()).nullish(),
              usage: z
                .union([
                  z.object({
                    credits_spent: z.number().finite().nonnegative(),
                    balance: z.number().finite().nonnegative().nullable(),
                    bytes: z.number().finite().nonnegative(),
                  }),
                  z.object({
                    creditsSpent: z.number().finite().nonnegative(),
                    balance: z.number().finite().nonnegative().nullable(),
                    bytes: z.number().finite().nonnegative(),
                  }),
                ])
                .nullish(),
            })
            .safeParse(json);
          if (response.ok && !envelope.success) invalid();
          if (
            response.ok &&
            envelope.success &&
            envelope.data.ok &&
            !["processing", "failed"].includes(envelope.data.status ?? "")
          ) {
            if (
              !wireSegmentsSchema.safeParse(envelope.data.data?.segments).success ||
              !wireMetadataSchema.safeParse(envelope.data.data).success
            )
              invalid();
          }
          return new Response(body, { status: response.status, headers: response.headers });
        } catch (error) {
          if (controller.signal.aborted) {
            transportError = new TranscriptExtractionError(
              "TRANSCRIPT_TIMEOUT",
              "TranscriptFetch timed out. No duplicate request was started. Operator review is needed before retrying.",
            );
          } else if (error instanceof TranscriptExtractionError) transportError = error;
          throw error;
        } finally {
          clearTimeout(timer);
          init?.signal?.removeEventListener("abort", abort);
          try {
            await reader?.cancel();
          } catch {
            /* Do not expose provider body/errors. */
          }
          reader?.releaseLock();
        }
      };
      const tf = new TranscriptFetch({
        apiKey: config.apiKey,
        timeout: timeoutMs,
        maxRetries: 0,
        fetch: boundedFetch,
      });
      let result;
      const idempotencyKey = randomUUID().replaceAll("-", "");
      await onRun?.(idempotencyKey); // Save the request identity BEFORE any paid dispatch.
      try {
        const retries = Math.max(0, Math.min(1, dependencies.maxRetries ?? 1));
        for (let attempt = 0; ; attempt++) {
          transportError = undefined;
          try {
            result = await tf.transcripts.video(source.canonicalUrl, {
              mode: "captions",
              timestamps: true,
              idempotencyKey,
            });
            break;
          } catch (error) {
            // Only definitive, documented transient rejections retry; uncertain transport outcomes stay fenced.
            const transient =
              error instanceof APIError &&
              [
                "rate_limited",
                "upstream_error",
                "timeout",
                "connection",
                "upstream_unavailable",
                "internal_error",
              ].includes(error.code ?? "");
            const seconds =
              error instanceof APIError && "retryAfter" in error ? Number(error.retryAfter) : 0;
            if (!transient || attempt >= retries || seconds > 3) throw error;
            await new Promise((resolve) =>
              setTimeout(resolve, Math.max(100, Number.isFinite(seconds) ? seconds * 1000 : 500)),
            );
          }
        }
      } catch (error) {
        if (transportError) throw transportError;
        if (error instanceof APITimeoutError)
          throw new TranscriptExtractionError(
            "TRANSCRIPT_TIMEOUT",
            "TranscriptFetch timed out. Operator review is needed before retrying.",
          );
        if (error instanceof APIError) {
          if (error.status === 401 || error.status === 403 || error.code === "unauthorized")
            throw new TranscriptExtractionError(
              "TRANSCRIPT_ACCESS_DENIED",
              "TranscriptFetch denied access. Check the backend key or paste a transcript.",
            );
          if (error.status === 402 || error.code === "insufficient_credits")
            throw new TranscriptExtractionError(
              "TRANSCRIPT_CREDITS_REQUIRED",
              "TranscriptFetch credits are required. Check backend provider billing before retrying.",
            );
          if (error.status === 429 || error.code === "rate_limited")
            throw new TranscriptExtractionError(
              "TRANSCRIPT_RATE_LIMITED",
              "TranscriptFetch is rate limited. Operator review is required before retrying.",
            );
          if (error.code === "proxy_unavailable")
            throw new TranscriptExtractionError(
              "TRANSCRIPT_PROXY_UNAVAILABLE",
              captionFailureMessage("TRANSCRIPT_PROXY_UNAVAILABLE"),
            );
          if (
            [
              "upstream_error",
              "timeout",
              "connection",
              "upstream_unavailable",
              "internal_error",
            ].includes(error.code ?? "")
          )
            throw new TranscriptExtractionError(
              "TRANSCRIPT_UPSTREAM_UNAVAILABLE",
              captionFailureMessage("TRANSCRIPT_UPSTREAM_UNAVAILABLE"),
            );
          if (
            [
              "no_captions",
              "no_transcript",
              "captions_disabled",
              "private",
              "unavailable",
              "members_only",
              "age_restricted",
              "region_blocked",
              "not_public",
              "live_stream",
              "was_live",
            ].includes(error.code ?? "")
          )
            return {
              schemaVersion: 1,
              status: "unavailable",
              reason: ["no_captions", "no_transcript", "captions_disabled", "was_live"].includes(
                error.code ?? "",
              )
                ? "captions_unavailable"
                : "access_denied",
              message: ["private", "members_only", "not_public"].includes(error.code ?? "")
                ? "This lecture is private or members-only. Please use a publicly accessible lecture with a transcript."
                : ["age_restricted", "region_blocked"].includes(error.code ?? "")
                  ? "This lecture is restricted by age or region and cannot be checked here."
                  : "This lecture has no usable transcript. Try another lecture or paste your notes.",
            };
        }
        throw new TranscriptExtractionError(
          "TRANSCRIPT_REQUEST_FAILED",
          "TranscriptFetch could not fetch a transcript. Operator review is needed before retrying.",
        );
      }
      if (result.status === "processing" || result.kind === "transcript_job")
        throw new TranscriptExtractionError(
          "TRANSCRIPT_AUDIO_DISABLED",
          "TranscriptFetch unexpectedly returned an audio job. Audio fallback and polling are disabled; operator review is required.",
        );
      if (result.status === "failed")
        throw new TranscriptExtractionError(
          "TRANSCRIPT_JOB_FAILED",
          "TranscriptFetch returned a failed job. No job was retried. Operator review is needed before retrying.",
        );
      if (result.status != null && result.status !== "completed") invalid();
      const parsed = responseSchema.safeParse(result);
      if (!parsed.success) invalid();
      const t = parsed.data;
      if (t.videoId !== source.videoId) invalid();
      if (t.url) {
        try {
          if (parseYouTubeUrl(t.url).videoId !== source.videoId) invalid();
        } catch {
          invalid();
        }
      }
      const returnedLanguage = safeLanguage(t.language);
      if (
        requestedLanguage !== "auto" &&
        (!returnedLanguage || returnedLanguage.toLowerCase().split("-")[0] !== requestedLanguage)
      )
        return {
          schemaVersion: 1,
          status: "unavailable",
          reason: "language_unavailable",
          message:
            "The transcript language is unknown or differs from your selection. Continue in the detected language or paste your notes; no translation was requested.",
        };
      // Drop SDK-only fields (e.g. diarization `speaker`) before building the
      // internal transcript so a valid response is never called unreadable.
      const segments = t.segments.map(({ start, duration, text: cue }) =>
        transcriptSegmentSchema.parse({ start, duration, text: cue }),
      );
      const text = segments.map((s) => s.text).join(" ");
      const actualLanguage = returnedLanguage ?? detectSourceLanguage(text);
      if (
        text.length > maxCharacters ||
        !transcriptTextSchema.safeParse(text).success ||
        (t.duration != null && t.duration > maxDuration) ||
        segments.some((s) => s.start + s.duration > maxDuration)
      )
        invalid();
      return transcriptProviderOutcomeSchema.parse({
        schemaVersion: 1,
        status: "available",
        transcript: {
          text,
          segments,
          metadata: {
            schemaVersion: 1,
            videoId: source.videoId,
            language: requestedLanguage === "auto" ? actualLanguage : requestedLanguage,
            ...(requestedLanguage === "auto"
              ? { captionSelection: "provider_default", translationStatus: "not_requested" }
              : { requestedLanguage }),
            ...(returnedLanguage ? { returnedLanguage } : {}),
            provenance: "licensed_provider",
            // Migration 004 pins this exact provider version. Keep it stable
            // even though the product now speaks in terms of transcripts.
            provider: { id: "transcriptfetch", version: `sdk-${VERSION}-captions-v1` },
            characterCount: text.length,
            contentHash: createHash("sha256").update(text, "utf8").digest("hex"),
            obtainedAt: new Date((dependencies.now ?? Date.now)()).toISOString(),
            sourceMetadata: {
              platform: t.platform === "youtube" ? "youtube" : null,
              title: t.title ?? null,
              channel: t.channel ?? null,
              url: t.url ?? null,
              thumbnailUrl: t.thumbnailUrl ?? null,
              duration: t.duration ?? null,
              source: t.source === "captions" ? "captions" : null,
            },
            ...(t.usage ? { usage: t.usage } : {}),
          },
        },
      });
    },
  };
}
