import { z } from "zod";
import { notebookSchema, notebookBlockSchema, type Notebook } from "./notebook.js";
import { generationOutputTypeV2Schema, type GenerationOutputTypeV2 } from "./generation-v2.js";
import { transcriptLanguageSchema } from "./learning.js";
const text = (n = 5000) => z.string().trim().min(1).max(n);
const base = { version: z.literal(1), title: text(180), limitations: z.array(text(1000)).max(12) };
const card = z.strictObject({ id: text(40), question: text(2000), answer: text(4000) });
const question = z
  .strictObject({
    id: text(40),
    question: text(2000),
    options: z.array(text(1000)).min(2).max(6),
    answerIndex: z.number().int().nonnegative(),
    explanation: text(3000),
    marks: z.number().int().min(1).max(20),
  })
  .refine((q) => q.answerIndex < q.options.length);
export const resourceContentSchema = z
  .discriminatedUnion("type", [
    z.strictObject({ ...base, type: z.literal("detailed_notes"), notebook: notebookSchema }),
    z.strictObject({
      ...base,
      type: z.literal("short_notes"),
      points: z.array(notebookBlockSchema).min(1).max(160),
    }),
    z.strictObject({
      ...base,
      type: z.literal("flashcards"),
      cards: z.array(card).min(1).max(160),
    }),
    z.strictObject({
      ...base,
      type: z.literal("mcq_quiz"),
      questions: z.array(question).min(1).max(160),
    }),
    z.strictObject({
      ...base,
      type: z.literal("mindmap"),
      maps: z
        .array(z.union([notebookBlockSchema.options[5], notebookBlockSchema.options[6]]))
        .min(1)
        .max(160),
    }),
    z.strictObject({
      ...base,
      type: z.literal("sample_question_paper"),
      instructions: z.array(text(2000)).min(1).max(12),
      timeMinutes: z.number().int().min(5).max(240),
      sections: z
        .array(
          z.strictObject({
            title: text(180),
            questions: z
              .array(
                z.strictObject({
                  id: text(40),
                  text: text(2000),
                  marks: z.number().int().min(1).max(50),
                }),
              )
              .min(1)
              .max(30),
          }),
        )
        .min(1)
        .max(30),
      answers: z.array(notebookBlockSchema).min(1).max(160),
    }),
  ])
  .superRefine((content, ctx) => {
    const blocks =
      content.type === "detailed_notes"
        ? content.notebook.blocks
        : content.type === "short_notes"
          ? content.points
          : content.type === "mindmap"
            ? content.maps
            : content.type === "sample_question_paper"
              ? content.answers
              : [];
    if (blocks.length) {
      const checked = notebookSchema.safeParse({
        schemaVersion: 2,
        title: content.title,
        limitations: content.limitations,
        blocks,
      });
      if (!checked.success)
        ctx.addIssue({ code: "custom", message: "Invalid resource blocks or graph references" });
    }
    const ids =
      content.type === "flashcards"
        ? content.cards.map((c) => c.id)
        : content.type === "mcq_quiz"
          ? content.questions.map((q) => q.id)
          : content.type === "sample_question_paper"
            ? content.sections.flatMap((s) => s.questions.map((q) => q.id))
            : [];
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: "custom",
        message: "Resource entries must have unique stable identifiers",
      });
  });
export function resourceToNotebook(content: ResourceContent): Notebook {
  const blocks =
    content.type === "detailed_notes"
      ? content.notebook.blocks
      : content.type === "short_notes"
        ? content.points
        : content.type === "flashcards"
          ? content.cards.map(({ question, answer }) => ({
              type: "flashcard" as const,
              question,
              answer,
            }))
          : content.type === "mcq_quiz"
            ? content.questions.map(({ question, options, answerIndex, explanation }) => ({
                type: "quiz" as const,
                question,
                options,
                answerIndex,
                explanation,
              }))
            : content.type === "mindmap"
              ? content.maps
              : [
                  {
                    type: "important" as const,
                    text: "AI-generated practice paper — not verified PYQs or an official examination pattern.",
                  },
                  {
                    type: "paragraph" as const,
                    text: `Suggested time: ${content.timeMinutes} minutes. Timing and marks are study settings only.`,
                  },
                  { type: "bullet_list" as const, items: content.instructions },
                  ...content.sections.flatMap((s) => [
                    { type: "section" as const, text: s.title },
                    {
                      type: "numbered_list" as const,
                      items: s.questions.map((q) => `${q.text} [${q.marks} suggested marks]`),
                    },
                  ]),
                  { type: "section" as const, text: "Answer guide" },
                  ...content.answers,
                ];
  return notebookSchema.parse({
    schemaVersion: 2,
    title: content.title,
    blocks,
    limitations: content.limitations,
  });
}
// Legacy provider notebooks are normalized at the boundary, never rendered as raw JSON.
export function notebookToResource(
  notebook: Notebook,
  type: GenerationOutputTypeV2,
): ResourceContent {
  const common = { version: 1 as const, title: notebook.title, limitations: notebook.limitations };
  if (type === "detailed_notes") return resourceContentSchema.parse({ ...common, type, notebook });
  if (type === "short_notes")
    return resourceContentSchema.parse({
      ...common,
      type,
      points: notebook.blocks.filter((b) => !["quiz", "flashcard", "title"].includes(b.type)),
    });
  if (type === "flashcards")
    return resourceContentSchema.parse({
      ...common,
      type,
      cards: notebook.blocks
        .filter((b) => b.type === "flashcard")
        .map(({ question, answer }, i) => ({ question, answer, id: `card-${i + 1}` })),
    });
  if (type === "mcq_quiz")
    return resourceContentSchema.parse({
      ...common,
      type,
      questions: notebook.blocks
        .filter((b) => b.type === "quiz")
        .map(({ question, options, answerIndex, explanation }, i) => ({
          id: `q-${i + 1}`,
          question,
          options,
          answerIndex,
          explanation,
          marks: 1,
        })),
    });
  if (type === "mindmap")
    return resourceContentSchema.parse({
      ...common,
      type,
      maps: notebook.blocks.filter((b) => b.type === "mindmap" || b.type === "diagram"),
    });
  let heading = "Practice questions",
    answerMode = false;
  const sections: { title: string; questions: { id: string; text: string; marks: number }[] }[] =
      [],
    answers: Notebook["blocks"] = [];
  for (const block of notebook.blocks) {
    if (block.type === "section") {
      if (/answer|solution|explanation|उत्तर|समाधान/i.test(block.text)) answerMode = true;
      else if (!answerMode) heading = block.text;
    }
    if (answerMode) {
      answers.push(block);
      continue;
    }
    if (block.type === "numbered_list")
      sections.push({
        title: heading,
        questions: block.items.map((t, i) => ({
          id: `s${sections.length + 1}-q${i + 1}`,
          text: t,
          marks: 2,
        })),
      });
  }
  // Preserve the provider's worked answers instead of inventing an answer key.
  if (!answers.length)
    answers.push(...notebook.blocks.filter((b) => b.type === "paragraph" || b.type === "example"));
  return resourceContentSchema.parse({
    ...common,
    type,
    instructions: [
      "AI-generated practice paper — not authentic previous-year questions.",
      "Attempt all questions, then compare your reasoning with the answer guide.",
      "Timing and marks are suggested study settings, not an official examination pattern.",
    ],
    timeMinutes: 60,
    sections,
    answers,
  });
}
export const publishPermissionSchema = z.strictObject({
  basis: z.enum(["own_work", "licensed", "permission", "public_domain"]),
  statement: text(1000),
  confirmRights: z.literal(true),
  confirmPlatformTerms: z.literal(true),
});
export const resourceSummarySchema = z.strictObject({
  id: z.uuid(),
  title: text(180),
  description: text(1000),
  subject: text(180).nullable(),
  language: transcriptLanguageSchema,
  sourceLanguage: transcriptLanguageSchema,
  sourceType: z.enum(["youtube", "pdf", "spreadsheet"]),
  outputType: generationOutputTypeV2Schema,
  visibility: z.enum(["private", "published"]),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  owned: z.boolean(),
  preview: text(400),
});
export const resourceSchema = resourceSummarySchema.extend({ content: resourceContentSchema });
export const resourceListSchema = z.strictObject({
  data: z.array(resourceSummarySchema).max(100),
  hasMore: z.boolean(),
  storage: z.enum(["supabase", "local_postgres"]),
});
export const quizSubmissionSchema = z.strictObject({
  submissionId: z.uuid(),
  answers: z.array(z.number().int().min(0).max(5).nullable()).min(1).max(160),
});
export const quizAttemptSchema = z.strictObject({
  id: z.uuid(),
  resourceId: z.uuid(),
  score: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  percentage: z.number().min(0).max(100),
  answers: z.array(z.number().int().nonnegative().nullable()).max(160),
  createdAt: z.iso.datetime(),
});
export type ResourceContent = z.infer<typeof resourceContentSchema>;
export type ResourceSummary = z.infer<typeof resourceSummarySchema>;
export type StudyResource = z.infer<typeof resourceSchema>;
export type PublishPermission = z.infer<typeof publishPermissionSchema>;
