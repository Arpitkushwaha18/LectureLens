import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { validateGeminiStartup } from "./modules/ai/gemini-client.js";
try {
  if (env.AI_PRIMARY_PROVIDER || env.AI_PROVIDER !== "gemini") {
    logger.info(
      {
        provider: env.AI_PRIMARY_PROVIDER ?? env.AI_PROVIDER,
        fallback: env.AI_FALLBACK_PROVIDER,
        openrouterConfigured: Boolean(env.OPENROUTER_ENABLED && env.OPENROUTER_API_KEY),
        freeggConfigured: Boolean(env.FREEGG_ENABLED && env.FREEGG_API_KEY),
      },
      "AI routing configured; no startup generation request. Missing primary credentials produce a controlled request-time configuration error",
    );
  } else {
    const model = await validateGeminiStartup();
    logger.info({ model: model.name }, "Gemini metadata validated (no generation request)");
  }
} catch (error) {
  const failure = error as { code?: string; message?: string };
  logger.error(
    { code: failure.code, message: failure.message },
    "Gemini startup validation failed; backend will expose a configuration error, not fabricate results",
  );
  // Keep extraction, health and cached workflows available when AI is unconfigured.
}

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, environment: env.NODE_ENV, origins: env.allowedOrigins },
    "LectureLens API listening",
  );
});

/**
 * Graceful shutdown: stop accepting connections, let in-flight requests
 * finish, then exit. The timer is a hard stop so a hung connection can't
 * keep the process alive forever.
 */
function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, "Shutdown signal received");

  server.close((error) => {
    if (error) {
      logger.error({ err: error }, "Error while closing the HTTP server");
      process.exit(1);
    }

    logger.info("HTTP server closed cleanly");
    process.exit(0);
  });

  setTimeout(() => {
    logger.warn("Forced shutdown after 10s timeout");
    process.exit(1);
  }, 600_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
