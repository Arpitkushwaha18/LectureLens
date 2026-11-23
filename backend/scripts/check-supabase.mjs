import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const expected = "https://hotreszoeqtsidpcbcaf.supabase.co";
if (
  process.env.SUPABASE_URL?.replace(/\/$/, "") !== expected ||
  !process.env.SUPABASE_SECRET_KEY?.startsWith("sb_secret_")
) {
  console.error(
    "Set the intended SUPABASE_URL and server-only SUPABASE_SECRET_KEY in backend/.env. No secrets are printed.",
  );
  process.exitCode = 1;
} else {
  try {
    const client = createClient(expected, process.env.SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15000) }),
      },
    });
    for (const table of [
      "learning_sources",
      "transcripts",
      "generated_content",
      "generation_jobs",
    ]) {
      const { error } = await client.from(table).select("id", { head: true }).limit(1);
      if (error) throw new Error("Database check failed");
    }
    // A deliberately absent video returns no rows and performs no writes.
    const { error } = await client.rpc("read_youtube_notes", {
      p_video_id: "AbCdEf12_-3",
      p_content_id: "00000000-0000-4000-8000-000000000000",
    });
    if (error) throw new Error("Workflow migration missing");
    console.log(
      "Read-only server connection and required tables/read RPC verified for project hotreszoeqtsidpcbcaf. Migration history, remaining RPCs and browser RLS grants still require CLI/dashboard review.",
    );
  } catch {
    console.error(
      "Hosted verification failed. Check the local credentials, target and migrations. Upstream details are not printed.",
    );
    process.exitCode = 1;
  }
}
