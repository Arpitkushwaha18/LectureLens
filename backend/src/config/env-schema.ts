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
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(3).default(0),
    SESSION_SAME_SITE: z.enum(["lax", "strict", "none"]).default("lax"),
    SUPABASE_URL: optionalValue,
    SUPABASE_SECRET_KEY: optionalValue,
    GALLERY_ADMIN_PASSWORD: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(16).max(256).optional(),
    ),
    GEMINI_API_KEY: optionalValue,
    GEMINI_BACKUP_API_KEY: optionalValue,
    GEMINI_MODEL: optionalValue,
    GEMINI_TUTOR_MODEL: z
      .string()
      .regex(/^gemini-[a-z0-9.-]{1,100}$/)
      .refine((model) => !model.endsWith("-latest"), "Use an explicit Gemini tutor model ID")
      .default("gemini-3.5-flash-lite"),
    // Legacy override retained; new installations default to Groq. Quick Ask is independent.
    AI_PROVIDER: z.enum(["gemini", "groq", "freegg"]).default("groq"),
    AI_PRIMARY_PROVIDER: z.enum(["groq", "freegg"]).optional(),
    AI_FALLBACK_PROVIDER: z.enum(["groq", "freegg", "none"]).default("freegg"),
    GROQ_API_KEY: optionalValue,
    GROQ_MODEL: z
      .string()
      .regex(/^[A-Za-z0-9._/-]{1,100}$/)
      .default("openai/gpt-oss-120b"),
    GROQ_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    FREEGG_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    FREEGG_BASE_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .default("https://freegg.app/v1")
        .refine((value) => {
          try {
            const url = new URL(value);
            return (
              url.protocol === "https:" &&
              !url.username &&
              !url.password &&
              !url.search &&
              !url.hash &&
              !/^(localhost|.*\.localhost|.*\.local)$/.test(url.hostname) &&
              /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname) &&
              /^\/(?:[a-zA-Z0-9_-]+\/?)*$/.test(url.pathname)
            );
          } catch {
            return false;
          }
        }, "Use a trusted public HTTPS API base URL without credentials, query or fragment"),
    ),
    AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(180000).default(120000),
    AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1024).max(65536).default(4096),
    GROQ_CONTEXT_TOKENS: z.coerce.number().int().min(8192).max(131072).default(131072),
    GROQ_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1024).max(65536).default(65536),
    AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
    AI_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
    AI_MAX_QUEUE: z.coerce.number().int().min(0).max(32).default(8),
    AI_MIN_REQUEST_INTERVAL_MS: z.coerce.number().int().min(0).max(60000).default(2000),
    AI_MAX_RETRIES: z.coerce.number().int().min(0).max(2).default(1),
    AI_MAX_RETRY_WAIT_MS: z.coerce.number().int().min(0).max(30000).default(5000),
    AI_CHUNK_TOKENS: z.coerce.number().int().min(1000).max(24000).default(2000),
    AI_CHUNK_OVERLAP_TOKENS: z.coerce.number().int().min(0).max(1000).default(150),
    AI_MAX_CHUNKS: z.coerce.number().int().min(1).max(256).default(128),
    AI_JOB_TIMEOUT_MS: z.coerce.number().int().min(10000).max(540000).default(540000),
    FREEGG_API_KEY: optionalValue,
    FREEGG_MODEL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .regex(/^[A-Za-z0-9._/-]{1,100}$/)
        .default("gpt-6.1-sol"),
    ),
    WORKSPACE_YOUTUBE_STORE: z.enum(["local", "supabase"]).default("local"),
    LIBRARY_STORE: z.enum(["local_postgres", "supabase"]).default("local_postgres"),
    TRANSCRIPTFETCH_API_KEY: optionalValue,
    TRANSCRIPT_MAX_CHARACTERS: z.coerce.number().int().min(1).max(500000).default(500000),
    DOCUMENT_EXTRACT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(180000).default(180000),
    TRANSCRIPT_MAX_DURATION_SECONDS: z.coerce.number().int().min(1).max(18000).default(18000),
  })
  .superRefine((env, ctx) => {
    if (env.GROQ_API_KEY && (env.GROQ_API_KEY.length > 4096 || /\s/.test(env.GROQ_API_KEY)))
      ctx.addIssue({
        code: "custom",
        path: ["GROQ_API_KEY"],
        message: "Invalid Groq API key format",
      });
    if (env.AI_CHUNK_OVERLAP_TOKENS >= env.AI_CHUNK_TOKENS)
      ctx.addIssue({
        code: "custom",
        path: ["AI_CHUNK_OVERLAP_TOKENS"],
        message: "Overlap must be smaller than chunk size",
      });
    if (env.AI_CHUNK_TOKENS + env.AI_MAX_OUTPUT_TOKENS + 8192 > env.GROQ_CONTEXT_TOKENS)
      ctx.addIssue({
        code: "custom",
        path: ["GROQ_CONTEXT_TOKENS"],
        message: "Context must fit chunk, prompt reserve and output budget",
      });
    if (env.SESSION_SAME_SITE === "none" && env.NODE_ENV !== "production")
      ctx.addIssue({
        code: "custom",
        path: ["SESSION_SAME_SITE"],
        message: "SameSite=None requires production HTTPS",
      });
    if (env.NODE_ENV === "production" && (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY))
      ctx.addIssue({
        code: "custom",
        path: ["SUPABASE_URL"],
        message: "Production requires Supabase configuration",
      });
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
    if (
      (env.GEMINI_MODEL && !env.GEMINI_API_KEY) ||
      (!env.AI_PRIMARY_PROVIDER &&
        env.AI_PROVIDER === "gemini" &&
        env.GEMINI_API_KEY &&
        !env.GEMINI_MODEL)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["GEMINI_MODEL"],
        message:
          "Gemini study generation requires GEMINI_API_KEY and GEMINI_MODEL; tutor-only use requires just GEMINI_API_KEY",
      });
    }
    for (const name of ["GEMINI_API_KEY", "GEMINI_BACKUP_API_KEY"] as const) {
      if (env[name] && !isValidGeminiKeyFormat(env[name]))
        ctx.addIssue({ code: "custom", path: [name], message: "Invalid Gemini API key format" });
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
