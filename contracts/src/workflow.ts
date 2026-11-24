import { z } from "zod";
import { youtubeVideoIdSchema } from "./youtube.js";
export const flashcardCountSchema = z.number().int().min(5).max(20).default(10);
export const quizCountSchema = z.number().int().min(5).max(30).default(10);
export const studyPreferencesSchema = z
  .strictObject({
    notesStyle: z
      .enum(["simple", "classroom", "university_exam", "revision", "conceptual"])
      .default("classroom"),
    tone: z.enum(["beginner", "academic", "technical"]).default("academic"),
    format: z.enum(["bullets", "paragraphs", "tables", "mixed"]).default("mixed"),
    examples: z.enum(["none", "simple", "practical", "programming"]).default("simple"),
    outputLanguage: z.enum(["original", "en", "hi", "hinglish"]).default("original"),
  })
  .default({
    notesStyle: "classroom",
    tone: "academic",
    format: "mixed",
    examples: "simple",
    outputLanguage: "original",
  });
export type StudyPreferences = z.infer<typeof studyPreferencesSchema>;
export const videoVerificationSchema = z.strictObject({
  status: z.enum(["verified", "unavailable"]),
  videoId: youtubeVideoIdSchema,
  title: z.string().min(1).max(240).optional(),
  message: z.string().min(1).max(2000),
  verificationToken: z.string().max(200).optional(),
  language: z.string().max(35).optional(),
});
