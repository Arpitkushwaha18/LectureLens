import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";

export const A = "11111111-1111-4111-8111-111111111111";
export const B = "22222222-2222-4222-8222-222222222222";
export const fixtureNotes = {
  schemaVersion: 1,
  title: "Database transactions",
  overview: "A technical test fixture.",
  sections: [
    {
      heading: "Atomicity",
      explanation: "A transaction succeeds or rolls back together.",
      keyPoints: ["Use a transaction boundary."],
    },
  ],
  takeaways: ["Partial writes must not be published."],
  limitations: ["Test fixture, not a real lecture."],
};

export async function createDatabase(migrationCount = 4, db = new PGlite()) {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    insert into auth.users values ('${A}'),('${B}');`);
  for (const name of [
    "20261121000100_b2_learning_foundation.sql",
    "20261121000200_b3_notes_workflow.sql",
    "20261121000300_apify_transcript_extraction.sql",
    "20261121000400_transcriptfetch_captions.sql",
    "20261122000500_source_limits_and_generation_fences.sql",
    "20261122000600_operator_recovery_and_evidence.sql",
    "20261122000700_generation_retry_lifecycle.sql",
  ].slice(0, migrationCount)) {
    const sql = await readFile(
      new URL(`../../../supabase/migrations/${name}`, import.meta.url),
      "utf8",
    );
    await db.exec(`begin; ${sql} commit;`);
  }
  return db;
}
export function embeddedRepository(db) {
  const scalar = async (sql, params) => (await db.query(sql, params)).rows[0].value;
  const row = async (sql, params) => (await db.query(sql, params)).rows[0] ?? null;
  return {
    ensureSource: (id) => scalar("select public.ensure_youtube_source($1) as value", [id]),
    findTranscript: (id, language) =>
      row(
        `select id,text_content,content_hash,provenance,metadata,true as reused
      from public.transcripts where source_id=$1 and language=$2 and (expires_at is null or expires_at>now()) order by version limit 1`,
        [id, language],
      ),
    acquireTranscript: (...params) =>
      row("select * from public.acquire_youtube_transcript($1,$2,$3,$4,$5,$6)", params),
    reserve: (sourceId, transcriptId, model) =>
      row(
        `select * from public.reserve_generation($1,$2,'detailed_notes','en',$3,'detailed-notes-b3-v1',1,
      '{"temperature":0.2,"maxOutputTokens":8192,"outputLanguage":"en"}')`,
        [sourceId, transcriptId, model],
      ),
    claim: (id) => scalar("select public.claim_generation($1) as value", [id]),
    finish: (id, token, notes) =>
      scalar("select public.finish_generation($1,$2,$3::jsonb) as value", [
        id,
        token,
        JSON.stringify(notes),
      ]),
    fail: (id, token, code, retryable) =>
      scalar("select public.fail_generation($1,$2,$3,$4) as value", [id, token, code, retryable]),
    read: (videoId, contentId) =>
      row("select * from public.read_youtube_notes($1,$2)", [videoId, contentId]),
    job: (id) =>
      row(
        "select status,leased_until,available_at,last_error_code from public.generation_jobs where id=$1",
        [id],
      ),
  };
}
