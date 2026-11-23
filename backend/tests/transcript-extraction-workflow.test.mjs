import assert from "node:assert/strict";
import { Router } from "express";
import { before, after, beforeEach, afterEach, describe, it } from "node:test";
import { createDatabase, embeddedRepository, fixtureNotes, A } from "./helpers/database.mjs";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
for (const key of [
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "TRANSCRIPTFETCH_API_KEY",
])
  process.env[key] = "";
const { createFencedTranscriptProvider } =
  await import("../dist/services/transcript-extraction.service.js");
const { createTranscriptFetchProvider } =
  await import("../dist/modules/extraction/transcriptfetch-transcript.js");
const { createNotesService } = await import("../dist/services/notes.service.js");
const { createApp } = await import("../dist/app.js");
const { createDetailedNotesController } = await import("../dist/controllers/notes.controller.js");
const fixture = [
  { start: 0, duration: 3.439, text: "सो हेलो एवरीवन, वेलकम बैक टू आवर चैनल।" },
  { start: 2, duration: 2.96, text: "आज हम डेटाबेस सीखेंगे।" },
];
const url = "https://youtu.be/IELMSD2kdmk";
let db, repo, jobs;
const response = (data) =>
  new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
function adapter(onCall = () => {}) {
  return createTranscriptFetchProvider(
    { apiKey: "tf_live_synthetic_test_only" },
    {
      fetch: async (path) => {
        onCall(path);
        return response({
          ok: true,
          data: {
            kind: "transcript",
            video_id: "IELMSD2kdmk",
            segments: fixture,
            source: "captions",
            language: "hi",
          },
          usage: { credits_spent: 1, balance: 49, bytes: 200 },
        });
      },
    },
  );
}
describe("TranscriptFetch SDK → real embedded SQL → mocked Gemini, no hosted calls", () => {
  before(async () => {
    db = await createDatabase();
    repo = embeddedRepository(db);
    const scalar = async (sql, params) => (await db.query(sql, params)).rows[0].value;
    jobs = {
      reserve: async (id, lang) =>
        (await db.query("select * from public.reserve_transcript_extraction($1,$2)", [id, lang]))
          .rows[0],
      recordRun: (...args) =>
        scalar("select public.record_transcript_run($1,$2,$3,$4) as value", args),
      finish: (id, lang, token, text, metadata) =>
        scalar("select public.finish_transcript_extraction($1,$2,$3,$4,$5::jsonb) as value", [
          id,
          lang,
          token,
          text,
          JSON.stringify({
            providerId: "transcriptfetch",
            providerVersion: "sdk-2.4.1-captions-v1",
            returnedLanguage: lang,
            ...metadata,
          }),
        ]),
      fail: (...args) =>
        scalar("select public.fail_transcript_extraction($1,$2,$3,$4) as value", args),
    };
  });
  after(async () => db.close());
  beforeEach(async () => db.exec("begin"));
  afterEach(async () => db.exec("rollback"));
  it("URL-only extraction persists timestamps, generates notes and reuses across canonical URLs", async () => {
    let runs = 0,
      generations = 0;
    const service = createNotesService(
      repo,
      () => ({
        model: "test-model",
        generate: async (text) => {
          generations++;
          assert.equal(text, fixture.map((s) => s.text).join(" "));
          return fixtureNotes;
        },
      }),
      createFencedTranscriptProvider(
        adapter((path) => {
          if (path.includes("/transcripts/video")) runs++;
        }),
        repo,
        jobs,
      ),
    );
    const first = await service({ url, transcriptLanguage: "hi" });
    assert.equal(first.status, "ready");
    assert.equal(first.transcript.reused, false);
    assert.equal(first.transcript.segments, undefined);
    assert.equal(first.transcript.text, undefined);
    assert.equal(first.transcript.language, "hi");
    const source = await repo.ensureSource("IELMSD2kdmk");
    const stored = await repo.findTranscript(source, "hi");
    assert.equal(stored.metadata.requestedLanguage, "hi");
    assert.equal(stored.metadata.returnedLanguage, "hi");
    assert.equal(stored.metadata.providerId, "transcriptfetch");
    assert.equal(stored.metadata.sourceMetadata.source, "captions");
    assert.equal(stored.metadata.usage, undefined);
    assert.equal(
      (await db.query("select usage from ll_private.transcript_extractions")).rows[0].usage.balance,
      49,
    );
    assert.equal(stored.metadata.segments[0].duration, 3.439);
    const second = await service({
      url: "https://www.youtube.com/shorts/IELMSD2kdmk",
      transcriptLanguage: "hi",
    });
    assert.equal(second.cached, true);
    assert.equal(second.transcript.reused, true);
    assert.equal(second.transcript.segments, undefined);
    assert.equal(runs, 1);
    assert.equal(generations, 1);
    assert.equal((await db.query("select count(*)::int n from public.transcripts")).rows[0].n, 1);
    assert.equal(
      (await db.query("select status,run_id from ll_private.transcript_extractions")).rows[0]
        .status,
      "succeeded",
    );
  });
  it("real HTTP URL-to-notes and manual fallback return renderable timestamped results without secrets", async () => {
    let paidCalls = 0;
    const service = createNotesService(
      repo,
      () => ({ model: "test-model", generate: async () => fixtureNotes }),
      createFencedTranscriptProvider(
        adapter(() => paidCalls++),
        repo,
        jobs,
      ),
    );
    const router = Router();
    router.post("/youtube/detailed-notes", createDetailedNotesController(service));
    const server = createApp(router).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const request = async (body) => {
      const res = await fetch(
        `http://127.0.0.1:${server.address().port}/api/v1/youtube/detailed-notes`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
          body: JSON.stringify(body),
        },
      );
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      return (await res.json()).data;
    };
    try {
      const first = await request({ url, transcriptLanguage: "hi" });
      assert.equal(first.status, "ready");
      assert.equal(first.transcript.segments, undefined);
      assert.equal(first.transcript.text, undefined);
      assert.equal(first.notes.title, fixtureNotes.title);
      const cached = await request({ url, transcriptLanguage: "hi" });
      assert.equal(cached.cached, true);
      assert.equal(paidCalls, 1);
      const manual = await request({
        url: "https://youtu.be/AbCdEf12_-3",
        transcript: "Manual HTTP fallback",
        shareConsent: true,
      });
      assert.equal(manual.transcript.provenance, "manual");
      assert.equal(manual.transcript.text, undefined);
      assert.equal(paidCalls, 1);
      assert.equal(JSON.stringify(first).includes("balance"), false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
  it("concurrent duplicate extraction requests reserve exactly one SDK request", async () => {
    let release, entered;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const start = new Promise((resolve) => {
      entered = resolve;
    });
    let runs = 0;
    const base = adapter();
    const provider = createFencedTranscriptProvider(
      {
        acquire: async (...args) => {
          runs++;
          entered();
          await gate;
          return base.acquire(...args);
        },
      },
      repo,
      jobs,
    );
    const service = createNotesService(
      repo,
      () => ({ model: "test-model", generate: async () => fixtureNotes }),
      provider,
    );
    const first = service({ url, transcriptLanguage: "hi" });
    await start;
    const second = await service({ url, transcriptLanguage: "hi" });
    assert.equal(second.status, "extracting");
    release();
    assert.equal((await first).status, "ready");
    assert.equal(runs, 1);
  });
  it("failure releases active reservation but fences repeated paid calls; manual fallback succeeds", async () => {
    let calls = 0;
    const provider = createFencedTranscriptProvider(
      {
        acquire: async () => {
          calls++;
          throw new Error("private credential must not escape");
        },
      },
      repo,
      jobs,
    );
    const service = createNotesService(
      repo,
      () => ({ model: "test-model", generate: async () => fixtureNotes }),
      provider,
    );
    const failed = await service({ url });
    assert.equal(failed.status, "transcript_required");
    assert.ok(!failed.provider.message.includes("credential"));
    assert.equal((await service({ url })).status, "transcript_required");
    assert.equal(calls, 1);
    assert.equal(
      (await db.query("select status from ll_private.transcript_extractions")).rows[0].status,
      "failed",
    );
    assert.equal(
      (await service({ url, transcript: "Manual fallback excerpt.", shareConsent: true })).status,
      "ready",
    );
  });
  it("rejects stale tokens and expired leases and does not steal uncertain paid runs", async () => {
    const source = await repo.ensureSource("IELMSD2kdmk");
    const claim = await jobs.reserve(source, "en");
    assert.equal(await jobs.recordRun(source, "en", A, "run123"), false);
    assert.equal(await jobs.fail(source, "en", A, "BAD"), false);
    const metadata = {
      requestedLanguage: "en",
      segments: [{ start: 0, duration: 1, text: "fixture" }],
    };
    assert.equal(await jobs.finish(source, "en", A, "fixture", metadata), false);
    await db.query(
      "update ll_private.transcript_extractions set leased_until=now()-interval '1 second'",
    );
    assert.equal(await jobs.finish(source, "en", claim.token, "fixture", metadata), false);
    assert.equal((await jobs.reserve(source, "en")).disposition, "failed");
    assert.equal((await db.query("select count(*)::int n from public.transcripts")).rows[0].n, 0);
  });
  it("manual race wins without transcript overwrite or duplicate record", async () => {
    const source = await repo.ensureSource("IELMSD2kdmk");
    const claim = await jobs.reserve(source, "en");
    await repo.acquireTranscript(source, "Manual race winner", "en", "manual", "fixture", "v1");
    assert.equal(
      await jobs.finish(source, "en", claim.token, "provider", {
        requestedLanguage: "en",
        segments: [{ start: 0, duration: 1, text: "provider" }],
      }),
      true,
    );
    const stored = await repo.findTranscript(source, "en");
    assert.equal(stored.provenance, "manual");
    assert.equal(stored.text_content, "Manual race winner");
    assert.deepEqual(stored.metadata, {});
  });
  it("cache reservation never starts a new paid job", async () => {
    const source = await repo.ensureSource("IELMSD2kdmk");
    await repo.acquireTranscript(source, "Already saved", "en", "manual", "fixture", "v1");
    assert.equal((await jobs.reserve(source, "en")).disposition, "cached");
    assert.equal(
      (await db.query("select count(*)::int n from ll_private.transcript_extractions")).rows[0].n,
      0,
    );
  });
  it("an existing Apify transcript cache bypasses the SDK and still generates Gemini notes", async () => {
    const source = await repo.ensureSource("IELMSD2kdmk");
    await repo.acquireTranscript(
      source,
      "Cached captions",
      "en",
      "licensed_provider",
      "apify",
      "faVsWy9VTSNVIhWpR-segments-v1",
    );
    let calls = 0;
    const service = createNotesService(
      repo,
      () => ({ model: "test-model", generate: async () => fixtureNotes }),
      createFencedTranscriptProvider(
        adapter(() => calls++),
        repo,
        jobs,
      ),
    );
    assert.equal((await service({ url })).status, "ready");
    assert.equal(calls, 0);
  });
  for (const [name, body, status] of [
    [
      "captions unavailable",
      {
        ok: false,
        error: { code: "no_captions", message: "no captions", retry_with: { mode: "audio" } },
      },
      422,
    ],
    [
      "unexpected processing audio",
      {
        ok: true,
        status: "processing",
        job_id: "job_test",
        data: { kind: "transcript_job", video_id: "IELMSD2kdmk" },
      },
      202,
    ],
    [
      "failed job",
      { ok: true, status: "failed", data: { kind: "transcript", video_id: "IELMSD2kdmk" } },
      200,
    ],
  ])
    it(`${name} remains fenced on repeated requests and permits manual fallback`, async () => {
      let calls = 0;
      const sdk = createTranscriptFetchProvider(
        { apiKey: "tf_live_synthetic_test_only" },
        {
          fetch: async () => {
            calls++;
            return new Response(JSON.stringify(body), { status });
          },
        },
      );
      const service = createNotesService(
        repo,
        () => ({ model: "test-model", generate: async () => fixtureNotes }),
        createFencedTranscriptProvider(sdk, repo, jobs),
      );
      assert.equal((await service({ url })).status, "transcript_required");
      assert.equal((await service({ url })).status, "transcript_required");
      assert.equal(calls, 1);
      assert.equal(
        (await service({ url, transcript: "Manual caption excerpt", shareConsent: true })).status,
        "ready",
      );
    });
  it("service role completes extraction with accurate provider identity and private usage", async () => {
    const source = await repo.ensureSource("IELMSD2kdmk");
    await db.exec("set local role service_role");
    const claim = await jobs.reserve(source, "en");
    assert.equal(
      await jobs.finish(source, "en", claim.token, "fixture", {
        requestedLanguage: "en",
        segments: [{ start: 0, duration: 1, text: "fixture" }],
        usage: { creditsSpent: 1, balance: null, bytes: 100 },
      }),
      true,
    );
    const row = (
      await db.query("select provider_id,provider_version,metadata from public.transcripts")
    ).rows[0];
    assert.equal(row.provider_id, "transcriptfetch");
    assert.equal(row.provider_version, "sdk-2.4.1-captions-v1");
    assert.equal(row.metadata.usage, undefined);
    assert.deepEqual(
      (await db.query("select usage from ll_private.transcript_extractions")).rows[0].usage,
      { creditsSpent: 1, balance: null, bytes: 100 },
    );
    await db.exec("reset role");
  });
  it("global database gate bounds concurrent distinct videos", async () => {
    for (const id of ["IELMSD2kdmk", "AbCdEf12_-3"])
      assert.equal((await jobs.reserve(await repo.ensureSource(id), "en")).disposition, "reserved");
    assert.equal(
      (await jobs.reserve(await repo.ensureSource("ZbCdEf12_-3"), "en")).disposition,
      "busy",
    );
  });
  it("uncertain persistence after a paid call stays fenced without replay", async () => {
    let calls = 0;
    const provider = createFencedTranscriptProvider(
      adapter((path) => {
        if (path.includes("/transcripts/video")) calls++;
      }),
      repo,
      {
        ...jobs,
        finish: async () => {
          throw new Error("Database disconnected");
        },
      },
    );
    const service = createNotesService(
      repo,
      () => {
        throw new Error("No Gemini call");
      },
      provider,
    );
    await assert.rejects(service({ url, transcriptLanguage: "hi" }), /Database disconnected/);
    assert.equal((await service({ url, transcriptLanguage: "hi" })).status, "extracting");
    assert.equal(calls, 1);
  });
  it("database validates segment timing/text and preserves immutable metadata", async () => {
    const source = await repo.ensureSource("IELMSD2kdmk");
    const claim = await jobs.reserve(source, "en");
    for (const segments of [
      [{ start: -1, duration: 1, text: "fixture" }],
      [{ start: 0, duration: "1", text: "fixture" }],
      [{ start: 0, duration: 1, text: "mismatch" }],
    ]) {
      await db.exec("savepoint invalid_segment");
      await assert.rejects(
        jobs.finish(source, "en", claim.token, "fixture", { requestedLanguage: "en", segments }),
      );
      await db.exec("rollback to savepoint invalid_segment; release savepoint invalid_segment");
    }
    assert.equal(
      await jobs.finish(source, "en", claim.token, "fixture", {
        requestedLanguage: "en",
        segments: [{ start: 0, duration: 1, text: "fixture" }],
      }),
      true,
    );
    await db.exec("savepoint immutable_metadata");
    await assert.rejects(db.query("update public.transcripts set metadata='{}'"), /version/);
    await db.exec("rollback to savepoint immutable_metadata; release savepoint immutable_metadata");
  });
  it("browser roles cannot read extraction state or invoke extraction RPCs", async () => {
    for (const role of ["anon", "authenticated"]) {
      assert.equal(
        (
          await db.query(
            "select has_table_privilege($1,'ll_private.transcript_extractions','select') allowed",
            [role],
          )
        ).rows[0].allowed,
        false,
      );
      for (const fn of [
        "reserve_transcript_extraction(uuid,text)",
        "record_transcript_run(uuid,text,uuid,text)",
        "finish_transcript_extraction(uuid,text,uuid,text,jsonb)",
        "fail_transcript_extraction(uuid,text,uuid,text)",
      ])
        assert.equal(
          (
            await db.query("select has_function_privilege($1,$2,'execute') allowed", [
              role,
              `public.${fn}`,
            ])
          ).rows[0].allowed,
          false,
        );
    }
  });
});
