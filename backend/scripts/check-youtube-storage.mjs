// Read-only: does not acquire captions, reserve jobs, generate content or apply SQL.
import {config} from 'dotenv';
import {fileURLToPath} from 'node:url';
config({path:fileURLToPath(new URL('../.env',import.meta.url)),quiet:true});
import { createClient } from "@supabase/supabase-js";
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
  console.error("Backend Supabase connection is not configured.");
  process.exitCode = 1;
} else {
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15000) }) },
  });
  const { data, error } = await client.rpc("youtube_storage_health");
  if (error) {
    console.error(
      `YouTube storage check: ${error.code ?? "connection failure"}. ${["PGRST202", "42883"].includes(error.code) ? "The database is missing the final workflow RPC. Local migrations 005–012 are prepared; apply only to an approved development database. No migrations or paid requests were sent." : "Check the backend database connection and service-role permissions. No writes were performed."}`,
    );
    process.exitCode = 1;
  } else if (!data?.ready) {
    console.error("YouTube storage dependencies are incomplete. No writes were performed.");
    process.exitCode = 1;
  } else
    console.log(
      "YouTube caption and notes RPC dependencies are available. Read-only check; no paid requests.",
    );
}
