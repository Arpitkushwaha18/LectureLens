import cors, { type CorsOptions } from "cors";
import express, { type Express } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { pinoHttp } from "pino-http";

import { env } from "./config/env.js";
import { AppError } from "./lib/errors.js";
import { logger } from "./lib/logger.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { notFoundHandler } from "./middleware/notFound.js";
import { apiRouter } from "./routes/index.js";

const corsOptions: CorsOptions = {
  credentials: true,
  origin(origin, callback) {
    // No Origin header: same-origin, curl, or a server-to-server call.
    if (!origin || env.allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(
      new AppError(`Origin ${origin} is not allowed`, {
        statusCode: 403,
        code: "CORS_FORBIDDEN",
      }),
    );
  },
};

/**
 * Builds the Express app without starting it, so tests can import it directly.
 * Middleware order matters: security headers, CORS, body parsing, logging,
 * rate limiting, routes, then the 404 and error handlers last.
 */
export function createApp(router: express.Router = apiRouter): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors(corsOptions));
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: false, limit: "2mb" }));

  app.use(
    pinoHttp({
      logger,
      autoLogging: {
        // The frontend polls health every minute; don't flood the log with it.
        ignore: (req) => req.url === "/api/v1/health",
      },
    }),
  );

  app.use(
    "/api/v1",
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
    router,
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
