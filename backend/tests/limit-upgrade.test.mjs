import assert from "node:assert/strict";
import { it } from "node:test";
import { readFile } from "node:fs/promises";
import { createDatabase, embeddedRepository } from "./helpers/database.mjs";
it("local forward migration raises transcript limits and fences cross-model claims without touching existing resources", async () => {
  const db = await createDatabase(),
    repo = embeddedRepository(db);
  try {
    const source = await repo.ensureSource("AbCdEf12_-3");
    await db.exec(
      await readFile(
        new URL(
          "../../supabase/migrations/20261122000500_source_limits_and_generation_fences.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const text = "न".repeat(100000),
      transcript = await repo.acquireTranscript(source, text, "en", "manual", "fixture", "test");
    assert.equal(transcript.text_content, text);
    const first = await repo.reserve(source, transcript.id, "gemini-3.8-flash"),
      second = await repo.reserve(source, transcript.id, "gemini-2.5-flash");
    const token = await repo.claim(first.job_id);
    assert.ok(token);
    assert.equal(await repo.claim(second.job_id), null);
    await repo.fail(first.job_id, token, "GEMINI_TIMEOUT", false);
    assert.equal(await repo.claim(second.job_id), null);
    await assert.rejects(
      repo.acquireTranscript(
        await repo.ensureSource("IELMSD2kdmk"),
        text + "न",
        "en",
        "manual",
        "fixture",
        "test",
      ),
      /100,000/,
    );
  } finally {
    await db.close();
  }
});
