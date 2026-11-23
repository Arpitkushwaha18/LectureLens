import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import type { ApiErrorBody } from "../types/api.js";
import { NotesGenerationError } from "../modules/ai/gemini-notes.js";
import { studentGenerationFailure } from "../modules/ai/generation-lifecycle.js";

/**
 * Single exit point for every failure. Controllers and services never format
 * error responses themselves — they throw, and this decides what the client sees.
 *
 * Internal details (stack traces, driver messages) are logged, never returned.
 */
export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (res.headersSent) {
    return;
  }

  const isValidationError = error instanceof ZodError;
  const isAppError = error instanceof AppError;

  const parserStatus =
    error?.type === "entity.too.large" ? 413 : error?.type === "entity.parse.failed" ? 400 : null;
  const statusCode =
    parserStatus ?? (isValidationError ? 400 : isAppError ? error.statusCode : 500);
  const code = parserStatus
    ? parserStatus === 413
      ? "PAYLOAD_TOO_LARGE"
      : "INVALID_JSON"
    : isValidationError
      ? "VALIDATION_ERROR"
      : isAppError
        ? error.code
        : "INTERNAL_ERROR";
  const message = parserStatus
    ? parserStatus === 413
      ? "The request exceeds the size limit"
      : "The request must contain valid JSON"
    : isValidationError
      ? "The request payload is invalid"
      : isAppError
        ? error instanceof NotesGenerationError
          ? studentGenerationFailure(error.code).message
          : error.message
        : "Something went wrong on our side";

  const details = isValidationError
    ? error.issues.map((issue) => ({
        path: issue.path.join(".") || "(root)",
        message: issue.message,
      }))
    : isAppError
      ? error.details
      : undefined;

  const logContext = {
    code,
    method: req.method,
    path: req.path,
    requestId: req.id,
  };

  if (statusCode >= 500) {
    // SDK/driver exceptions can embed keys, transcript data or request URLs.
    // Log only safe classifications; never serialize upstream exceptions.
    logger.error(logContext, "Request failed");
  } else {
    logger.warn(logContext, "Request rejected");
  }

  const body: ApiErrorBody = {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };

  res.status(statusCode).json(body);
};
