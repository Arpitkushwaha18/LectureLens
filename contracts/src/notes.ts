import { z } from "zod";
import { MAX_SOURCE_CHARACTERS, MAX_SOURCE_BYTES } from "./limits.js";
import { notebookBlockSchema } from "./notebook.js";
import { canonicalVideoSourceSchema, youtubeUrlSchema } from "./youtube.js";
import {
  transcriptLanguageSchema,
  transcriptProviderOutcomeSchema,
} from "./learning.js";

export const NOTES_SCHEMA_VERSION = 1;
export const MAX_NOTES_TRANSCRIPT_CHARACTERS = MAX_SOURCE_CHARACTERS;
export const MAX_NOTES_TRANSCRIPT_BYTES = MAX_SOURCE_BYTES;
const text = (max: number) => z.string().trim().min(1).max(max);
export const manualNotesTranscriptSchema = z
  .string()
  .trim()
  .min(1)
  .max(
    MAX_NOTES_TRANSCRIPT_CHARACTERS,
    "Source exceeds the 100,000-character limit. Split it into smaller sections.",
  )
  .refine((value) => !value.includes("\u0000"), "Transcript cannot contain null bytes")
  .refine(
    (value) => new TextEncoder().encode(value).length <= MAX_NOTES_TRANSCRIPT_BYTES,
    "Transcript exceeds the UTF-8 size limit",
  );

/** Additive B3 contract; B1 and the opt-in six-output V2 enum stay unchanged. */
export const detailedNotesSchema = z.strictObject({
  blocks: z.array(notebookBlockSchema).min(1).max(160).optional(),
  schemaVersion: z.literal(NOTES_SCHEMA_VERSION),
  title: text(180),
  overview: text(2000),
  sections: z
    .array(
      z.strictObject({
        heading: text(180),
        explanation: text(5000),
        keyPoints: z.array(text(1000)).min(1).max(12),
      }),
    )
    .min(1)
    .max(16),
  takeaways: z.array(text(1000)).min(1).max(12),
  limitations: z.array(text(500)).max(8),
});
export const notesRequestSchema = z
  .strictObject({
    url: youtubeUrlSchema,
    transcript: manualNotesTranscriptSchema.optional(),
    transcriptLanguage: transcriptLanguageSchema
      .default("en")
      .transform((value) => value.toLowerCase()),
    shareConsent: z.boolean().default(false),
    checkOnly: z.boolean().default(false),
  })
  .refine((value) => !value.transcript || value.shareConsent, {
    path: ["shareConsent"],
    error: "Confirm that you may share this transcript as a public learning resource",
  });
const transcriptInfoSchema = z.strictObject({
  id: z.uuid(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  provenance: z.enum(["manual", "authorized_youtube", "licensed_provider"]),
  reused: z.boolean(),
  language: transcriptLanguageSchema.optional(),
});
export const notesOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("extracting"),
    source: canonicalVideoSourceSchema,
    retryAfterSeconds: z.number().int().min(1).max(300),
  }),
  z.strictObject({
    status: z.literal("transcript_required"),
    source: canonicalVideoSourceSchema,
    provider: z.discriminatedUnion("status", [
      transcriptProviderOutcomeSchema.options[1],
      transcriptProviderOutcomeSchema.options[2],
      transcriptProviderOutcomeSchema.options[3],
    ]),
  }),
  z.strictObject({
    status: z.literal("processing"),
    source: canonicalVideoSourceSchema,
    contentId: z.uuid(),
    retryAfterSeconds: z.number().int().min(1).max(300),
  }),
  z.strictObject({
    status: z.literal("ready"),
    source: canonicalVideoSourceSchema,
    contentId: z.uuid(),
    cached: z.boolean(),
    transcript: transcriptInfoSchema,
    notes: detailedNotesSchema,
  }),
]);
export type DetailedNotes = z.infer<typeof detailedNotesSchema>;
export type NotesRequest = z.infer<typeof notesRequestSchema>;
export type NotesOutcome = z.infer<typeof notesOutcomeSchema>;
