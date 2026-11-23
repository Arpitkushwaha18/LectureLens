/* eslint-disable @typescript-eslint/no-explicit-any -- SQL RPC rows are dynamic by design */
import { PGlite } from "@electric-sql/pglite";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { NotesRepository, TranscriptRow } from "./notes.repository.js";
import type { ExtractionRepository } from "./transcript-extraction.repository.js";

/** Local, forward-only PostgreSQL for development when hosted migrations are
 * not ready. Initialization is lazy so importing this module (e.g. from tests)
 * never opens a second database or races another process for the same files. */
let instance: Promise<PGlite> | null = null;
function openDatabase(): Promise<PGlite> {
  if (!instance) instance = initialize();
  return instance;
}
async function initialize(): Promise<PGlite> {
  const directory = join(process.cwd(), ".cache", "youtube-local");
  await mkdir(directory, { recursive: true });
  const db = new PGlite(join(directory, "postgres"));
  const ready: any = await db.query(
    "select to_regprocedure('public.ensure_youtube_source(text)') as value",
  );
  if (!ready.rows?.[0]?.value) {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema public,auth to anon,authenticated,service_role;
      insert into auth.users values ('11111111-1111-4111-8111-111111111111');`);
    for (const name of [
      "20261121000100_b2_learning_foundation.sql",
      "20261121000200_b3_notes_workflow.sql",
      "20261121000300_apify_transcript_extraction.sql",
      "20261121000400_transcriptfetch_captions.sql",
      "20261122000500_source_limits_and_generation_fences.sql",
      "20261122000600_operator_recovery_and_evidence.sql",
      "20261122000700_generation_retry_lifecycle.sql",
      "20261122000900_automatic_captions.sql",
      "20261122001100_final_youtube_workflow.sql",
      "20261122001200_caption_retry_safety.sql",
    ]) {
      const sql = await readFile(
        new URL(`../../../supabase/migrations/${name}`, import.meta.url),
        "utf8",
      );
      await db.exec(`begin; ${sql} commit;`);
    }
  }
  const longLecture = await db.query<{ definition: string }>(
    "select pg_get_functiondef('public.finish_automatic_captions(uuid,uuid,text,jsonb)'::regprocedure) as definition",
  );
  if (!longLecture.rows[0]?.definition.includes("between 1 and 500000")) {
    const sql = await readFile(
      new URL(
        "../../../supabase/migrations/20261122001300_long_lecture_transcripts.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await db.exec(`begin; ${sql} commit;`);
  }
  const leases = await db.query<{ definition: string }>(
    "select pg_get_functiondef('public.record_automatic_caption_run(uuid,uuid,text)'::regprocedure) as definition",
  );
  if (!leases.rows[0]?.definition.includes("180 seconds")) {
    const sql = await readFile(
      new URL(
        "../../../supabase/migrations/20261122001400_long_lecture_leases.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await db.exec(`begin; ${sql} commit;`);
  }
  return db;
}

const scalar = async (sqlText: string, params: unknown[] = []) =>
  ((await (await openDatabase()).query(sqlText, params)) as any).rows[0]?.value as any;
const row = async (sqlText: string, params: unknown[] = []) =>
  (((await (await openDatabase()).query(sqlText, params)) as any).rows[0] ?? null) as any;

const parseTranscript = (value: any): TranscriptRow => ({
  id: value.id,
  text_content: value.text_content,
  content_hash: value.content_hash,
  provenance: value.provenance,
  reused: value.reused ?? true,
  metadata: value.metadata ?? undefined,
});

export const localNotesRepository: NotesRepository = {
  async ensureSource(videoId) {
    return (await scalar("select public.ensure_youtube_source($1) as value", [videoId])) as string;
  },
  async findTranscript(sourceId, language) {
    const r = await row(
      `select id,text_content,content_hash,provenance,metadata,true as reused
       from public.transcripts where source_id=$1 and language=$2 and (expires_at is null or expires_at>now()) order by version limit 1`,
      [sourceId, language],
    );
    return r ? parseTranscript(r) : null;
  },
  async findBestTranscript(sourceId) {
    const result = (await (
      await openDatabase()
    ).query(
      `select id,text_content,content_hash,provenance,metadata,language from public.transcripts
       where source_id=$1 and provenance='licensed_provider' and (expires_at is null or expires_at>now())
       order by version desc limit 50`,
      [sourceId],
    )) as any;
    const ranked = (result.rows ?? [])
      .filter((r: any) => r.metadata?.sourceMetadata?.source !== "audio")
      .sort(
        (a: any, b: any) =>
          Number(b.metadata?.captionSelection === "human") -
          Number(a.metadata?.captionSelection === "human"),
      );
    const selected = ranked[0];
    return selected ? parseTranscript({ ...selected, reused: true }) : null;
  },
  async acquireTranscript(sourceId, text, language, provenance, providerId, providerVersion) {
    const result = (await (
      await openDatabase()
    ).query("select * from public.acquire_youtube_transcript($1,$2,$3,$4,$5,$6)", [
      sourceId,
      text,
      language,
      provenance,
      providerId,
      providerVersion,
    ])) as any;
    return parseTranscript(result.rows[0]);
  },
  async reserve(sourceId, transcriptId, model) {
    const r = await row(
      `select * from public.reserve_generation($1,$2,'detailed_notes','en',$3,'study-notebook-v3-4',1,'{}')`,
      [sourceId, transcriptId, model],
    );
    return {
      content_id: r.content_id,
      job_id: r.job_id ?? null,
      disposition: r.disposition ?? "reserved",
    };
  },
  async claim(jobId) {
    return (await scalar("select public.claim_generation($1) as value", [jobId])) as string | null;
  },
  async finish(jobId, token, notes) {
    return (
      (await scalar("select public.finish_generation($1,$2,$3::jsonb) as value", [
        jobId,
        token,
        JSON.stringify(notes),
      ])) === true
    );
  },
  async fail(jobId, token, code, retryable, retryAfterSeconds = 60) {
    const r = await row(
      "select attempts from public.generation_jobs where id=$1 and lease_token=$2",
      [jobId, token],
    );
    if (!r) return false;
    return (
      (await scalar("select public.fail_generation_attempt($1,$2,$3,$4,$5) as value", [
        jobId,
        token,
        code,
        retryable,
        retryable ? retryAfterSeconds : 0,
      ])) === true
    );
  },
  async read(videoId, contentId) {
    const r = await row("select * from public.read_youtube_notes($1,$2)", [videoId, contentId]);
    return r
      ? {
          payload: r.payload,
          transcript_id: r.transcript_id,
          content_hash: r.content_hash,
          provenance: r.provenance,
        }
      : null;
  },
  async job(jobId) {
    return (await row(
      "select status,leased_until,available_at,last_error_code,failure_kind,request_may_have_been_sent from public.generation_jobs where id=$1",
      [jobId],
    )) as any;
  },
  async guardLocalGeneration() {},
};

export const localExtractionRepository: ExtractionRepository = {
  async reserve(sourceId, language) {
    const data = (await (
      await openDatabase()
    ).query(
      language === "auto"
        ? "select * from public.reserve_automatic_captions($1)"
        : "select * from public.reserve_transcript_extraction($1,$2)",
      language === "auto" ? [sourceId] : [sourceId, language],
    )) as any;
    const r = data.rows[0];
    return { disposition: r.disposition, token: r.token ?? null };
  },
  async recordRun(sourceId, language, token, runId) {
    const sql =
      language === "auto"
        ? "select public.record_automatic_caption_run($1,$2,$3) as value"
        : "select public.record_transcript_run($1,$2,$3,$4) as value";
    const params =
      language === "auto" ? [sourceId, token, runId] : [sourceId, language, token, runId];
    return (await scalar(sql, params)) === true;
  },
  async finish(sourceId, language, token, text, metadata) {
    const sql =
      language === "auto"
        ? "select public.finish_automatic_captions($1,$2,$3,$4::jsonb) as value"
        : "select public.finish_transcript_extraction($1,$2,$3,$4,$5::jsonb) as value";
    const params =
      language === "auto"
        ? [sourceId, token, text, JSON.stringify(metadata)]
        : [sourceId, language, token, text, JSON.stringify(metadata)];
    return (await scalar(sql, params)) === true;
  },
  async fail(sourceId, language, token, code) {
    const sql =
      language === "auto"
        ? "select public.fail_automatic_captions($1,$2,$3) as value"
        : "select public.fail_transcript_extraction($1,$2,$3,$4) as value";
    const params =
      language === "auto" ? [sourceId, token, code] : [sourceId, language, token, code];
    return (await scalar(sql, params)) === true;
  },
};
