import "./load-env.js";

import { envSchema } from "./env-schema.js";

/**
 * Environment configuration is validated once, at boot.
 * If anything is missing or malformed the process exits immediately —
 * failing at startup is far cheaper than failing mid-request later.
 */
const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const problems = parsed.error.issues
    .map(
      (issue) =>
        `  - ${issue.path.join(".") || "(root)"}: ${issue.code === "custom" ? issue.message : "invalid configuration"}`,
    )
    .join("\n");

  console.error(`Invalid environment configuration:\n${problems}\n`);
  process.exit(1);
}

const raw = parsed.data;

export const env = {
  ...raw,
  isProduction: raw.NODE_ENV === "production",
  allowedOrigins: raw.FRONTEND_ORIGIN.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
} as const;
