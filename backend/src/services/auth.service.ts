import { createClient, type Session } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { env } from "../config/env.js";
import { AppError } from "../lib/errors.js";

const credentialsSchema = z.strictObject({
  email: z.email().max(254),
  password: z.string().min(8).max(128),
});
export function authClient() {
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY)
    throw new AppError("Account sign-in is not configured.", {
      code: "AUTH_NOT_CONFIGURED",
      statusCode: 503,
    });
  // Never put a user's session into the shared admin client.
  return createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10000) }),
    },
  }).auth;
}
export async function authenticate(action: "login" | "signup", input: unknown) {
  const credentials = credentialsSchema.parse(input),
    auth = authClient();
  const result =
    action === "signup"
      ? await auth.signUp(credentials)
      : await auth.signInWithPassword(credentials);
  if (result.error)
    throw new AppError(
      "Sign-in could not be completed. Check your credentials or account confirmation.",
      { code: "AUTH_FAILED", statusCode: 401 },
    );
  return result.data.session;
}
// Coalesce simultaneous refreshes (and brief retry overlap) without keeping raw tokens as map keys.
const refreshes = new Map<string, { expires: number; result: Promise<Session | null> }>();
export function refreshSession(token: string): Promise<Session | null> {
  const key = createHash("sha256").update(token).digest("hex"),
    now = Date.now();
  for (const [id, value] of refreshes) if (value.expires <= now) refreshes.delete(id);
  const previous = refreshes.get(key);
  if (previous) return previous.result;
  if (refreshes.size >= 1000) refreshes.delete(refreshes.keys().next().value!);
  const result = authClient()
    .refreshSession({ refresh_token: token })
    .then(({ data, error }) => (error ? null : data.session));
  refreshes.set(key, { expires: now + 10000, result });
  void result.catch(() => refreshes.delete(key));
  return result;
}
