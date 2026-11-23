import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { before, after, beforeEach, afterEach, describe, it } from "node:test";
import { createDatabase, embeddedRepository, A, fixtureNotes } from "./helpers/database.mjs";

let db, repo, source, transcript;
const video = "AbCdEf12_-3";
const hash = (text) => createHash("sha256").update(text).digest("hex");
const tables = ["learning_sources", "transcripts", "generated_content", "generation_jobs"];
async function rejected(sql, params = [], pattern = /permission denied/) {
  await db.exec("savepoint rejection");
  try {
    await assert.rejects(db.query(sql, params), pattern);
  } finally {
    await db.exec("rollback to savepoint rejection; release savepoint rejection");
  }
}
describe("B2/B3 actual SQL on embedded PostgreSQL; no live Supabase", () => {
  before(async () => {
    db = await createDatabase();
    repo = embeddedRepository(db);
  });
  after(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.exec("begin");
    source = await repo.ensureSource(video);
    transcript = await repo.acquireTranscript(
      source,
      "A technical transcript fixture.",
      "en",
      "manual",
      "youtube_show_transcript",
      "manual-v1",
    );
  });
  afterEach(async () => {
    await db.exec("rollback");
  });
  it("contains exactly four RLS-enabled resource tables and no auth trigger", async () => {
    const result = await db.query(
      "select relname,relrowsecurity from pg_class where relnamespace='public'::regnamespace and relkind='r' order by relname",
    );
    assert.deepEqual(
      result.rows.map((r) => r.relname),
      [...tables].sort(),
    );
    assert.ok(result.rows.every((r) => r.relrowsecurity));
    assert.equal(
      (
        await db.query(
          "select tgname from pg_trigger where tgrelid='auth.users'::regclass and not tgisinternal",
        )
      ).rows.length,
      0,
    );
  });
  it("reuses the canonical shared video ID", async () => {
    assert.equal(await repo.ensureSource(video), source);
    const rows = (
      await db.query(
        "select youtube_video_id,owner_id,canonical_identity from public.learning_sources",
      )
    ).rows;
    assert.deepEqual(rows, [
      {
        youtube_video_id: video,
        owner_id: null,
        canonical_identity: `https://www.youtube.com/watch?v=${video}`,
      },
    ]);
    await rejected(
      "insert into public.learning_sources(source_type,youtube_video_id,visibility,canonical_identity) select source_type,youtube_video_id,visibility,canonical_identity from public.learning_sources",
      [],
      /unique/,
    );
  });
  it("atomically reuses a transcript rather than replacing shared text", async () => {
    const second = await repo.acquireTranscript(
      source,
      "Another submission must not overwrite.",
      "en",
      "manual",
      "youtube_show_transcript",
      "manual-v1",
    );
    assert.equal(second.id, transcript.id);
    assert.equal(second.reused, true);
    assert.equal(second.content_hash, hash("A technical transcript fixture."));
    assert.equal(second.provenance, "manual");
    assert.equal(
      (await db.query("select count(*)::int as n from public.transcripts")).rows[0].n,
      1,
    );
  });
  it("rejects hash mismatch and immutable source/transcript configuration", async () => {
    await rejected(
      "update public.transcripts set text_content='overwrite' where id=$1",
      [transcript.id],
      /version/,
    );
    await rejected(
      "update public.learning_sources set owner_id=$1 where id=$2",
      [A, source],
      /immutable/,
    );
    await rejected(
      `insert into public.transcripts(source_id,text_content,language,content_hash,provenance,provider_id,provider_version,version)
      values($1,'different','en',$2,'manual','fixture','v1',2)`,
      [source, hash("wrong")],
      /hash/,
    );
  });
  it("creates a new transcript version only after expiry", async () => {
    await db.query("update public.transcripts set obtained_at=obtained_at where id=$1", [
      transcript.id,
    ]);
    // acquired_at cannot change; use an expired historical fixture separately.
    const other = await repo.ensureSource("ZbCdEf12_-3");
    await db.query(
      `insert into public.transcripts(source_id,text_content,language,content_hash,provenance,provider_id,provider_version,version,obtained_at,expires_at)
      values($1,'expired','en',$2,'manual','fixture','v1',1,now()-interval '2 days',now()-interval '1 day')`,
      [other, hash("expired")],
    );
    assert.equal(await repo.findTranscript(other, "en"), null);
    const next = await repo.acquireTranscript(other, "expired", "en", "manual", "fixture", "v1");
    assert.equal(next.reused, false);
    assert.equal(
      (await db.query("select version from public.transcripts where id=$1", [next.id])).rows[0]
        .version,
      2,
    );
  });
  it("reserves one active job and prevents direct duplicates", async () => {
    const first = await repo.reserve(source, transcript.id, "test-model");
    const second = await repo.reserve(source, transcript.id, "test-model");
    assert.equal(first.disposition, "reserved");
    assert.equal(second.disposition, "existing_job");
    assert.equal(first.job_id, second.job_id);
    await rejected(
      `insert into public.generation_jobs(generated_content_id,idempotency_key)
      select generated_content_id,idempotency_key from public.generation_jobs where id=$1`,
      [first.job_id],
      /unique/,
    );
    await rejected(
      `insert into public.generation_jobs(generated_content_id,idempotency_key) values($1,$2)`,
      [first.content_id, "0".repeat(64)],
      /idempotency/,
    );
  });
  for (const [label, sql] of [
    ["output", "'short_notes','en','test-model','detailed-notes-b3-v1',1"],
    ["language", "'detailed_notes','hi','test-model','detailed-notes-b3-v1',1"],
    ["model", "'detailed_notes','en','test-model-v2','detailed-notes-b3-v1',1"],
    ["prompt", "'detailed_notes','en','test-model','prompt-v2',1"],
    ["schema", "'detailed_notes','en','test-model','detailed-notes-b3-v1',2"],
  ])
    it(`includes ${label} in cache identity`, async () => {
      const first = await repo.reserve(source, transcript.id, "test-model");
      const other = (
        await db.query(
          `select * from public.reserve_generation($1,$2,${sql},'{"temperature":0.2,"maxOutputTokens":8192,"outputLanguage":"en"}')`,
          [source, transcript.id],
        )
      ).rows[0];
      assert.notEqual(first.content_id, other.content_id);
    });
  it("normalizes equivalent settings and separates different settings", async () => {
    const first = await repo.reserve(source, transcript.id, "test-model");
    const same = (
      await db.query(
        `select * from public.reserve_generation($1,$2,'detailed_notes',' EN ',' test-model ',' detailed-notes-b3-v1 ',1,
      '{"outputLanguage":"en","maxOutputTokens":8192.00,"temperature":0.20}')`,
        [source, transcript.id],
      )
    ).rows[0];
    assert.equal(first.content_id, same.content_id);
    const other = (
      await db.query(
        `select * from public.reserve_generation($1,$2,'detailed_notes','en','test-model','detailed-notes-b3-v1',1,'{}')`,
        [source, transcript.id],
      )
    ).rows[0];
    assert.notEqual(first.content_id, other.content_id);
  });
  it("claims a job only once, fences completion and reads only its video", async () => {
    const reservation = await repo.reserve(source, transcript.id, "test-model");
    const token = await repo.claim(reservation.job_id);
    assert.ok(token);
    assert.equal(await repo.claim(reservation.job_id), null);
    assert.equal(await repo.finish(reservation.job_id, A, fixtureNotes), false);
    assert.equal(await repo.finish(reservation.job_id, token, fixtureNotes), true);
    assert.equal(await repo.finish(reservation.job_id, token, fixtureNotes), false);
    assert.equal((await repo.reserve(source, transcript.id, "test-model")).disposition, "reused");
    assert.deepEqual((await repo.read(video, reservation.content_id)).payload, fixtureNotes);
    assert.equal(await repo.read("ZbCdEf12_-3", reservation.content_id), null);
  });
  it("handles bounded retryable failures with cooldown on the same job", async () => {
    const first = await repo.reserve(source, transcript.id, "test-model");
    for (let attempt = 1; attempt <= 3; attempt++) {
      const token = await repo.claim(first.job_id);
      assert.ok(token);
      assert.equal(await repo.fail(first.job_id, token, "GEMINI_QUOTA", true), true);
      assert.equal(await repo.claim(first.job_id), null);
      const again = await repo.reserve(source, transcript.id, "test-model");
      assert.equal(again.job_id, first.job_id);
      assert.equal(again.disposition, attempt === 3 ? "failed" : "existing_job");
      await db.query("update public.generation_jobs set available_at=now() where id=$1", [
        first.job_id,
      ]);
    }
    assert.equal(
      (await db.query("select count(*)::int as n from public.generation_jobs")).rows[0].n,
      1,
    );
  });
  it("does not reclaim uncertain running jobs after lease expiry", async () => {
    const first = await repo.reserve(source, transcript.id, "test-model");
    const token = await repo.claim(first.job_id);
    await db.query(
      "update public.generation_jobs set leased_until=now()-interval '1 second' where id=$1",
      [first.job_id],
    );
    assert.equal(await repo.claim(first.job_id), null);
    assert.equal(await repo.finish(first.job_id, token, fixtureNotes), false);
    assert.equal((await repo.reserve(source, transcript.id, "test-model")).job_id, first.job_id);
  });
  it("never permits direct student database reads/writes or RPCs", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set local role ${role}`);
      for (const table of tables) {
        for (const sql of [
          `select * from public.${table}`,
          `delete from public.${table}`,
          `update public.${table} set id=id`,
          `insert into public.${table}(id) values(gen_random_uuid())`,
        ])
          await rejected(sql);
      }
      for (const sql of [
        "select public.ensure_youtube_source('AbCdEf12_-3')",
        "select public.claim_generation($1)",
        "select public.finish_generation($1,$1,'{}')",
        "select public.fail_generation($1,$1,'fixture',true)",
        "select * from public.read_youtube_notes('AbCdEf12_-3',$1)",
        "select * from public.acquire_youtube_transcript($1,'x','en','manual','fixture','v1')",
        "select * from public.reserve_generation($1,$1,'detailed_notes','en','fixture','v1',1)",
      ]) {
        await rejected(sql, sql.includes("$1") ? [A] : []);
      }
      await db.exec("reset role");
    }
  });
  it("keeps documents private and excludes them from every YouTube RPC", async () => {
    const doc = (
      await db.query(
        `insert into public.learning_sources(source_type,content_hash,owner_id,canonical_identity)
      values('pdf',$1,$2,$3) returning id,visibility`,
        [hash("private document"), A, `sha256:${hash("private document")}`],
      )
    ).rows[0];
    assert.equal(doc.visibility, "private");
    await rejected(
      "select * from public.acquire_youtube_transcript($1,'private','en','manual','fixture','v1')",
      [doc.id],
      /Published YouTube/,
    );
    assert.equal(await repo.read(video, doc.id), null);
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set local role ${role}`);
      await rejected("select * from public.learning_sources where id=$1", [doc.id]);
      await db.exec("reset role");
    }
  });
});
