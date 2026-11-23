/**
 * Application errors we raise deliberately. Anything else that reaches the
 * error handler is treated as an unexpected 500 and logged with a stack trace.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(
    message: string,
    options: { statusCode?: number; code?: string; details?: unknown } = {},
  ) {
    super(message);
    this.name = "AppError";
    this.statusCode = options.statusCode ?? 500;
    this.code = options.code ?? "INTERNAL_ERROR";
    this.details = options.details;
  }
}

export function notFoundError(message = "Resource not found"): AppError {
  return new AppError(message, { statusCode: 404, code: "NOT_FOUND" });
}
