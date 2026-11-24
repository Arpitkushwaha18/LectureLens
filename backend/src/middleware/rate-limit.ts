import { rateLimit } from "express-rate-limit";

/** Every throttle uses the same public API envelope. */
export function apiRateLimit(limit: number, windowMs = 60_000) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        error: { code: "RATE_LIMITED", message: "Too many requests. Please wait before retrying." },
      });
    },
  });
}
