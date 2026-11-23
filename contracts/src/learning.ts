import { z } from "zod";

import { CONTRACT_SCHEMA_VERSION, youtubeVideoIdSchema } from "./youtube.js";

// Provider-acquired lectures can be longer than manually pasted/document sources.
export const MAX_TRANSCRIPT_CHARACTERS = 500_000;
export const MAX_TRANSCRIPT_BYTES = 2_000_000;
export const MAX_TRANSCRIPT_SEGMENTS = 30_000;
export const transcriptTextSchema = z
  .string()
  .min(1)
  .max(MAX_TRANSCRIPT_CHARACTERS)
  .refine((value) => value.trim().length > 0 && !value.includes("\u0000"))
  .refine((value) => new TextEncoder().encode(value).length <= MAX_TRANSCRIPT_BYTES);

export const generationOutputTypeSchema = z.enum([
  "detailed_notes",
  "short_notes",
  "flashcards",
  "mcq_quiz",
]);

/** Common language tags (en, hi, en-US, zh-Hant); und means undetermined. */
export const transcriptLanguageSchema = z
  .string()
  .max(35)
  .regex(/^(?:[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*|und)$/u)
  .refine((language) => language === language.trim());

export const transcriptSegmentSchema = z.strictObject({
  start: z.number().finite().nonnegative(),
  duration: z.number().finite().nonnegative(),
  text: z.string().trim().min(1).max(MAX_TRANSCRIPT_CHARACTERS),
});
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;

export const transcriptMetadataSchema = z
  .strictObject({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    videoId: youtubeVideoIdSchema,
    language: transcriptLanguageSchema,
    requestedLanguage: z.enum(["en", "hi"]).optional(),
    returnedLanguage: transcriptLanguageSchema.optional(),
    captionSelection: z.enum(["provider_default", "human", "automatic", "unknown"]).optional(),
    translationStatus: z
      .enum(["not_requested", "reported_original", "reported_translated", "unknown"])
      .optional(),
    sourceMetadata: z
      .strictObject({
        platform: z.literal("youtube").nullable(),
        title: z.string().max(2000).nullable(),
        channel: z.string().max(2000).nullable(),
        url: z.string().max(2000).nullable(),
        thumbnailUrl: z.string().max(2000).nullable(),
        duration: z.number().finite().nonnegative().nullable(),
        source: z.literal("captions").nullable(),
      })
      .optional(),
    // Internal provider result only; account usage is persisted privately, not in public transcripts.
    usage: z
      .strictObject({
        creditsSpent: z.number().finite().nonnegative(),
        balance: z.number().finite().nonnegative().nullable(),
        bytes: z.number().finite().nonnegative(),
      })
      .optional(),
    provenance: z.enum(["manual", "authorized_youtube", "licensed_provider"]),
    provider: z.strictObject({
      id: z
        .string()
        .regex(/^[a-z][a-z0-9_-]{0,63}$/u)
        .refine((id) => id === id.trim()),
      version: z.string().trim().min(1).max(64),
    }),
    characterCount: z.number().int().min(1).max(MAX_TRANSCRIPT_CHARACTERS),
    contentHash: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    obtainedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().optional(),
  })
  .refine(
    (metadata) =>
      !metadata.expiresAt || Date.parse(metadata.expiresAt) > Date.parse(metadata.obtainedAt),
    { path: ["expiresAt"], error: "Expiry must be later than acquisition" },
  );

const transcriptSchema = z
  .strictObject({
    metadata: transcriptMetadataSchema,
    segments: z.array(transcriptSegmentSchema).min(1).max(MAX_TRANSCRIPT_SEGMENTS).optional(),
    text: z
      .string()
      .min(1)
      .max(MAX_TRANSCRIPT_CHARACTERS)
      .refine((text) => text.trim().length > 0),
  })
  .refine((transcript) => transcript.text.length === transcript.metadata.characterCount, {
    path: ["metadata", "characterCount"],
    error: "Character count must match transcript text (UTF-16 code units)",
  })
  .refine(
    (transcript) =>
      !transcript.segments ||
      transcript.segments.map((segment) => segment.text).join(" ") === transcript.text,
    {
      path: ["segments"],
      error: "Segment text must match the full transcript in dataset order",
    },
  );

const outcomeMessageSchema = z.string().trim().min(1).max(500);

/** Contracts only. No provider implementation, authorization or retrieval is performed. */
export const transcriptProviderOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    status: z.literal("available"),
    transcript: transcriptSchema,
  }),
  z.strictObject({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    status: z.literal("unavailable"),
    reason: z.enum([
      "captions_unavailable",
      "language_unavailable",
      "provider_not_configured",
      "access_denied",
    ]),
    message: outcomeMessageSchema,
  }),
  z.strictObject({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    status: z.literal("authorization_required"),
    message: outcomeMessageSchema,
  }),
  z.strictObject({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    status: z.literal("temporarily_failed"),
    message: outcomeMessageSchema,
    retryAfterSeconds: z.number().int().min(1).max(86_400).optional(),
  }),
]);

export type GenerationOutputType = z.infer<typeof generationOutputTypeSchema>;
export type TranscriptMetadata = z.infer<typeof transcriptMetadataSchema>;
export type TranscriptProviderOutcome = z.infer<typeof transcriptProviderOutcomeSchema>;
