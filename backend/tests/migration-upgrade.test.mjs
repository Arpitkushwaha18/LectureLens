import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";
import { createDatabase, embeddedRepository, fixtureNotes } from "./helpers/database.mjs";

it("pending 003/004 upgrade an existing 001/002 database without changing transcripts, notes or reservations", async () => {
  const db = await createDatabase(2);
  try {
    const repo = embeddedRepository(db);
    const source = await repo.ensureSource("AbCdEf12_-3");
    const transcript = await repo.acquireTranscript(
      source,
      "Existing shared transcript",
      "en",
      "manual",
      "fixture",
      "v1",
    );
    const reservation = await repo.reserve(source, transcript.id, "fixture-model");
    const token = await repo.claim(reservation.job_id);
    const snapshot = async () =>
      (
        await db.query(
          "select jsonb_build_object('sources',(select jsonb_agg(s) from public.learning_sources s),'transcripts',(select jsonb_agg(t) from public.transcripts t),'content',(select jsonb_agg(c) from public.generated_content c),'jobs',(select jsonb_agg(j) from public.generation_jobs j)) as state",
        )
      ).rows[0].state;
    const before = await snapshot();
    for (const name of [
      "20261121000300_apify_transcript_extraction.sql",
      "20261121000400_transcriptfetch_captions.sql",
    ]) {
      const sql = await readFile(
        new URL(`../../supabase/migrations/${name}`, import.meta.url),
        "utf8",
      );
      await db.exec(`begin; ${sql} commit;`);
    }
    assert.deepEqual(await snapshot(), before);
    assert.equal(await repo.finish(reservation.job_id, token, fixtureNotes), true);
    assert.equal(
      (await repo.read("AbCdEf12_-3", reservation.content_id)).payload.title,
      fixtureNotes.title,
    );
    assert.equal(
      (await db.query("select * from public.reserve_transcript_extraction($1,'en')", [source]))
        .rows[0].disposition,
      "cached",
    );
  } finally {
    await db.close();
  }
});
