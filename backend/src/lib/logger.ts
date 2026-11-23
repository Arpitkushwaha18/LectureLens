import pino from "pino";

import { env } from "../config/env.js";
import { logRedaction } from "../config/log-redaction.js";

/**
 * Structured JSON logs in production, readable logs in development.
 * `pino-pretty` is a dev-only dependency, so the transport is only
 * configured when we are not in production.
 */
export const logger = pino({
  redact: logRedaction,
  level: env.LOG_LEVEL,
  base: { service: "lecturelens-api", version: env.SERVICE_VERSION },
  ...(env.isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss",
            ignore: "pid,hostname,service,version",
          },
        },
      }),
});
