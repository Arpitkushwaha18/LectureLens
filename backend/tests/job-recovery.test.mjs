import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import { WorkspaceCache } from "../dist/repositories/workspace-cache.js";
import { createOperatorRouter } from "../dist/routes/operator.routes.js";
import { createDatabase, embeddedRepository, fixtureNotes } from "./helpers/database.mjs";
const notebook = {
  schemaVersion: 2,
  title: "Recovered",
  blocks: [{ type: "paragraph", text: "Real source grounded notes." }],
  limitations: [],
};
const input = (cache, key, action, extra = {}) => ({
  revision: cache.inspectJob(key).revision,
  action,
  reason: "Operator reviewed the stored request evidence.",
  ...extra,
});
async function withCache(work) {
  const directory = await mkdtemp(join(tmpdir(), "ll-recovery-")),
    cache = new WorkspaceCache(directory);
  try {
    await work(cache);
  } finally {
    cache.close();
    await rm(directory, { recursive: true, force: true });
  }
}
it("uncertain requests remain fenced across model changes and cannot be resolved by elapsed time", () =>
  withCache(async (cache) => {
    const token = cache.claim("old", "source", { model: "old", sourceId: "doc" });
    cache.evidence("old", token, { kind: "dispatch" });
    cache.fail("old", token, "GEMINI_TIMEOUT", false);
    assert.equal(cache.inspectJob("old").recoverySafe, false);
    assert.throws(() => cache.claim("new", "source"));
    assert.throws(() =>
      cache.recoverJob("old", input(cache, "old", "confirm_not_sent"), "operator"),
    );
    assert.throws(() =>
      cache.recoverJob("old", input(cache, "old", "resolve_abandoned"), "operator"),
    );
    assert.throws(() => cache.recoverJob("old", input(cache, "old", "recover_output"), "operator"));
  }));
it("definitive rejection resolves with its actual classification and explicit retry approval; old token is fenced", () =>
  withCache(async (cache) => {
    const token = cache.claim("request", "source");
    cache.evidence("request", token, { kind: "dispatch" });
    cache.evidence("request", token, {
      kind: "response",
      httpStatus: 400,
      requestId: "test-request-123",
    });
    cache.fail("request", token, "GEMINI_REQUEST_INVALID", false);
    const resolved = cache.recoverJob(
      "request",
      input(cache, "request", "confirm_rejected"),
      "operator",
    );
    assert.equal(resolved.lastError, "GEMINI_REQUEST_INVALID");
    assert.equal(resolved.requestId, "test-request-123");
    const next = cache.claim("request", "source");
    assert.ok(next);
    assert.notEqual(next, token);
    assert.throws(() => cache.finish("request", token, notebook));
    assert.throws(() => cache.evidence("request", token, { kind: "response", httpStatus: 200 }));
    cache.fail("request", next, "GEMINI_TIMEOUT", false);
    assert.throws(() => cache.claim("new-model", "source"));
  }));
it("validated completion is recovered/reused without another generation and stale completion cannot overwrite it", () =>
  withCache(async (cache) => {
    const token = cache.claim("completed", "source");
    cache.evidence("completed", token, { kind: "dispatch" });
    cache.checkpoint("completed", token, notebook);
    const stale = input(cache, "completed", "recover_output");
    cache.recoverJob("completed", stale, "operator");
    assert.deepEqual(cache.material("completed"), notebook);
    assert.deepEqual(cache.recoveredMaterial("source"), notebook);
    assert.equal(cache.claim("completed", "source"), null);
    assert.throws(() => cache.finish("completed", token, { ...notebook, title: "Stale" }));
    assert.throws(() => cache.recoverJob("completed", stale, "operator"));
  }));
it("a retired endpoint HTTP 410 can be recovered from its recorded rejection, but a timeout cannot", () =>
  withCache(async (cache) => {
    const token = cache.claim("retired", "source", {
      model: "freegg:gpt-6.1-sol",
      sourceId: "lecture",
    });
    cache.evidence("retired", token, { kind: "dispatch" });
    cache.evidence("retired", token, { kind: "response", httpStatus: 410 });
    cache.fail("retired", token, "GEMINI_UNCERTAIN", false);
    assert.equal(cache.inspectJob("retired").recoverySafe, true);
    const recovered = cache.recoverJob(
      "retired",
      input(cache, "retired", "confirm_rejected"),
      "operator",
    );
    assert.equal(recovered.lastError, "GENERATION_ENDPOINT_RETIRED");
    assert.ok(recovered.audit.some((event) => event.kind === "confirm_rejected"));
    const next = cache.claim("retired", "source");
    assert.ok(next);
    cache.evidence("retired", next, { kind: "dispatch" });
    cache.fail("retired", next, "GEMINI_TIMEOUT", false);
    assert.equal(cache.inspectJob("retired").recoverySafe, false);
    assert.throws(() =>
      cache.recoverJob("retired", input(cache, "retired", "confirm_rejected"), "operator"),
    );
  }));
it("active workers cannot be abandoned even by an operator; audited abandonment requires explicit acknowledgment", () =>
  withCache(async (cache) => {
    const token = cache.claim("active", "source");
    cache.evidence("active", token, { kind: "dispatch" });
    assert.throws(() =>
      cache.recoverJob(
        "active",
        input(cache, "active", "resolve_abandoned", { acknowledgePossibleCharge: true }),
        "operator",
      ),
    );
    cache.fail("active", token, "GEMINI_TIMEOUT", false);
    const result = cache.recoverJob(
      "active",
      input(cache, "active", "resolve_abandoned", { acknowledgePossibleCharge: true }),
      "operator",
    );
    assert.equal(result.lastError, "OPERATOR_ABANDONED");
    assert.ok(result.audit.some((event) => event.kind === "resolve_abandoned"));
    assert.throws(() => cache.claim("new-model", "source"));
    cache.recoverJob("active", input(cache, "active", "approve_retry"), "operator");
    assert.ok(cache.claim("new-model", "source"));
  }));
it("students, absent credentials and wrong tokens cannot inspect or recover jobs", () =>
  withCache(async (cache) => {
    cache.claim("active", "source");
    const token = "x".repeat(40),
      app = express();
    app.use(express.json());
    app.use(
      "/operator",
      createOperatorRouter(
        () => cache,
        () => token,
      ),
    );
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      for (const authorization of [undefined, "Bearer student"]) {
        const headers = authorization ? { authorization } : {};
        assert.equal((await fetch(base + "/operator/jobs", { headers })).status, 403);
        assert.equal(
          (
            await fetch(base + "/operator/jobs/active/recover", {
              method: "POST",
              headers: { ...headers, "content-type": "application/json" },
              body: JSON.stringify(
                input(cache, "active", "resolve_abandoned", { acknowledgePossibleCharge: true }),
              ),
            })
          ).status,
          403,
        );
      }
      const response = await fetch(base + "/operator/jobs", {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).data[0].jobId, "active");
      assert.equal(cache.inspectJob("active").status, "running");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }));
it("local Supabase recovery migration preserves jobs, records evidence and fences stale tokens", async () => {
  const db = await createDatabase(),
    repo = embeddedRepository(db);
  try {
    for (const migration of [
      "20261122000500_source_limits_and_generation_fences.sql",
      "20261122000600_operator_recovery_and_evidence.sql",
    ])
      await db.exec(
        await readFile(new URL("../../supabase/migrations/" + migration, import.meta.url), "utf8"),
      );
    const source = await repo.ensureSource("AbCdEf12_-3"),
      transcript = await repo.acquireTranscript(
        source,
        "Source fixture text.",
        "en",
        "manual",
        "test",
        "1",
      ),
      reserved = await repo.reserve(source, transcript.id, "model"),
      token = await repo.claim(reserved.job_id);
    await db.query("select public.record_generation_evidence($1,$2,$3::jsonb,$4::jsonb)", [
      reserved.job_id,
      token,
      JSON.stringify({ kind: "validated" }),
      JSON.stringify(fixtureNotes),
    ]);
    const revision = (
      await db.query("select updated_at from public.generation_jobs where id=$1", [reserved.job_id])
    ).rows[0].updated_at;
    await db.query(
      "select public.operator_recover_generation($1,$2,'recover_output',$3,'operator-test',false)",
      [
        reserved.job_id,
        new Date(revision).toISOString(),
        "Operator verified the persisted completion checkpoint.",
      ],
    );
    assert.equal(await repo.finish(reserved.job_id, token, fixtureNotes), false);
    assert.ok(await repo.read("AbCdEf12_-3", reserved.content_id));
    const rows = await db.query("select kind from ll_private.generation_audit where job_id=$1", [
      reserved.job_id,
    ]);
    assert.ok(rows.rows.some((row) => row.kind === "recover_output"));
    await assert.rejects(
      db.exec(
        "set role anon; select public.operator_recover_generation('00000000-0000-4000-8000-000000000000',now()::text,'resolve_abandoned','Student must not recover jobs','student-token',true)",
      ),
      /permission denied/,
    );
  } finally {
    await db.close();
  }
});
