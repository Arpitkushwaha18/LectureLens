import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { WorkspaceCache } from "../dist/repositories/workspace-cache.js";
import { createWorkspaceService } from "../dist/services/workspace.service.js";
import { NotesGenerationError } from "../dist/modules/ai/gemini-notes.js";
import { retryDelay } from "../dist/modules/ai/generation-lifecycle.js";
import {
  recordGenerationEvidence,
  withGenerationEvidence,
} from "../dist/modules/ai/generation-evidence.js";
import { geminiClient } from "../dist/modules/ai/gemini-client.js";
import { createDatabase, embeddedRepository, fixtureNotes } from "./helpers/database.mjs";
import { DatabaseSync } from "node:sqlite";
const notebook = {
  schemaVersion: 2,
  title: "Requested notes",
  blocks: [{ type: "paragraph", text: "Atomicity means all changes succeed or roll back." }],
  limitations: [],
};
it("validated completion survives persistence failure and is automatically reused without replay", () =>
  usingCache(async (cache) => {
    const token = cache.claim("checkpoint", "source");
    cache.evidence("checkpoint", token, { kind: "dispatch" });
    cache.checkpoint("checkpoint", token, notebook);
    cache.fail("checkpoint", token, "GEMINI_UNCERTAIN", false);
    assert.deepEqual(cache.material("checkpoint"), notebook);
    assert.equal(cache.claim("checkpoint", "source"), null);
    assert.throws(() => cache.finish("checkpoint", token, notebook));
  }));
it("unknown failure stays fenced even if an erroneous caller marks it retryable", () =>
  usingCache(async (cache) => {
    const token = cache.claim("unknown", "source");
    cache.evidence("unknown", token, { kind: "dispatch" });
    cache.fail("unknown", token, "UNKNOWN_PROVIDER_FAILURE", true);
    assert.equal(cache.retrySafe("unknown"), false);
    assert.throws(() => cache.claim("unknown", "source"));
    assert.throws(() => cache.claim("another-model", "source"));
  }));
async function usingCache(work) {
  const directory = await mkdtemp(join(tmpdir(), "ll-retry-"));
  const cache = new WorkspaceCache(directory);
  try {
    await work(cache, directory);
  } finally {
    cache.close();
    await rm(directory, { recursive: true, force: true });
  }
}
it("definitive failed attempts retry with fresh tokens, preserve audit/error history and do not poison cache", () =>
  usingCache(async (cache) => {
    const first = cache.claim("job", "source");
    cache.evidence("job", first, { kind: "dispatch" });
    cache.evidence("job", first, { kind: "response", httpStatus: 503 });
    cache.fail("job", first, "GEMINI_INVALID_OUTPUT", false);
    assert.equal(cache.material("job"), null);
    const next = cache.claim("job", "source");
    assert.notEqual(first, next);
    assert.throws(() => cache.finish("job", first, notebook));
    cache.fail("job", first, "GEMINI_UNCERTAIN", false);
    cache.finish("job", next, notebook);
    assert.deepEqual(cache.material("job"), notebook);
    assert.equal(cache.claim("job", "source"), null);
    assert.ok(
      cache
        .inspectJob("job")
        .audit.some(
          (e) => e.kind === "failure" && e.details.classification === "GEMINI_INVALID_OUTPUT",
        ),
    );
  }));
it("cancelled-before-send attempts retry; cancellation after dispatch is rejected", () =>
  usingCache(async (cache) => {
    const token = cache.claim("cancel", "source");
    cache.cancelBeforeSend("cancel", token);
    const fresh = cache.claim("cancel", "source");
    assert.notEqual(fresh, token);
    cache.evidence("cancel", fresh, { kind: "dispatch" });
    assert.throws(() => cache.cancelBeforeSend("cancel", fresh));
    cache.fail("cancel", fresh, "GEMINI_UNCERTAIN", false);
    assert.throws(() => cache.claim("new-model", "source"));
    assert.ok(cache.claim("different-source", "unrelated"));
  }));
it("429 respects Retry-After and jittered cooldown; exhausted retry cycles never permanently lock definitive failures", () =>
  usingCache(async (cache) => {
    const old = Date.now;
    let now = old();
    Date.now = () => now;
    try {
      for (let i = 0; i < 5; i++) {
        const token = cache.claim("quota", "source");
        assert.ok(token);
        cache.fail("quota", token, "GEMINI_QUOTA", true, 180);
        assert.equal(cache.claim("quota", "source"), null);
        const wait = cache.retryAfter("quota");
        assert.ok(wait >= 180);
        now += wait * 1000;
      }
      assert.equal(
        retryDelay(2, 1, () => 0),
        120,
      );
      assert.equal(
        retryDelay(2, 1, () => 1),
        150,
      );
      assert.equal(
        retryDelay(3, 900, () => 1),
        900,
      );
    } finally {
      Date.now = old;
    }
  }));
it("401 is not automatically replayed, releases the active slot, and unrelated sources proceed", () =>
  usingCache(async (cache) => {
    let calls = 0;
    const service = createWorkspaceService({
      cache: () => cache,
      extract: async () => ({
        kind: "pdf",
        text: "Atomicity source content.",
        warnings: [],
        name: "a.pdf",
      }),
      gemini: () => ({
        model: "test",
        generate: async () => {
          calls++;
          throw new NotesGenerationError(
            "GEMINI_CREDENTIALS",
            "Private configuration details",
            false,
            503,
          );
        },
      }),
    });
    await assert.rejects(
      service(
        { sourceType: "pdf", outputTypes: ["detailed_notes"] },
        { buffer: Buffer.from("pdf"), originalname: "a.pdf" },
        () => {},
      ),
      (e) => e.code === "GEMINI_CREDENTIALS" && !e.retryable,
    );
    assert.equal(calls, 1);
    assert.ok(cache.claim("unrelated", "unrelated-source"));
  }));
it("Retry keeps output settings, reuses successful outputs and generates only missing notes", () =>
  usingCache(async (cache) => {
    let fail = true;
    const calls = [];
    const service = createWorkspaceService({
      cache: () => cache,
      extract: async () => ({
        kind: "pdf",
        text: "Atomicity source content.",
        warnings: [],
        name: "a.pdf",
      }),
      gemini: () => ({
        model: "test",
        generate: async (text, type) => {
          calls.push(type);
          if (type === "short_notes" && fail) {
            fail = false;
            throw new NotesGenerationError("GEMINI_INVALID_OUTPUT", "Invalid result");
          }
          return { ...notebook, title: type };
        },
      }),
    });
    const request = { sourceType: "pdf", outputTypes: ["detailed_notes", "short_notes"] },
      file = { buffer: Buffer.from("pdf"), originalname: "a.pdf" };
    await assert.rejects(service(request, file, () => {}));
    const result = await service(request, file, () => {});
    assert.equal(result.status, "ready");
    assert.deepEqual(calls, ["detailed_notes", "short_notes", "short_notes"]);
    assert.equal(result.materials[0].cached, true);
    assert.equal(result.materials[1].cached, false);
    assert.equal(result.materials[1].notebook.title, "short_notes");
  }));
it("concurrent duplicate requests share one active attempt, while a different source can proceed", () =>
  usingCache(async (cache) => {
    let release;
    const held = new Promise((r) => (release = r));
    let calls = 0;
    const service = createWorkspaceService({
      cache: () => cache,
      extract: async (bytes, name) => ({
        kind: "pdf",
        text: `Source ${bytes.toString()} atomicity details.`,
        name,
        warnings: [],
      }),
      gemini: () => ({
        model: "test",
        generate: async () => {
          calls++;
          await recordGenerationEvidence({ kind: "dispatch" });
          await held;
          return notebook;
        },
      }),
    });
    const options = { sourceType: "pdf", outputTypes: ["detailed_notes"] };
    const first = service(
      options,
      { buffer: Buffer.from("one"), originalname: "one.pdf" },
      () => {},
    );
    while (!calls) await Promise.resolve();
    const duplicate = await service(
      options,
      { buffer: Buffer.from("one"), originalname: "one.pdf" },
      () => {},
    );
    assert.equal(duplicate.status, "pending");
    assert.equal(calls, 1);
    const other = service(
      options,
      { buffer: Buffer.from("two"), originalname: "two.pdf" },
      () => {},
    );
    while (calls < 2) await Promise.resolve();
    release();
    assert.equal((await first).status, "ready");
    assert.equal((await other).status, "ready");
    assert.equal(calls, 2);
  }));
it("legacy operation identity is backfilled by exact hash proof without releasing an uncertain request or blocking unrelated work", () =>
  usingCache(async (cache, directory) => {
    const source = {
      kind: "pdf",
      name: "lecture.pdf",
      text: "Preserved legacy lecture content.",
      warnings: [],
    };
    cache.saveExtraction("legacy-source", source);
    const key = createHash("sha256")
      .update(
        JSON.stringify({
          source: source.kind,
          text: source.text,
          outputType: "detailed_notes",
          model: "gemini-3.8-flash",
          prompt: "study-notebook-v2-1",
          schema: 2,
        }),
      )
      .digest("hex");
    const db = new DatabaseSync(join(directory, "workspace.sqlite"));
    db.prepare(
      "insert into material_jobs(identity,status,attempts,token,deadline,error_code) values (?,'running',2,'legacy-token',?,'GEMINI_TEMPORARY')",
    ).run(key, Date.now() - 1);
    db.close();
    const reopened = new WorkspaceCache(directory);
    try {
      const job = reopened.inspectJob(key);
      assert.ok(job.operation);
      assert.equal(job.status, "running");
      assert.equal(job.requestMayHaveBeenSent, "unknown");
      assert.throws(() => reopened.claim("changed-model", job.operation));
      assert.ok(reopened.claim("other-source", "different-operation"));
      assert.ok(
        reopened.inspectJob(key).audit.some((e) => e.kind === "legacy_identity_backfilled"),
      );
      assert.equal(reopened.inspectJob(key).status, "running");
    } finally {
      reopened.close();
    }
  }));
it("transport DNS failure is proven not-sent and safely retryable; no real HTTP call is made", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Object.assign(new Error("DNS failure"), { cause: { code: "ENOTFOUND" } });
  };
  const evidence = [];
  try {
    await assert.rejects(
      withGenerationEvidence(
        (e) => evidence.push(e),
        () =>
          geminiClient("test-key").models.generateContent({
            model: "test-model",
            contents: "Source text",
          }),
      ),
      (e) => e.code === "GENERATION_NOT_SENT" && e.retryable,
    );
    assert.equal(evidence.at(-1).kind, "not_sent");
  } finally {
    globalThis.fetch = original;
  }
});
it("parser/model changes cannot bypass a legacy fence for the same file, while an unrelated file generates normally", () =>
  usingCache(async (cache, directory) => {
    const bytes = Buffer.from("Original PDF file bytes"),
      hash = createHash("sha256").update(bytes).digest("hex"),
      source = { kind: "pdf", name: "lecture.pdf", text: "Old parser text.", warnings: [] };
    cache.saveExtraction(`pdf:parser-v1:${hash}`, source);
    const key = createHash("sha256")
      .update(
        JSON.stringify({
          source: source.kind,
          text: source.text,
          outputType: "detailed_notes",
          model: "gemini-3.8-flash",
          prompt: "study-notebook-v2-1",
          schema: 2,
        }),
      )
      .digest("hex");
    const db = new DatabaseSync(join(directory, "workspace.sqlite"));
    db.prepare(
      "insert into material_jobs(identity,status,attempts,token,deadline,error_code) values (?,'running',2,'legacy-token',?,'GEMINI_TEMPORARY')",
    ).run(key, Date.now() - 1);
    db.close();
    const reopened = new WorkspaceCache(directory);
    let calls = 0;
    const service = createWorkspaceService({
      cache: () => reopened,
      extract: async () => ({
        kind: "pdf",
        name: "lecture.pdf",
        text: "Updated parser text for the same source.",
        warnings: [],
      }),
      gemini: () => ({
        model: "gemini-2.5-flash",
        generate: async () => {
          calls++;
          return notebook;
        },
      }),
    });
    try {
      await assert.rejects(
        service(
          { sourceType: "pdf", outputTypes: ["detailed_notes"] },
          { buffer: bytes, originalname: "lecture.pdf" },
          () => {},
        ),
        (e) => e.code === "JOB_RECOVERY_REQUIRED",
      );
      assert.equal(calls, 0);
      const unrelated = await service(
        { sourceType: "pdf", outputTypes: ["detailed_notes"] },
        { buffer: Buffer.from("Unrelated file bytes"), originalname: "other.pdf" },
        () => {},
      );
      assert.equal(unrelated.status, "ready");
      assert.equal(calls, 1);
      assert.equal(reopened.inspectJob(key).status, "running");
    } finally {
      reopened.close();
    }
  }));
it("SQL cooldown honors Retry-After; 401 and pre-send cancellation release reservations without endless replay", async () => {
  const db = await createDatabase(7),
    repo = embeddedRepository(db);
  try {
    const source = await repo.ensureSource("AbCdEf12_-3"),
      text = await repo.acquireTranscript(
        source,
        "Source for retry policy.",
        "en",
        "manual",
        "test",
        "1",
      ),
      job = await repo.reserve(source, text.id, "quota-model"),
      token = await repo.claim(job.job_id);
    await db.query("select public.fail_generation_attempt($1,$2,'GEMINI_QUOTA',true,180)", [
      job.job_id,
      token,
    ]);
    const waiting = await repo.job(job.job_id);
    assert.ok(Date.parse(waiting.available_at) - Date.now() > 178000);
    assert.equal(await repo.claim(job.job_id), null);
    assert.equal((await repo.reserve(source, text.id, "quota-model")).job_id, job.job_id);
    const authJob = await repo.reserve(source, text.id, "auth-model"),
      authToken = await repo.claim(authJob.job_id);
    await repo.fail(authJob.job_id, authToken, "GEMINI_CREDENTIALS", false);
    assert.equal((await repo.job(authJob.job_id)).status, "failed");
    assert.notEqual((await repo.reserve(source, text.id, "auth-model")).job_id, authJob.job_id);
    const cancel = await repo.reserve(source, text.id, "cancel-model"),
      cancelToken = await repo.claim(cancel.job_id);
    await db.query(
      "update public.generation_jobs set status='cancelled',finished_at=now(),lease_owner=null,lease_token=null,leased_until=null,last_error_code='GENERATION_CANCELLED_BEFORE_SEND' where id=$1",
      [cancel.job_id],
    );
    const retried = await repo.reserve(source, text.id, "cancel-model");
    assert.notEqual(retried.job_id, cancel.job_id);
    assert.equal(await repo.finish(cancel.job_id, cancelToken, fixtureNotes), false);
  } finally {
    await db.close();
  }
});
it("latest Supabase lifecycle automatically supersedes definitive failures, preserves history, scopes uncertainty and fences stale workers", async () => {
  const db = await createDatabase(7),
    repo = embeddedRepository(db);
  try {
    const source = await repo.ensureSource("AbCdEf12_-3"),
      transcript = await repo.acquireTranscript(
        source,
        "Atomicity source content.",
        "en",
        "manual",
        "test",
        "1",
      );
    const a = await repo.reserve(source, transcript.id, "test-model"),
      token = await repo.claim(a.job_id);
    assert.equal(await repo.fail(a.job_id, token, "GEMINI_INVALID_OUTPUT", false), true);
    const b = await repo.reserve(source, transcript.id, "test-model");
    assert.notEqual(a.job_id, b.job_id);
    assert.equal((await repo.job(a.job_id)).status, "failed");
    const fresh = await repo.claim(b.job_id);
    assert.ok(fresh);
    assert.equal(await repo.finish(a.job_id, token, fixtureNotes), false);
    assert.equal(await repo.fail(a.job_id, token, "GEMINI_UNCERTAIN", false), false);
    assert.equal(await repo.finish(b.job_id, fresh, fixtureNotes), true);
    assert.equal((await repo.reserve(source, transcript.id, "test-model")).disposition, "reused");
    const c = await repo.reserve(source, transcript.id, "uncertain-model"),
      uncertain = await repo.claim(c.job_id);
    await db.query("select public.record_generation_evidence($1,$2,$3::jsonb)", [
      c.job_id,
      uncertain,
      JSON.stringify({ kind: "dispatch" }),
    ]);
    await repo.fail(c.job_id, uncertain, "GEMINI_TIMEOUT", false);
    const changed = await repo.reserve(source, transcript.id, "changed-model");
    assert.equal(changed.disposition, "failed");
    assert.equal(changed.job_id, c.job_id);
    const other = await repo.ensureSource("BcDeFg23_-4"),
      otherText = await repo.acquireTranscript(
        other,
        "Other lecture source.",
        "en",
        "manual",
        "test",
        "1",
      ),
      otherJob = await repo.reserve(other, otherText.id, "test-model");
    assert.ok(await repo.claim(otherJob.job_id));
    const audit = await db.query("select kind from ll_private.generation_audit where job_id=$1", [
      a.job_id,
    ]);
    assert.ok(audit.rows.some((e) => e.kind === "definitive_attempt_superseded"));
    await assert.rejects(
      db.exec(
        "set role authenticated; select public.reconcile_generation('00000000-0000-4000-8000-000000000000')",
      ),
      /permission denied/,
    );
  } finally {
    await db.close();
  }
});
