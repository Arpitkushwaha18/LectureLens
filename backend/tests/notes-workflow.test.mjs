import assert from "node:assert/strict";
import { before, after, beforeEach, afterEach, describe, it } from "node:test";
import { createDatabase, embeddedRepository, fixtureNotes } from "./helpers/database.mjs";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.SUPABASE_URL = "";
process.env.SUPABASE_SECRET_KEY = "";
process.env.GEMINI_API_KEY = "";
process.env.GEMINI_MODEL = "";
process.env.TRANSCRIPTFETCH_API_KEY = "";
const { createNotesService } = await import("../dist/services/notes.service.js");
const { NotesGenerationError } = await import("../dist/modules/ai/gemini-notes.js");
const { createApp } = await import("../dist/app.js");
const url = "https://youtu.be/AbCdEf12_-3";
const manual = {
  url,
  transcript: "Transactions make database updates atomic.",
  shareConsent: true,
};
let db, repo;
describe("B3 orchestration with real embedded SQL and mocked Gemini (not hosted integration)", () => {
  before(async () => {
    db = await createDatabase(7);
    repo = embeddedRepository(db);
  });
  after(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.exec("begin");
  });
  afterEach(async () => {
    await db.exec("rollback");
  });
  it("returns provider unavailable and asks for a pasted transcript without Gemini", async () => {
    const service = createNotesService(repo, () => {
      throw new Error("Must not call Gemini");
    });
    const result = await service({ url });
    assert.equal(result.status, "transcript_required");
    assert.equal(result.provider.status, "unavailable");
    assert.equal(result.provider.reason, "provider_not_configured");
  });
  it("saves manual transcript, generates a cache miss, then reuses notes without a second Gemini call", async () => {
    let calls = 0;
    const service = createNotesService(repo, () => ({
      model: "test-model",
      generate: async () => {
        calls++;
        return fixtureNotes;
      },
    }));
    const first = await service(manual);
    assert.equal(first.status, "ready");
    assert.equal(first.cached, false);
    assert.equal(first.transcript.provenance, "manual");
    assert.equal(first.transcript.reused, false);
    assert.equal(first.transcript.text, undefined);
    const second = await service({ url: "https://www.youtube.com/watch?v=AbCdEf12_-3&t=10" });
    assert.equal(second.cached, true);
    assert.equal(second.transcript.reused, true);
    assert.equal(calls, 1);
    assert.equal(first.contentId, second.contentId);
  });
  it("checks missing generation configuration before extracting paid captions", async () => {
    let calls = 0;
    const service = createNotesService(
      repo,
      () => ({ model: "test-model", generate: async () => fixtureNotes }),
      {
        acquire: async () => {
          calls++;
          throw new Error("Must not spend");
        },
      },
      () => {
        throw new NotesGenerationError("GEMINI_NOT_CONFIGURED", "Set GEMINI_API_KEY", false, 503);
      },
    );
    await assert.rejects(service({ url }), (e) => e.code === "GEMINI_NOT_CONFIGURED");
    assert.equal(calls, 0);
    assert.equal(
      (await db.query("select count(*)::int n from ll_private.transcript_extractions")).rows[0].n,
      0,
    );
  });
  it("validates URL, limits and sharing consent before database work", async () => {
    const service = createNotesService(repo);
    for (const input of [
      { url: "https://evil.invalid" },
      { ...manual, shareConsent: false },
      { ...manual, transcript: "x".repeat(100001) },
      { ...manual, transcript: "\u0000" },
    ])
      await assert.rejects(service(input));
    assert.equal(
      (await db.query("select count(*)::int as n from public.learning_sources")).rows[0].n,
      0,
    );
  });
  it("rejects mismatched provider identity instead of publishing text", async () => {
    const service = createNotesService(
      repo,
      () => {
        throw new Error("Must not call");
      },
      {
        acquire: async () => ({
          schemaVersion: 1,
          status: "available",
          transcript: {
            text: "fixture",
            metadata: {
              schemaVersion: 1,
              videoId: "ZbCdEf12_-3",
              language: "en",
              provenance: "licensed_provider",
              provider: { id: "fixture", version: "v1" },
              characterCount: 7,
              obtainedAt: new Date().toISOString(),
            },
          },
        }),
      },
    );
    await assert.rejects(service({ url }), (error) => error.code === "TRANSCRIPT_INVALID");
    assert.equal(
      (await db.query("select count(*)::int as n from public.transcripts")).rows[0].n,
      0,
    );
  });
  it("rejects invalid structured output and records a safe terminal failure", async () => {
    const service = createNotesService(repo, () => ({
      model: "test-model",
      generate: async () => ({ arbitrary: "not notes" }),
    }));
    await assert.rejects(service(manual), (error) => error.code === "GEMINI_INVALID_OUTPUT");
    assert.deepEqual((await db.query("select status,payload from public.generated_content")).rows, [
      { status: "failed", payload: null },
    ]);
    await assert.rejects(service({ url }), (error) => error.code === "GEMINI_INVALID_OUTPUT");
  });
  it("records quota failure with bounded retry state and no immediate duplicate call", async () => {
    let calls = 0;
    const service = createNotesService(repo, () => ({
      model: "test-model",
      generate: async () => {
        calls++;
        throw new NotesGenerationError("GEMINI_QUOTA", "Quota unavailable", true, 429);
      },
    }));
    await assert.rejects(service(manual), (error) => error.code === "GEMINI_QUOTA");
    assert.equal((await service({ url })).status, "processing");
    assert.equal(calls, 1);
    assert.equal(
      (await db.query("select status from public.generation_jobs")).rows[0].status,
      "retry_wait",
    );
  });
  it("coalesces concurrent requests across independent service instances into one Gemini call", async () => {
    let started,
      finish,
      calls = 0;
    const entered = new Promise((resolve) => {
      started = resolve;
    });
    const generated = new Promise((resolve) => {
      finish = resolve;
    });
    const config = () => ({
      model: "test-model",
      generate: async () => {
        calls++;
        started();
        return generated;
      },
    });
    const firstService = createNotesService(repo, config);
    const secondService = createNotesService(repo, config);
    const first = firstService(manual);
    await entered;
    const second = await secondService(manual);
    assert.equal(second.status, "processing");
    assert.equal(calls, 1);
    finish(fixtureNotes);
    const done = await first;
    assert.equal(done.status, "ready");
    const reused = await secondService({ url });
    assert.equal(reused.cached, true);
    assert.equal(calls, 1);
    assert.equal(
      (await db.query("select count(*)::int as n from public.generation_jobs")).rows[0].n,
      1,
    );
  });
  it("keeps a paid-call claim fenced if saving fails", async () => {
    const service = createNotesService(
      {
        ...repo,
        finish: async () => {
          throw new Error("simulated database outage");
        },
      },
      () => ({ model: "test-model", generate: async () => fixtureNotes }),
    );
    await assert.rejects(service(manual));
    assert.equal(
      (await db.query("select status from public.generation_jobs")).rows[0].status,
      "running",
    );
    const other = createNotesService(repo, () => ({
      model: "test-model",
      generate: async () => {
        throw new Error("must not call");
      },
    }));
    assert.equal((await other({ url })).status, "processing");
  });
});
describe("B3 HTTP validation, no account gate and honest unconfigured state", () => {
  let server, origin;
  before(async () => {
    server = createApp().listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  it("keeps health public and rejects malformed YouTube input", async () => {
    assert.equal((await fetch(`${origin}/api/v1/health`)).status, 200);
    const response = await fetch(`${origin}/api/v1/youtube/detailed-notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "invalid" }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "VALIDATION_ERROR");
  });
  it("does not accept an unconfigured database or expose internal secrets", async () => {
    const response = await fetch(`${origin}/api/v1/youtube/detailed-notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "DATABASE_NOT_CONFIGURED");
  });
  it("classifies oversized and malformed JSON safely", async () => {
    for (const [body, status] of [
      ["{", 400],
      [JSON.stringify({ url, transcript: "x".repeat(2100000) }), 413],
    ]) {
      const response = await fetch(`${origin}/api/v1/youtube/detailed-notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      assert.equal(response.status, status);
    }
  });
  it("has no removed account API", async () => {
    assert.equal((await fetch(`${origin}/api/v1/auth/me`)).status, 404);
  });
});
