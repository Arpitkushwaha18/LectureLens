import { createClient } from "@supabase/supabase-js";

import { env } from "../config/env.js";
import { AppError } from "./errors.js";

// Server-only singleton. Browser headers must never be forwarded to this client.
const supabase =
  env.SUPABASE_URL && env.SUPABASE_SECRET_KEY
    ? createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: {
          fetch: (input, init) => {
            // A 20 MB admin PDF needs more than the normal metadata/RPC budget.
            const url = new URL(input instanceof Request ? input.url : String(input));
            const timeout = AbortSignal.timeout(
              init?.method?.toUpperCase() === "POST" &&
                url.pathname.startsWith("/storage/v1/object/")
                ? 120_000
                : 10_000,
            );
            return fetch(input, {
              ...init,
              signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
            });
          },
        },
      })
    : null;

export function getSupabaseAdmin() {
  if (!supabase)
    throw new AppError(
      "Supabase is not configured. Set SUPABASE_URL and SUPABASE_SECRET_KEY in backend/.env, then restart the backend.",
      {
        statusCode: 503,
        code: "DATABASE_NOT_CONFIGURED",
      },
    );
  return supabase;
}
