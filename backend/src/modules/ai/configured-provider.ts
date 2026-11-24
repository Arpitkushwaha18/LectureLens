import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { groqProvider } from "./groq-client.js";
import { freeggTransport } from "./freegg-client.js";
import { createProviderManager } from "./provider-manager.js";
import type { AiProvider } from "./provider-types.js";
let manager: ReturnType<typeof createProviderManager> | undefined;

export function getConfiguredProvider() {
  if (!manager) {
    const groq =
      env.GROQ_ENABLED && env.GROQ_API_KEY
        ? groqProvider({
            key: env.GROQ_API_KEY,
            model: env.GROQ_MODEL,
            contextTokens: env.GROQ_CONTEXT_TOKENS,
            outputTokens: env.GROQ_MAX_OUTPUT_TOKENS,
            timeoutMs: env.AI_TIMEOUT_MS,
          })
        : undefined;
    const freegg: AiProvider | undefined =
      env.FREEGG_ENABLED && env.FREEGG_API_KEY
        ? {
            id: "freegg",
            model: env.FREEGG_MODEL,
            supportsPdf: true,
            ...freeggTransport(env.FREEGG_API_KEY, globalThis.fetch, env.FREEGG_BASE_URL),
          }
        : undefined;
    manager = createProviderManager(
      {
        primary: env.AI_PRIMARY_PROVIDER ?? (env.AI_PROVIDER === "freegg" ? "freegg" : "groq"),
        fallback: env.AI_FALLBACK_PROVIDER,
        providers: { groq, freegg },
        concurrency: env.AI_MAX_CONCURRENCY,
        maxQueue: env.AI_MAX_QUEUE,
        intervalMs: env.AI_MIN_REQUEST_INTERVAL_MS,
        timeoutMs: env.AI_TIMEOUT_MS,
        retries: env.AI_MAX_RETRIES,
        maxRetryWaitMs: env.AI_MAX_RETRY_WAIT_MS,
        maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
        temperature: env.AI_TEMPERATURE,
      },
      {
        log: (event) =>
          logger.info(event, "Anonymous AI provider metrics; no student content or identifiers"),
      },
    );
  }
  return manager;
}
