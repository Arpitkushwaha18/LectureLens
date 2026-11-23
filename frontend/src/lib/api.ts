/**
 * Thin API client.
 *
 * Phase 1 talks to exactly one endpoint (the health check). Keeping the
 * base URL and response envelope handling in one place means later phases
 * add methods here instead of scattering `fetch` calls through components.
 */

export type HealthPayload = {
  status: "ok" | "degraded";
  service: string;
  version: string;
  environment: string;
  uptimeSeconds: number;
  timestamp: string;
};

const FALLBACK_BASE_URL = "http://localhost:4000/api/v1";

export const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL?.trim() || FALLBACK_BASE_URL
).replace(/\/+$/, "");

export class ApiRequestError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

export async function getHealth(signal?: AbortSignal): Promise<HealthPayload> {
  const response = await fetch(`${API_BASE_URL}/health`, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });

  if (!response.ok) {
    throw new ApiRequestError(`Health check failed (HTTP ${response.status})`, response.status);
  }

  const body = (await response.json()) as { data?: HealthPayload };

  if (!body.data) {
    throw new ApiRequestError("Health check returned an unexpected payload");
  }

  return body.data;
}
