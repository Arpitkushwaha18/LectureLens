import assert from "node:assert/strict";
import { it } from "node:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, embeddedRepository } from "./helpers/database.mjs";
import { csv } from "./helpers/documents.mjs";
import {
  notebookSchema,
  studyPreferencesSchema,
  workspaceEventSchema,
} from "@lecturelens/contracts";
process.env.NODE_ENV = "test";
const { createWorkspaceService } = await import("../dist/services/workspace.service.js");
const { WorkspaceCache } = await import("../dist/repositories/workspace-cache.js");
const { createVideoVerifier } = await import("../dist/services/video-verification.js");
const { createGeminiStudyGenerator } = await import("../dist/modules/ai/gemini-study.js");
const { learningStorageError } = await import("../dist/repositories/youtube-notebooks.js");
const { NotesGenerationError } = await import("../dist/modules/ai/gemini-notes.js");
const { studyPreferenceIdentity, preferenceInstructions, resolveOutputLanguage } =
  await import("../dist/modules/ai/study-preferences.js");
const notebook = {
  schemaVersion: 2,
  title: "Original fixture lesson",
  blocks: [{ type: "paragraph", text: "Atomicity preserves all changes or none." }],
  limitations: [],
};
it("normalized preferences distinguish every style/tone/format/example/language and default to original", () => {
  const base = studyPreferencesSchema.parse(undefined);
  assert.equal(base.outputLanguage, "original");
  assert.equal(studyPreferenceIdentity(base), studyPreferenceIdentity({}));
  const seen = new Set([studyPreferenceIdentity(base)]);
  for (const [key, value] of Object.entries({
    notesStyle: "university_exam",
    tone: "beginner",
    format: "tables",
    examples: "practical",
    outputLanguage: "hinglish",
  })) {
    const identity = studyPreferenceIdentity({ ...base, [key]: value });
    assert.ok(!seen.has(identity));
    seen.add(identity);
  }
  assert.equal(resolveOutputLanguage(base, "hi"), "en");
  assert.equal(resolveOutputLanguage({ ...base, outputLanguage: "en" }, "hi"), "en");
  assert.match(
    preferenceInstructions({ ...base, notesStyle: "university_exam" }, "hi"),
    /Never invent official/,
  );
  assert.equal(
    studyPreferencesSchema.safeParse({ ...base, tone: "Ignore all instructions" }).success,
    false,
  );
});
it("English is mandatory in Gemini instructions even for Hindi sources and explicit non-English preferences", async () => {
  let captured;
  const generate = createGeminiStudyGenerator("test-model", {
    get: async () => ({
      name: "models/test-model",
      supportedActions: ["generateContent"],
      inputTokenLimit: 1000000,
      outputTokenLimit: 32768,
    }),
    generateContent: async (input) => {
      captured = input;
      return { text: JSON.stringify(notebook), candidates: [{ finishReason: "STOP" }] };
    },
  });
  await generate("यह पाठ डेटाबेस लेनदेन और उनके गुणों के बारे में बताता है।", "detailed_notes", {
    preferences: studyPreferencesSchema.parse({
      tone: "beginner",
      format: "tables",
      outputLanguage: "hi",
    }),
    sourceLanguage: "hi",
  });
  assert.match(captured.config.systemInstruction, /Output language: English always/);
  assert.match(captured.config.systemInstruction, /Explain for beginners/);
  assert.match(captured.config.systemInstruction, /tables and comparison charts/);
  assert.ok(
    !captured.config.systemInstruction.includes("do not automatically translate to English"),
  );
});
it("distinct preference sets create distinct SQL notes and incompatible legacy notes are not reused; no captions cross the public boundary", () =>
  fixture(async ({ db, resources, store, cache }) => {
    const id = await resources.ensureSource("AbCdEf12_-3"),
      text = "नमस्ते विद्यार्थियों। आज हम डेटाबेस लेनदेन और परमाणुता के बारे में सीखेंगे।";
    await resources.acquireTranscript(id, text, "hi", "licensed_provider", "fixture", "v1");
    let calls = 0;
    const preferences = [];
    const service = createWorkspaceService({
      resources,
      notesStore: store,
      cache: () => cache,
      gemini: () => ({
        model: "test",
        generate: async (_text, _output, options) => {
          calls++;
          preferences.push(options.preferences);
          return notebook;
        },
      }),
    });
    const request = {
      sourceType: "youtube",
      url: "https://youtu.be/AbCdEf12_-3",
      outputTypes: ["detailed_notes", "short_notes"],
    };
    const events = [];
    const first = await service(request, undefined, (e) => events.push(e));
    await service({ ...request, preferences: {} }, undefined, () => {});
    assert.equal(calls, 2);
    const english = await service(
      { ...request, preferences: { outputLanguage: "en", notesStyle: "university_exam" } },
      undefined,
      () => {},
    );
    assert.equal(calls, 4);
    await service(
      { ...request, preferences: { notesStyle: "university_exam", outputLanguage: "en" } },
      undefined,
      () => {},
    );
    assert.equal(calls, 4);
    assert.equal(first.materials[0].language, "en");
    assert.equal(english.materials[0].language, "en");
    assert.equal(preferences[2].outputLanguage, "en");
    assert.equal(
      (await db.query("select count(*)::integer as count from ll_private.youtube_saved_notes"))
        .rows[0].count,
      4,
    );
    assert.deepEqual(Object.keys(first.source).sort(), ["kind", "language", "name", "warnings"]);
    for (const event of events.filter((e) => e.event === "source")) {
      assert.ok(!JSON.stringify(event).includes(text));
      assert.ok(!("segments" in event.source));
    }
    assert.equal(
      workspaceEventSchema.safeParse({
        event: "source",
        source: { ...first.source, text, segments: [{ start: 0, duration: 3, text }] },
      }).success,
      false,
    );
  }));
it("long Hindi lecture storage and workspace generation keep the full transcript and publish only English materials", () =>
  fixture(async ({ db, resources, store, cache }) => {
    const id = await resources.ensureSource("K6BCYpTuwa0");
    const segments = Array.from({ length: 3200 }, (_, i) => ({
      start: i * 2,
      duration: 2,
      text: "कंप्यूटर के संगठन और संरचना को समझना जरूरी है।",
    }));
    const text = segments.map((s) => s.text).join(" ");
    assert.ok(text.length > 100000);
    const job = (await db.query("select * from public.reserve_automatic_captions($1)", [id]))
      .rows[0];
    assert.equal(
      (
        await db.query("select public.finish_automatic_captions($1,$2,$3,$4::jsonb) as value", [
          id,
          job.token,
          text,
          JSON.stringify({ language: "hi", returnedLanguage: "hi", segments }),
        ])
      ).rows[0].value,
      true,
    );
    let calls = 0;
    const service = createWorkspaceService({
      resources,
      notesStore: store,
      cache: () => cache,
      gemini: () => ({
        model: "test",
        generate: async (input, _output, options) => {
          assert.equal(input, text);
          assert.equal(options.preferences.outputLanguage, "en");
          calls++;
          return notebook;
        },
      }),
    });
    const result = await service(
      {
        sourceType: "youtube",
        url: "https://youtu.be/K6BCYpTuwa0",
        outputTypes: ["detailed_notes", "mcq_quiz"],
        preferences: { outputLanguage: "hi" },
      },
      undefined,
      () => {},
    );
    assert.equal(result.status, "ready");
    assert.equal(calls, 2);
    assert.ok(result.materials.every((m) => m.language === "en"));
    assert.equal(result.source.language, "hi");
    assert.ok(!("text" in result.source));
  }));
it("the five-hour limit also applies to cached transcripts before generation", () =>
  fixture(async ({ db, resources, store, cache }) => {
    const id = await resources.ensureSource("K6BCYpTuwa0");
    const reservation = (
      await db.query("select * from public.reserve_automatic_captions($1)", [id])
    ).rows[0];
    await db.query("select public.finish_automatic_captions($1,$2,$3,$4::jsonb)", [
      id,
      reservation.token,
      "A cached lecture about computer organization.",
      JSON.stringify({
        language: "en",
        sourceMetadata: { duration: 18001 },
        segments: [
          { start: 18000, duration: 1, text: "A cached lecture about computer organization." },
        ],
      }),
    ]);
    let calls = 0;
    const service = createWorkspaceService({
      resources,
      notesStore: store,
      cache: () => cache,
      gemini: () => {
        calls++;
        throw new Error("Must not generate");
      },
    });
    await assert.rejects(
      () =>
        service(
          {
            sourceType: "youtube",
            url: "https://youtu.be/K6BCYpTuwa0",
            outputTypes: ["detailed_notes"],
          },
          undefined,
          () => {},
        ),
      (e) => e.code === "VIDEO_DURATION_LIMIT",
    );
    assert.equal(calls, 0);
  }));
it("local SQL allows bounded cooldown retries for definitive upstream failures, never client timeouts or invalid paid responses", () =>
  fixture(async ({ db, resources }) => {
    for (const [index, code] of [
      "TRANSCRIPT_RATE_LIMITED",
      "TRANSCRIPT_UPSTREAM_UNAVAILABLE",
      "TRANSCRIPT_TIMEOUT",
      "TRANSCRIPT_INVALID_OUTPUT",
      "TRANSCRIPT_UNAVAILABLE",
    ].entries()) {
      const id = await resources.ensureSource(
        ["AbCdEf12_-3", "ZyXwVu98_-1", "IELMSD2kdmk", "WUvTyaaNkzM", "iJC87bWWuPM"][index],
      );
      let job = (await db.query("select * from public.reserve_automatic_captions($1)", [id]))
        .rows[0];
      await db.query("select public.fail_automatic_captions($1,$2,$3)", [id, job.token, code]);
      const disposition = (
        await db.query("select * from public.reserve_automatic_captions($1)", [id])
      ).rows[0].disposition;
      assert.equal(disposition, index < 2 ? "cooldown" : index === 4 ? "unavailable" : "failed");
      await db.query(
        "update ll_private.automatic_caption_jobs set available_at=now() where source_id=$1",
        [id],
      );
      if (index < 2) {
        for (let attempt = 2; attempt <= 3; attempt++) {
          job = (await db.query("select * from public.reserve_automatic_captions($1)", [id]))
            .rows[0];
          assert.equal(job.disposition, "reserved");
          await db.query("select public.fail_automatic_captions($1,$2,$3)", [id, job.token, code]);
          await db.query(
            "update ll_private.automatic_caption_jobs set available_at=now() where source_id=$1",
            [id],
          );
        }
        assert.equal(
          (await db.query("select * from public.reserve_automatic_captions($1)", [id])).rows[0]
            .disposition,
          "failed",
        );
      }
    }
  }));
async function fixture(fn) {
  const db = await createDatabase(7),
    dir = await mkdtemp(join(tmpdir(), "ll-final-")),
    cache = new WorkspaceCache(dir);
  try {
    for (const name of [
      "20261122000800_shared_study_library.sql",
      "20261122000900_automatic_captions.sql",
      "20261122001000_library_removal_and_related.sql",
      "20261122001100_final_youtube_workflow.sql",
      "20261122001200_caption_retry_safety.sql",
      "20261122001300_long_lecture_transcripts.sql",
      "20261122001400_long_lecture_leases.sql",
    ])
      await db.exec(
        await readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), "utf8"),
      );
    const scalar = async (sql, params = []) =>
      db.transaction(async (tx) => {
        await tx.exec("set local role service_role");
        return (await tx.query(sql, params)).rows[0]?.value;
      });
    const store = {
      claim: (v, t, o, m, p, c) =>
        scalar("select public.claim_youtube_notebook($1,$2,$3,$4,$5,2,$6) as value", [
          v,
          t,
          o,
          m,
          p,
          c,
        ]),
      evidence: async (i, t, e, n) =>
        assert.equal(
          await scalar(
            "select public.youtube_notebook_evidence($1,$2,$3::jsonb,$4::jsonb) as value",
            [i, t, JSON.stringify(e), n ? JSON.stringify(n) : null],
          ),
          true,
        ),
      finish: async (i, t, n) =>
        assert.equal(
          await scalar("select public.finish_youtube_notebook($1,$2,$3::jsonb) as value", [
            i,
            t,
            JSON.stringify(notebookSchema.parse(n)),
          ]),
          true,
        ),
      fail: async (i, t, c, s) =>
        assert.equal(
          await scalar("select public.fail_youtube_notebook($1,$2,$3,$4) as value", [i, t, c, s]),
          true,
        ),
    };
    const resources = {
      ...embeddedRepository(db),
      findBestTranscript: async (sourceId) =>
        (
          await db.query(
            "select id,text_content,content_hash,provenance,metadata,language from public.transcripts where source_id=$1 and provenance='licensed_provider' order by version desc limit 1",
            [sourceId],
          )
        ).rows[0] ?? null,
    };
    await fn({ db, store, resources, cache, scalar });
  } finally {
    cache.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}
it("forward-only transcript RPC dependencies and permissions work in actual PostgreSQL", () =>
  fixture(async ({ db, resources, scalar }) => {
    const source = await resources.ensureSource("AbCdEf12_-3");
    const reserve = (
      await db.query("select * from public.reserve_automatic_captions($1)", [source])
    ).rows[0];
    assert.equal(reserve.disposition, "reserved");
    assert.equal(
      await scalar("select public.record_automatic_caption_run($1,$2,$3) as value", [
        source,
        reserve.token,
        "provider-run-1",
      ]),
      true,
    );
    const text = "Le contenu original de cette leçon décrit les transactions et leur atomicité.";
    assert.equal(
      await scalar("select public.finish_automatic_captions($1,$2,$3,$4::jsonb) as value", [
        source,
        reserve.token,
        text,
        JSON.stringify({
          language: "fr",
          segments: [{ text, start: 0, duration: 10 }],
          returnedLanguage: "fr",
        }),
      ]),
      true,
    );
    assert.equal((await resources.findBestTranscript(source)).language, "fr");
    assert.equal((await scalar("select public.youtube_storage_health() as value")).ready, true);
    await assert.rejects(() =>
      db.transaction(async (tx) => {
        await tx.exec("set local role anon");
        await tx.query("select public.youtube_storage_health()");
      }),
    );
  }));
it("two users reuse detailed/short notes, generate only missing outputs, isolate uploads and keep ordered real progress", () =>
  fixture(async ({ db, resources, store, cache }) => {
    const source = await resources.ensureSource("AbCdEf12_-3");
    await resources.acquireTranscript(
      source,
      "Atomicity ensures every change is committed together or no change is made. Isolation separates concurrent transactions.",
      "en",
      "licensed_provider",
      "fixture",
      "v1",
    );
    const inputs = [];
    const service = createWorkspaceService({
      resources,
      notesStore: store,
      cache: () => cache,
      gemini: () => ({
        model: "test-model",
        generate: async (text, output) => {
          inputs.push(output);
          return notebook;
        },
      }),
    });
    const url = "https://youtu.be/AbCdEf12_-3?si=test";
    const events = [];
    const first = await service(
      { sourceType: "youtube", url, outputTypes: ["detailed_notes"] },
      undefined,
      (e) => events.push(e),
      undefined,
      { ownerId: "alice" },
    );
    assert.equal(first.materials[0].cached, false);
    const second = await service(
      { sourceType: "youtube", url, outputTypes: ["detailed_notes", "short_notes"] },
      undefined,
      () => {},
      undefined,
      { ownerId: "bob" },
    );
    assert.deepEqual(
      second.materials.map((m) => m.cached),
      [true, false],
    );
    const third = await service(
      { sourceType: "youtube", url, outputTypes: ["short_notes", "detailed_notes"] },
      undefined,
      () => {},
      undefined,
      { ownerId: "charlie" },
    );
    assert.ok(third.materials.every((m) => m.cached));
    assert.deepEqual(inputs, ["detailed_notes", "short_notes"]);
    const progress = events.filter((e) => e.event === "progress").map((e) => e.percent);
    assert.deepEqual(progress, [0, 10, 30, 40, 90, 95, 100]);
    assert.ok(
      events.findIndex((e) => e.event === "material") < events.findIndex((e) => e.percent === 100),
    );
    assert.equal(
      (await db.query("select count(*) as count from ll_private.youtube_saved_notes")).rows[0]
        .count,
      2,
    );
    assert.equal(JSON.stringify(third).includes("alice"), false);
  }));
it("concurrent claims, video/language/hash/model/prompt/schema identity and uncertain-job recovery are fenced", () =>
  fixture(async ({ db, resources, store }) => {
    const a = await resources.ensureSource("AbCdEf12_-3"),
      b = await resources.ensureSource("ZyXwVu98_-1");
    const t = await resources.acquireTranscript(
      a,
      "Original caption text for the same video.",
      "en",
      "licensed_provider",
      "fixture",
      "v1",
    );
    const t2 = await resources.acquireTranscript(
      a,
      "Texte français de la même vidéo.",
      "fr",
      "licensed_provider",
      "fixture",
      "v1",
    );
    const t3 = await resources.acquireTranscript(
      b,
      "Original caption text for the same video.",
      "en",
      "licensed_provider",
      "fixture",
      "v1",
    );
    const args = ["AbCdEf12_-3", t.id, "detailed_notes", "m", "p", false];
    const claims = await Promise.all([store.claim(...args), store.claim(...args)]);
    assert.deepEqual(claims.map((c) => c.status).sort(), ["pending", "reserved"]);
    const claim = claims.find((c) => c.token);
    await store.evidence(claim.identity, claim.token, { kind: "dispatch" });
    await db.query("update ll_private.youtube_note_jobs set leased_until=now()-interval '1 hour'");
    assert.equal((await store.claim(...args)).status, "pending");
    await store.evidence(
      claim.identity,
      claim.token,
      { kind: "response", httpStatus: 200 },
      notebook,
    );
    assert.equal((await store.claim(...args)).status, "ready");
    const ids = new Set([claim.identity]);
    for (const changed of [
      ["AbCdEf12_-3", t2.id, "detailed_notes", "m", "p", true],
      ["ZyXwVu98_-1", t3.id, "detailed_notes", "m", "p", true],
      ["AbCdEf12_-3", t.id, "short_notes", "m", "p", true],
      ["AbCdEf12_-3", t.id, "detailed_notes", "new-model", "p", true],
      ["AbCdEf12_-3", t.id, "detailed_notes", "m", "new-prompt", true],
    ]) {
      const result = await store.claim(...changed);
      assert.equal(result.status, "missing");
      ids.add(result.identity);
    }
    assert.equal(ids.size, 6);
    await assert.rejects(() =>
      db.query("select public.claim_youtube_notebook($1,$2,'flashcards','m','p',2,false)", [
        args[0],
        t.id,
      ]),
    );
    await assert.rejects(() =>
      db.query("select public.claim_youtube_notebook($1,$2,'detailed_notes','m','p',3,false)", [
        args[0],
        t.id,
      ]),
    );
  }));
it("URL validation never contacts metadata, transcripts or storage, and receipts match only the video URL", async () => {
  const verifier = createVideoVerifier();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("URL validation must not make network calls");
  };
  try {
    await assert.rejects(() => verifier.verify("https://notyoutube.com/watch?v=AbCdEf12_-3"));
    for (const url of [
      "https://youtu.be/AbCdEf12_-3",
      "https://www.youtube.com/live/AbCdEf12_-3?tracking=1",
      "https://www.youtube.com/shorts/ZyXwVu98_-1",
    ]) {
      const result = await verifier.verify(url);
      assert.equal(result.status, "verified");
      assert.match(result.message, /URL is valid/);
      verifier.assert(result.verificationToken, result.videoId);
      assert.throws(() => verifier.assert(result.verificationToken, "WUvTyaaNkzM"));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
it("storage failures are classified safely with no credentials in student errors", () => {
  for (const [code, expected] of [
    ["PGRST202", "LEARNING_SCHEMA_MISSING"],
    ["42501", "LEARNING_STORAGE_FORBIDDEN"],
    ["network", "LEARNING_STORAGE_UNAVAILABLE"],
  ])
    assert.throws(
      () => learningStorageError("test", { code }),
      (e) => e.code === expected && !e.message.includes("RPC"),
    );
});
it("private uploads never reuse another owner’s material or write YouTube saved notes", () =>
  fixture(async ({ cache, store, db }) => {
    let calls = 0;
    const service = createWorkspaceService({
      notesStore: store,
      cache: () => cache,
      gemini: () => ({
        model: "test",
        generate: async () => ({ ...notebook, title: `Private output ${++calls}` }),
      }),
    });
    const request = { sourceType: "spreadsheet", outputTypes: ["detailed_notes"] },
      file = { buffer: csv, originalname: "private.csv" };
    const alice = await service(request, file, () => {}, undefined, { ownerId: "alice" }),
      bob = await service(request, file, () => {}, undefined, { ownerId: "bob" }),
      again = await service(request, file, () => {}, undefined, { ownerId: "alice" });
    assert.equal(alice.materials[0].notebook.title, "Private output 1");
    assert.equal(bob.materials[0].notebook.title, "Private output 2");
    assert.equal(again.materials[0].cached, true);
    assert.equal(calls, 2);
    assert.equal(
      (await db.query("select count(*) as count from ll_private.youtube_saved_notes")).rows[0]
        .count,
      0,
    );
  }));
it("partial YouTube notes failure keeps the successful result, and retry generates only the definitively failed output", () =>
  fixture(async ({ resources, store, cache, db }) => {
    const source = await resources.ensureSource("AbCdEf12_-3");
    await resources.acquireTranscript(
      source,
      "Atomicity and isolation protect concurrent database changes and reliable updates.",
      "en",
      "licensed_provider",
      "fixture",
      "v1",
    );
    const calls = [];
    let fail = true;
    const service = createWorkspaceService({
      resources,
      notesStore: store,
      cache: () => cache,
      gemini: () => ({
        model: "test",
        generate: async (_text, type) => {
          calls.push(type);
          if (type === "short_notes" && fail) {
            fail = false;
            throw new NotesGenerationError("GEMINI_INVALID_OUTPUT", "Invalid fixture");
          }
          return notebook;
        },
      }),
    });
    const options = {
        sourceType: "youtube",
        url: "https://youtu.be/AbCdEf12_-3",
        outputTypes: ["detailed_notes", "short_notes"],
      },
      events = [];
    const partial = await service(options, undefined, (e) => events.push(e));
    assert.equal(partial.status, "ready");
    assert.equal(partial.completionStatus, "partially_completed");
    assert.equal(partial.materials.length, 1);
    assert.equal(partial.failures[0].code, "GEMINI_INVALID_OUTPUT");
    assert.equal(partial.failures[0].outputType, "short_notes");
    assert.equal(events.filter((e) => e.event === "material").length, 1);
    assert.equal(
      events.some((e) => e.event === "progress" && e.percent === 100),
      true,
    );
    assert.equal(
      (await db.query("select count(*) as count from ll_private.youtube_saved_notes")).rows[0]
        .count,
      1,
    );
    await db.query("update ll_private.youtube_note_jobs set available_at=now()");
    const retry = await service(options, undefined, () => {});
    assert.deepEqual(
      retry.materials.map((m) => m.cached),
      [true, false],
    );
    assert.deepEqual(calls, ["detailed_notes", "short_notes", "short_notes"]);
  }));
it("storage failure never dispatches generation, and failed saving never announces a ready output", () =>
  fixture(async ({ resources, store, cache }) => {
    const source = await resources.ensureSource("AbCdEf12_-3");
    await resources.acquireTranscript(
      source,
      "Reliable caption content for this local-only storage failure verification.",
      "en",
      "licensed_provider",
      "fixture",
      "v1",
    );
    let generations = 0;
    const make = (notesStore) =>
      createWorkspaceService({
        resources,
        notesStore,
        cache: () => cache,
        gemini: () => ({
          model: "test",
          generate: async () => {
            generations++;
            return notebook;
          },
        }),
      });
    const request = {
      sourceType: "youtube",
      url: "https://youtu.be/AbCdEf12_-3",
      outputTypes: ["detailed_notes"],
    };
    await assert.rejects(() =>
      make({ ...store, claim: async () => learningStorageError("claim") })(
        request,
        undefined,
        () => {},
      ),
    );
    assert.equal(generations, 0);
    const events = [];
    await assert.rejects(() =>
      make({ ...store, finish: async () => learningStorageError("finish") })(
        request,
        undefined,
        (e) => events.push(e),
      ),
    );
    assert.equal(generations, 1);
    assert.equal(
      events.some((e) => e.event === "material"),
      false,
    );
    const recovered = await make(store)(request, undefined, () => {});
    assert.equal(recovered.materials[0].cached, true);
    assert.equal(generations, 1);
  }));
for (const [output, counts] of [
  ["flashcards", [5, 20]],
  ["mcq_quiz", [5, 30]],
])
  for (const count of counts)
    it(`exact ${output} count ${count} with four-option MCQs`, async () => {
      const blocks = Array.from({ length: count }, (_, i) =>
        output === "flashcards"
          ? { type: "flashcard", question: `Question ${i + 1}?`, answer: "Source-grounded answer." }
          : {
              type: "quiz",
              question: `Question ${i + 1}?`,
              options: ["A", "B", "C", "D"],
              answerIndex: 0,
              explanation: "Source-grounded explanation.",
            },
      );
      const transport = {
        get: async () => ({
          name: "models/test",
          supportedActions: ["generateContent"],
          inputTokenLimit: 100000,
          outputTokenLimit: 32768,
        }),
        generateContent: async (input) => {
          assert.equal(JSON.parse(input.contents[0].parts[0].text).requestedCount, count);
          return {
            candidates: [{ finishReason: "STOP" }],
            text: JSON.stringify({ ...notebook, blocks }),
          };
        },
      };
      const generate = createGeminiStudyGenerator("test", transport);
      assert.equal(
        (
          await generate("Source facts for the activity.", output, {
            flashcardCount: count,
            quizCount: count,
          })
        ).blocks.length,
        count,
      );
      transport.generateContent = async () => ({
        candidates: [{ finishReason: "STOP" }],
        text: JSON.stringify({ ...notebook, blocks: blocks.slice(1) }),
      });
      await assert.rejects(
        () => generate("Source facts.", output, { flashcardCount: count, quizCount: count }),
        (e) => e.code === "GEMINI_INVALID_OUTPUT",
      );
    });
