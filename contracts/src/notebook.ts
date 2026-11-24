import { z } from "zod";
import { MAX_SOURCE_CHARACTERS } from "./limits.js";
import { generationOutputTypeV2Schema } from "./generation-v2.js";

const text = (max = 5000) => z.string().trim().min(1).max(max);
const prose = [
  "title",
  "section",
  "paragraph",
  "example",
  "formula",
  "important",
  "exam_tip",
  "summary",
] as const;
const graph = {
  title: text(180),
  nodes: z
    .array(z.strictObject({ id: text(40), label: text(120) }))
    .min(1)
    .max(16),
  edges: z
    .array(z.strictObject({ from: text(40), to: text(40), label: text(80).optional() }))
    .max(32),
};
export const notebookBlockSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.enum(prose), text: text() }),
  z.strictObject({ type: z.literal("definition"), term: text(180), text: text() }),
  z.strictObject({ type: z.literal("bullet_list"), items: z.array(text(2000)).min(1).max(30) }),
  z.strictObject({ type: z.literal("numbered_list"), items: z.array(text(2000)).min(1).max(30) }),
  z.strictObject({
    type: z.literal("table"),
    caption: text(180),
    headers: z.array(text(180)).min(1).max(12),
    rows: z
      .array(z.array(text(1000)).min(1).max(12))
      .min(1)
      .max(60),
  }),
  z.strictObject({ type: z.literal("diagram"), ...graph }),
  z.strictObject({ type: z.literal("mindmap"), ...graph }),
  z.strictObject({ type: z.literal("flashcard"), question: text(2000), answer: text(4000) }),
  z.strictObject({
    type: z.literal("quiz"),
    question: text(2000),
    options: z.array(text(1000)).min(2).max(6),
    answerIndex: z.number().int().min(0).max(5),
    explanation: text(3000),
  }),
]);
export const notebookSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    title: text(180),
    blocks: z.array(notebookBlockSchema).min(1).max(160),
    limitations: z.array(text(1000)).max(12),
  })
  .superRefine((value, ctx) => {
    value.blocks.forEach((block, i) => {
      if (block.type === "table" && block.rows.some((row) => row.length !== block.headers.length))
        ctx.addIssue({
          code: "custom",
          path: ["blocks", i],
          message: "Table rows must match headers",
        });
      if (block.type === "quiz" && block.answerIndex >= block.options.length)
        ctx.addIssue({
          code: "custom",
          path: ["blocks", i],
          message: "Answer must reference an option",
        });
      if (block.type === "diagram" || block.type === "mindmap") {
        const ids = new Set(block.nodes.map((node) => node.id));
        if (
          ids.size !== block.nodes.length ||
          block.edges.some((edge) => !ids.has(edge.from) || !ids.has(edge.to))
        )
          ctx.addIssue({
            code: "custom",
            path: ["blocks", i],
            message: "Graph references must be valid and unique",
          });
      }
    });
  });
export const studyMaterialSchema = z.strictObject({
  outputType: generationOutputTypeV2Schema,
  cached: z.boolean(),
  notebook: notebookSchema,
  resourceId: z.uuid().optional(),
  visibility: z.enum(["private", "published"]).optional(),
  language: z.string().max(35).optional(),
});
export const extractedSourceSchema = z.strictObject({
  kind: z.enum(["youtube", "pdf", "spreadsheet"]),
  name: text(240),
  text: text(MAX_SOURCE_CHARACTERS),
  warnings: z.array(text(1000)).max(100),
  language: z.string().max(35).optional(),
  captionSelection: z.enum(["provider_default", "human", "automatic", "unknown"]).optional(),
  partial: z.boolean().optional(),
  failedImages: z
    .array(
      z.strictObject({
        sheet: text(240),
        name: text(240),
        location: text(240).optional(),
        reason: text(1000),
        retryable: z.boolean(),
      }),
    )
    .max(100)
    .optional(),
  retryable: z.boolean().optional(),
  failedPages: z
    .array(
      z.strictObject({
        page: z.number().int().positive(),
        reason: text(1000),
        retryable: z.boolean(),
      }),
    )
    .max(200)
    .optional(),
  pages: z
    .array(
      z.strictObject({
        page: z.number().int().positive(),
        text: z.string().max(MAX_SOURCE_CHARACTERS),
        ocr: z.boolean().optional(),
      }),
    )
    .max(200)
    .optional(),
  sheets: z
    .array(
      z.strictObject({
        name: text(180),
        headers: z.array(z.string().max(2000)).max(100),
        rows: z.array(z.array(z.string().max(2000)).max(100)).max(5000),
        images: z
          .array(
            z.strictObject({
              name: text(240),
              text: text(MAX_SOURCE_CHARACTERS),
              location: text(180).optional(),
              warning: text(1000).optional(),
            }),
          )
          .max(50)
          .optional(),
      }),
    )
    .max(30)
    .optional(),
  segments: z
    .array(
      z.strictObject({
        start: z.number().finite().nonnegative(),
        duration: z.number().finite().nonnegative(),
        text: text(),
      }),
    )
    .max(10000)
    .optional(),
});
// YouTube captions are internal. The public boundary cannot carry text, segments or timestamps.
export const publicSourceSchema = z.union([
  z.strictObject({
    kind: z.literal("youtube"),
    name: text(240),
    language: z.string().max(35).optional(),
    warnings: z.array(text(1000)).max(100),
  }),
  extractedSourceSchema.extend({ kind: z.enum(["pdf", "spreadsheet"]) }),
]);
export type PublicSource = z.infer<typeof publicSourceSchema>;
export const workspaceResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("extracted"),
    source: publicSourceSchema,
    message: text(2000),
    retryable: z.boolean(),
  }),
  z.strictObject({
    status: z.literal("ready"),
    source: publicSourceSchema,
    materials: z.array(studyMaterialSchema).min(1).max(6),
    completionStatus: z.enum(["completed", "partially_completed"]).optional(),
    failures: z
      .array(
        z.strictObject({
          outputType: generationOutputTypeV2Schema,
          code: text(64),
          message: text(2000),
          retryable: z.boolean(),
          retryAfterSeconds: z.number().int().min(1).max(86400).optional(),
        }),
      )
      .max(6)
      .optional(),
  }),
  z.strictObject({
    status: z.literal("pending"),
    retrySafe: z.boolean().optional(),
    message: text(2000),
    retryAfterSeconds: z.number().int().min(1).max(86400),
  }),
]);
export const workspaceEventSchema = z.discriminatedUnion("event", [
  z.strictObject({
    event: z.literal("progress"),
    percent: z.number().int().min(0).max(100),
    message: text(2000),
  }),
  z.strictObject({ event: z.literal("material"), material: studyMaterialSchema }),
  z.strictObject({ event: z.literal("source"), source: publicSourceSchema }),
  z.strictObject({
    event: z.literal("stage"),
    stage: z.enum(["validating", "extracting", "preparing", "generating", "rendering"]),
    message: text(2000),
    outputType: generationOutputTypeV2Schema.optional(),
    outputStatus: z
      .enum(["queued", "generating", "saving", "ready", "failed", "blocked"])
      .optional(),
    resourceId: z.uuid().optional(),
  }),
  z.strictObject({ event: z.literal("result"), result: workspaceResultSchema }),
  z.strictObject({
    event: z.literal("error"),
    code: text(64),
    message: text(2000),
    retryable: z.boolean(),
    retryAfterSeconds: z.number().int().min(1).max(86400).optional(),
  }),
]);
export type Notebook = z.infer<typeof notebookSchema>;
export type NotebookBlock = z.infer<typeof notebookBlockSchema>;
export type ExtractedSource = z.infer<typeof extractedSourceSchema>;
export type WorkspaceResult = z.infer<typeof workspaceResultSchema>;
export type WorkspaceEvent = z.infer<typeof workspaceEventSchema>;
