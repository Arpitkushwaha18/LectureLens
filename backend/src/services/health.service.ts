import { env } from "../config/env.js";
import type { HealthPayload } from "../types/api.js";

/**
 * Health is infrastructure, not business logic, but it still goes through a
 * service so controllers stay thin and this stays testable.
 */
export function getHealthPayload(): HealthPayload {
  return {
    status: "ok",
    service: "lecturelens-api",
    version: env.SERVICE_VERSION,
    environment: env.NODE_ENV,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  };
}
