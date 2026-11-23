import { z } from "zod";

/** Envelope shapes stay compatible with the existing health endpoint (no version field). */
export function createApiSuccessSchema<T extends z.ZodType>(dataSchema: T) {
  return z.strictObject({
    data: dataSchema,
    meta: z.record(z.string(), z.unknown()).optional(),
  });
}

export const apiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().trim().min(1).max(100),
    message: z.string().trim().min(1),
    details: z.unknown().optional(),
  }),
});

export type ApiSuccess<T> = {
  data: T;
  meta?: Record<string, unknown>;
};

export type ApiErrorBody = z.infer<typeof apiErrorSchema>;
