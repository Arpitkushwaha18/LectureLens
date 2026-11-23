/**
 * The API contract shared by every endpoint.
 *
 * Success: { data: T, meta?: ... }
 * Failure: { error: { code, message, details? } }
 *
 * Keeping one envelope means the frontend can handle every response the
 * same way, and clients can switch on a stable `code` instead of parsing prose.
 */
export type { ApiSuccess, ApiErrorBody } from "@lecturelens/contracts";

export type HealthPayload = {
  status: "ok" | "degraded";
  service: string;
  version: string;
  environment: string;
  uptimeSeconds: number;
  timestamp: string;
};
