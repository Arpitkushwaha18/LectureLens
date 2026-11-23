import { z } from "zod";

import { generationOutputTypeSchema } from "./learning.js";

/** Additive opt-in contract: the original B1 generation enum remains unchanged. */
export const GENERATION_SELECTION_SCHEMA_VERSION = 2;

export const generationOutputTypeV2Schema = z.enum([
  ...generationOutputTypeSchema.options,
  "mindmap",
  "sample_question_paper",
]);

export const generationSelectionV2Schema = z.strictObject({
  schemaVersion: z.literal(GENERATION_SELECTION_SCHEMA_VERSION),
  outputTypes: z
    .array(generationOutputTypeV2Schema)
    .min(1)
    .max(6)
    .refine((types) => new Set(types).size === types.length, {
      error: "Select each output type only once",
    }),
});

export type GenerationOutputTypeV2 = z.infer<typeof generationOutputTypeV2Schema>;
export type GenerationSelectionV2 = z.infer<typeof generationSelectionV2Schema>;
