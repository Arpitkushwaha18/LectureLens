import type { Request, Response } from "express";

import { getHealthPayload } from "../services/health.service.js";
import type { ApiSuccess, HealthPayload } from "../types/api.js";

/**
 * GET /api/v1/health
 * Used by the frontend status indicator and by deployment platforms.
 */
export function getHealth(_req: Request, res: Response<ApiSuccess<HealthPayload>>): void {
  res.status(200).json({ data: getHealthPayload() });
}
