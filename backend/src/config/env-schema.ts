import { z } from "zod";

const optionalValue = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().optional(),
);

// Application bounds, not a guarantee that Google accepts a credential.
// Preserve the standard-key alphabet; only the exact AQ. prefix permits a dot.
export function isValidGeminiKeyFormat(value: string): boolean {
  if (value.length > 4096 || /\s/.test(value)) return false;
  const standardKey = /^[A-Za-z0-9_-]{16,}$/.test(value);
  const authorizationKey = /^AQ\.[A-Za-z0-9_-]{16,}$/.test(value);
  return standardKey || authorizationKey;
}

export function isSafeSupabaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return (
      (url.protocol === "https:" || (local && url.protocol === "http:")) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.pathname === "/" || url.pathname === "")
    );
  } catch {
    return false;
  }
}

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    SERVICE_VERSION: z.string().min(1).default("0.1.0"),
    FRONTEND_ORIGIN: z.string().min(1).default("http://localhost:5173"),
    SUPABASE_URL: optionalValue,
    SUPABASE_SECRET_KEY: optionalValue,
    GEMINI_API_KEY: optionalValue,
    GEMINI_MODEL: optionalValue,
    AI_PROVIDER: z.enum(["gemini", "freegg"]).default("gemini"),
    FREEGG_API_KEY: optionalValue,
    FREEGG_MODEL: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,100}$/)
      .default("gpt-6.1-sol"),
    WORKSPACE_YOUTUBE_STORE: z.enum(["local", "supabase"]).default("local"),
    LIBRARY_STORE: z.enum(["local_postgres", "supabase"]).default("local_postgres"),
    TRANSCRIPTFETCH_API_KEY: optionalValue,
    TRANSCRIPT_MAX_CHARACTERS: z.coerce.number().int().min(1).max(500000).default(500000),
    OCR_LANGUAGES: z
      .string()
      .regex(/^(eng|hin)(\+(eng|hin))?$/)
      .default("eng+hin"),
    OCR_TESSERACT_PATH: z.string().min(1).default("tesseract"),
    OCR_TESSERACT_LIBRARY: optionalValue,
    OCR_DPI: z.coerce.number().int().min(100).max(220).default(150),
    OCR_MIN_TEXT_CHARACTERS: z.coerce.number().int().min(24).max(500).default(80),
    DOCUMENT_EXTRACT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(180000).default(180000),
    OCR_PAGE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(15000),
    OCR_TESSDATA_DIR: optionalValue,
    OCR_MAX_IMAGES: z.coerce.number().int().min(1).max(50).default(30),
    TRANSCRIPT_MAX_DURATION_SECONDS: z.coerce.number().int().min(1).max(18000).default(18000),
  })
  .superRefine((env, ctx) => {
    if (env.FREEGG_API_KEY && (env.FREEGG_API_KEY.length > 4096 || /\s/.test(env.FREEGG_API_KEY)))
      ctx.addIssue({
        code: "custom",
        path: ["FREEGG_API_KEY"],
        message: "Invalid FreeGG API key format",
      });
    if (env.NODE_ENV === "production" && env.LIBRARY_STORE !== "supabase")
      ctx.addIssue({
        code: "custom",
        path: ["LIBRARY_STORE"],
        message:
          "Production requires the approved Supabase library, not the local development database",
      });
    if (
      env.TRANSCRIPTFETCH_API_KEY &&
      (env.TRANSCRIPTFETCH_API_KEY.length > 4096 || /\s/.test(env.TRANSCRIPTFETCH_API_KEY))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["TRANSCRIPTFETCH_API_KEY"],
        message: "Invalid TranscriptFetch key format",
      });
    }
    if (Boolean(env.GEMINI_API_KEY) !== Boolean(env.GEMINI_MODEL)) {
      ctx.addIssue({
        code: "custom",
        path: ["GEMINI_MODEL"],
        message: "Set both GEMINI_API_KEY and GEMINI_MODEL in backend/.env, or leave both unset",
      });
    }
    if (env.GEMINI_API_KEY && !isValidGeminiKeyFormat(env.GEMINI_API_KEY)) {
      ctx.addIssue({
        code: "custom",
        path: ["GEMINI_API_KEY"],
        message: "Invalid Gemini API key format",
      });
    }
    if (
      env.GEMINI_MODEL &&
      (!/^gemini-[a-z0-9.-]{1,100}$/.test(env.GEMINI_MODEL) || env.GEMINI_MODEL.endsWith("-latest"))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["GEMINI_MODEL"],
        message: "Use an explicit Gemini model ID, not a latest alias",
      });
    }
    if (Boolean(env.SUPABASE_URL) !== Boolean(env.SUPABASE_SECRET_KEY)) {
      ctx.addIssue({
        code: "custom",
        path: ["SUPABASE_URL"],
        message: "Configure both Supabase variables or leave both unset",
      });
    }
    if (env.SUPABASE_URL && !isSafeSupabaseUrl(env.SUPABASE_URL)) {
      ctx.addIssue({ code: "custom", path: ["SUPABASE_URL"], message: "Invalid Supabase URL" });
    }
    if (
      env.SUPABASE_SECRET_KEY &&
      !/^sb_secret_[A-Za-z0-9_-]{16,}$/.test(env.SUPABASE_SECRET_KEY)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["SUPABASE_SECRET_KEY"],
        message: "Use a server-only Supabase secret key",
      });
    }
  });
