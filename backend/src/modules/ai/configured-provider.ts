import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { openRouterProvider } from "./openrouter-client.js";
import { freeggTransport } from "./freegg-client.js";
import { createProviderManager } from "./provider-manager.js";
import type { AiProvider } from "./provider-types.js";
let manager: ReturnType<typeof createProviderManager> | undefined;

export function getConfiguredProvider() {
  if (!manager) {
    const openrouter =
      env.OPENROUTER_ENABLED && env.OPENROUTER_API_KEY
        ? openRouterProvider({
            key: env.OPENROUTER_API_KEY,
            model: env.OPENROUTER_MODEL,
            contextTokens: env.OPENROUTER_CONTEXT_TOKENS,
            outputTokens: env.OPENROUTER_MAX_OUTPUT_TOKENS,
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
        primary:
          env.AI_PRIMARY_PROVIDER ?? (env.AI_PROVIDER === "freegg" ? "freegg" : "openrouter"),
        fallback: env.AI_FALLBACK_PROVIDER,
        providers: { openrouter, freegg },
        concurrency: env.AI_MAX_CONCURRENCY,
        maxQueue: env.AI_MAX_QUEUE,
        intervalMs: env.AI_MIN_REQUEST_INTERVAL_MS,
        timeoutMs: env.AI_TIMEOUT_MS,
        retries: env.AI_MAX_RETRIES,
        maxRetryWaitMs: env.AI_MAX_RETRY_WAIT_MS,
        maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
        openrouterOutputTokens: env.OPENROUTER_MAX_OUTPUT_TOKENS,
        freeggOutputTokens: env.FREEGG_MAX_OUTPUT_TOKENS,
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
