import { setTimeout as delay } from "node:timers/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import type { GenerateContentParameters, GenerateContentResponse } from "@google/genai";
import type { AiProvider, ProviderId } from "./provider-types.js";
import { NotesGenerationError } from "./gemini-notes.js";
import { providerFailure } from "./provider-errors.js";

const selection = new AsyncLocalStorage<{ provider?: ProviderId }>();
export async function withProviderSelection<T>(work: () => Promise<T>) {
  const context: { provider?: ProviderId } = {};
  const value = await selection.run(context, work);
  return { value, provider: context.provider };
}

type Options = {
  primary: ProviderId;
  fallback: ProviderId | "none";
  providers: Partial<Record<ProviderId, AiProvider>>;
  concurrency: number;
  maxQueue: number;
  intervalMs: number;
  timeoutMs: number;
  retries: number;
  maxRetryWaitMs: number;
  maxOutputTokens: number;
  temperature: number;
};
type Metrics = {
  requests: number;
  successes: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  tokensReported: number;
};
type Dependencies = {
  now?: () => number;
  random?: () => number;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: (event: Record<string, string | number>) => void;
};

export function createProviderManager(options: Options, deps: Dependencies = {}) {
  const now = deps.now ?? Date.now,
    random = deps.random ?? Math.random;
  const wait =
    deps.wait ??
    (async (ms, signal) => {
      if (ms > 0) await delay(ms, undefined, { signal });
    });
  const health = new Map<ProviderId, { until: number; next: number }>();
  const metrics: Record<ProviderId, Metrics> = Object.fromEntries(
    ["groq", "freegg"].map((id) => [
      id,
      {
        requests: 0,
        successes: 0,
        failures: 0,
        inputTokens: 0,
        outputTokens: 0,
        tokensReported: 0,
      },
    ]),
  ) as Record<ProviderId, Metrics>;
  let active = 0;
  const queue: {
    resolve: () => void;
    reject: (reason: unknown) => void;
    signal?: AbortSignal;
    abort: () => void;
  }[] = [];
  async function acquire(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (active < options.concurrency) {
      active++;
      return;
    }
    if (queue.length >= options.maxQueue)
      throw new NotesGenerationError(
        "AI_BUSY",
        "AI generation is busy. Please retry shortly.",
        true,
        503,
        10,
      );
    await new Promise<void>((resolve, reject) => {
      const item = {
        resolve,
        reject,
        signal,
        abort: () => {
          const index = queue.indexOf(item);
          if (index >= 0) queue.splice(index, 1);
          reject(signal?.reason);
        },
      };
      queue.push(item);
      signal?.addEventListener("abort", item.abort, { once: true });
    });
  }
  function release() {
    const item = queue.shift();
    if (item) {
      item.signal?.removeEventListener("abort", item.abort);
      item.resolve();
    } else active--;
  }
  return {
    model: `${options.primary}:${options.providers[options.primary]?.model ?? "unconfigured"}`,
    snapshot: () => ({ active, queued: queue.length, providers: structuredClone(metrics) }),
    async generateContent(input: GenerateContentParameters): Promise<GenerateContentResponse> {
      const signal = input.config?.abortSignal;
      const pdf = (input.contents as { parts?: { inlineData?: unknown }[] }[]).some((item) =>
        item.parts?.some((part) => part.inlineData),
      );
      // Missing/disabled primary is a configuration error, never an implicit credentials bypass.
      if (!options.providers[options.primary])
        throw new NotesGenerationError(
          "AI_CONFIGURATION",
          "The primary AI provider is disabled or missing its backend key. Configure it or explicitly select another primary.",
          false,
          503,
        );
      const ids = [
        options.primary,
        ...(options.fallback !== "none" && options.fallback !== options.primary
          ? [options.fallback]
          : []),
      ];
      const providers = ids
        .map((id) => options.providers[id])
        .filter((p): p is AiProvider => Boolean(p && (!pdf || p.supportsPdf)));
      if (!providers.length)
        throw new NotesGenerationError(
          "AI_CONFIGURATION",
          "Original PDF generation requires an enabled, configured FreeGG provider. No local OCR or text-only substitute is used.",
          false,
          503,
        );
      await acquire(signal);
      try {
        let last: NotesGenerationError | undefined;
        for (const provider of providers) {
          const state = health.get(provider.id) ?? { until: 0, next: 0 };
          health.set(provider.id, state);
          if (state.until > now()) {
            last = new NotesGenerationError(
              "AI_QUOTA",
              "AI quota is temporarily exhausted. Please retry later.",
              true,
              429,
              Math.ceil((state.until - now()) / 1000),
            );
            continue;
          }
          for (let attempt = 0; attempt <= options.retries; attempt++) {
            signal?.throwIfAborted();
            const reserved = Math.max(now(), state.next);
            state.next = reserved + options.intervalMs;
            await wait(Math.max(0, reserved - now()), signal);
            signal?.throwIfAborted();
            // Another concurrent attempt may have received Retry-After while we waited.
            if (state.until > now()) {
              last = new NotesGenerationError(
                "AI_QUOTA",
                "AI quota is temporarily exhausted. Please retry later.",
                true,
                429,
                Math.ceil((state.until - now()) / 1000),
              );
              break;
            }
            // Each provider receives its own bounded timeout; client disconnect cancels the entire chain.
            const attemptSignal = signal
              ? AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)])
              : AbortSignal.timeout(options.timeoutMs);
            metrics[provider.id].requests++;
            try {
              const response = await provider.generateContent({
                ...input,
                model: provider.model,
                config: {
                  ...input.config,
                  abortSignal: attemptSignal,
                  temperature: options.temperature,
                  maxOutputTokens: Math.min(
                    input.config?.maxOutputTokens ?? options.maxOutputTokens,
                    options.maxOutputTokens,
                  ),
                },
              });
              attemptSignal.throwIfAborted();
              if (!response.text?.trim() || response.candidates?.[0]?.finishReason !== "STOP")
                throw new NotesGenerationError(
                  "AI_INVALID_OUTPUT",
                  "AI returned incomplete material.",
                  false,
                  502,
                );
              const usage = response.usageMetadata;
              const tokenCount = (value: unknown) =>
                typeof value === "number" &&
                Number.isSafeInteger(value) &&
                value >= 0 &&
                value <= 1_000_000_000
                  ? value
                  : 0;
              const context = selection.getStore();
              if (context) context.provider = provider.id;
              const m = metrics[provider.id];
              m.successes++;
              if (usage) {
                m.tokensReported++;
                m.inputTokens += tokenCount(usage.promptTokenCount);
                m.outputTokens += tokenCount(usage.candidatesTokenCount);
              }
              deps.log?.({
                provider: provider.id,
                model: provider.model,
                outcome: "success",
                attempt: attempt + 1,
                inputTokens: tokenCount(usage?.promptTokenCount),
                outputTokens: tokenCount(usage?.candidatesTokenCount),
              });
              return response;
            } catch (error) {
              if (signal?.aborted) throw signal.reason;
              last = providerFailure(error);
              metrics[provider.id].failures++;
              deps.log?.({
                provider: provider.id,
                outcome: "failure",
                code: last.code,
                attempt: attempt + 1,
              });
              if (!last.retryable) throw last;
              const backoff = Math.max(
                last.retryAfterSeconds * 1000,
                Math.ceil(500 * 2 ** attempt * (1 + random())),
              );
              state.until = now() + backoff;
              // Prefer another provider immediately. Retry only when this is the final candidate,
              // and only definite HTTP rejections, not ambiguous timeout/network outcomes.
              if (
                provider !== providers.at(-1) ||
                !(last as NotesGenerationError & { sameProviderRetrySafe?: boolean })
                  .sameProviderRetrySafe ||
                attempt >= options.retries ||
                backoff > options.maxRetryWaitMs
              )
                break;
              await wait(backoff, signal);
              state.until = 0;
            }
          }
        }
        throw new NotesGenerationError(
          "AI_UNAVAILABLE",
          "Both configured AI providers are unavailable or quota-limited. Please retry later.",
          true,
          503,
          last?.retryAfterSeconds ?? 60,
        );
      } finally {
        release();
      }
    },
  };
}
