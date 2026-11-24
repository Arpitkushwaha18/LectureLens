import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StudyLibrary } from "../dist/repositories/study-library.js";
import { PostgresGenerationStore } from "../dist/repositories/generation-store.js";

const notebook = {
  schemaVersion: 2,
  title: "Durable notes",
  limitations: [],
  blocks: [
    {
      type: "paragraph",
      text: "Validated checkpoint survives restart without another paid request.",
    },
  ],
};
it("real PostgreSQL lifecycle fences unknown dispatch, recovers checkpoints, bounds retries and denies anonymous RPCs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lecturelens-generation-"));
  let library = new StudyLibrary("local_postgres", directory);
  const createStore = () =>
    new PostgresGenerationStore((name, params) => library.rpc(name, params));
  try {
    await library.ready();
    let jobs = createStore();
    const key = "a".repeat(64),
      op = "b".repeat(64);
    const claims = await Promise.all([jobs.claim(key, op, {}), jobs.claim(key, op, {})]);
    assert.equal(claims.filter(Boolean).length, 1);
    const token = claims.find(Boolean);
    await jobs.evidence(key, token, { kind: "dispatch" });
    const db = await library.db();
    await db.query(
      "update ll_private.study_generation_jobs set deadline=now()-interval '1 minute' where identity=$1",
      [key],
    );
    assert.equal((await jobs.checkState(key, op)).safe, false);
    assert.equal(await jobs.claim("c".repeat(64), op, {}), null);
    assert.equal(await jobs.material(key), null);
    await jobs.evidence(key, token, { kind: "response", httpStatus: 200 });
    await jobs.checkpoint(key, token, notebook);
    await jobs.finish(key, token, notebook);
    assert.deepEqual(await jobs.material(key), notebook);
    await assert.rejects(() => jobs.evidence("9".repeat(64), token, { kind: "dispatch" }));
    await assert.rejects(() => jobs.cancelBeforeSend(key, token));
    await assert.rejects(() =>
      db.transaction(async (tx) => {
        await tx.exec("set local role anon");
        await tx.query("select public.study_generation($1,$2,'read',null,'{}')", [key, op]);
      }),
    );
    const saved = "d".repeat(64),
      savedOp = "e".repeat(64);
    const savedToken = await jobs.claim(saved, savedOp, {});
    await jobs.evidence(saved, savedToken, { kind: "dispatch" });
    await jobs.checkpoint(saved, savedToken, notebook);
    await db.query(
      "update ll_private.study_generation_jobs set deadline=now()-interval '1 minute' where identity=$1",
      [saved],
    );
    await library.close();
    library = new StudyLibrary("local_postgres", directory);
    jobs = createStore();
    assert.deepEqual(await jobs.material(saved), notebook);
    assert.equal(await jobs.claim(saved, savedOp, {}), null);
    const retry = "f".repeat(64);
    for (let i = 0; i < 3; i++) {
      const lease = await jobs.claim(retry, retry, {});
      assert.ok(lease);
      await jobs.evidence(retry, lease, { kind: "dispatch" });
      await jobs.evidence(retry, lease, { kind: "response", httpStatus: 429 });
      await jobs.fail(retry, lease, "GEMINI_QUOTA", true, 1);
      assert.equal(await jobs.retrySafe(retry), true);
      assert.equal(await jobs.claim(retry, retry, {}), null);
      await (
        await library.db()
      ).query("update ll_private.study_generation_jobs set retry_at=now() where identity=$1", [
        retry,
      ]);
    }
    await assert.rejects(
      () => jobs.claim(retry, retry, {}),
      (error) => error.code === "GENERATION_RETRY_LIMIT",
    );
  } finally {
    await library.close();
    await rm(directory, { recursive: true, force: true });
  }
});
