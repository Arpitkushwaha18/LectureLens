export type SupabaseBrowserConfig =
  | { status: "disabled" | "invalid" }
  | { status: "configured"; url: string; publishableKey: string };

/** Never return raw invalid values in diagnostics; VITE_* values are public. */
export function readSupabaseBrowserConfig(env: Record<string, unknown>): SupabaseBrowserConfig {
  // A wrongly-prefixed server secret is a configuration error even without a client.
  if (
    Object.entries(env).some(
      ([name, value]) =>
        name.startsWith("VITE_") &&
        (/SECRET|SERVICE_ROLE|GROQ.*KEY|FREEGG.*KEY|GEMINI.*KEY|GOOGLE.*KEY|APIFY.*(?:TOKEN|KEY)|TRANSCRIPTFETCH/i.test(
          name,
        ) ||
          (typeof value === "string" && value.startsWith("sb_secret_"))),
    )
  ) {
    return { status: "invalid" };
  }
  const urlValue = env.VITE_SUPABASE_URL;
  const keyValue = env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!urlValue && !keyValue) return { status: "disabled" };
  if (
    typeof urlValue !== "string" ||
    typeof keyValue !== "string" ||
    !/^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(keyValue)
  )
    return { status: "invalid" };
  try {
    const url = new URL(urlValue);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      return { status: "invalid" };
    }
    return { status: "configured", url: urlValue, publishableKey: keyValue };
  } catch {
    return { status: "invalid" };
  }
}
