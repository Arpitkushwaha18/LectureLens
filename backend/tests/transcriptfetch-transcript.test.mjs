import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseYouTubeUrl } from "@lecturelens/contracts";
import { VERSION } from "transcriptfetch";
import { createTranscriptFetchProvider } from "../dist/modules/extraction/transcriptfetch-transcript.js";
import { envSchema } from "../dist/config/env-schema.js";
const key = "tf_live_synthetic_test_only";
it("bounded transient retries reuse the persisted idempotency key; permanent proxy failures and malformed responses never retry", async () => {
  let calls = 0,
    recorded,
    headers = [];
  const p = createTranscriptFetchProvider(
    { apiKey: key },
    {
      fetch: async (_url, init) => {
        assert.ok(recorded);
        headers.push(init.headers["Idempotency-Key"]);
        calls++;
        return new Response(
          JSON.stringify(
            calls === 1
              ? { ok: false, error: { code: "rate_limited", message: "secret" } }
              : envelope(),
          ),
          { status: calls === 1 ? 429 : 200, headers: { "Retry-After": "0" } },
        );
      },
    },
  );
  const outcome = await p.acquire(source, "auto", async (key) => {
    recorded = key;
  });
  assert.equal(outcome.status, "available");
  assert.equal(calls, 2);
  assert.equal(headers[0], headers[1]);
  assert.equal(headers[0], recorded);
  calls = 0;
  const proxy = createTranscriptFetchProvider(
    { apiKey: key },
    {
      fetch: async () => {
        calls++;
        return new Response(
          JSON.stringify({
            ok: false,
            error: { code: "proxy_unavailable", message: "internal secret" },
          }),
          { status: 503 },
        );
      },
    },
  );
  await assert.rejects(
    () => proxy.acquire(source, "auto"),
    (e) => e.code === "TRANSCRIPT_PROXY_UNAVAILABLE" && !e.message.includes("secret"),
  );
  assert.equal(calls, 1);
});
const source = parseYouTubeUrl("https://youtu.be/IELMSD2kdmk");
const segments = [
  { start: 0, duration: 3.439, text: "Hello everyone." },
  { start: 2, duration: 2.96, text: "Welcome back." },
];
const envelope = (data = {}) => ({
  ok: true,
  data: {
    kind: "transcript",
    video_id: source.videoId,
    segments,
    language: "en",
    source: "captions",
    ...data,
  },
  usage: { credits_spent: 1, balance: 49, bytes: 1234 },
});
function mock(body = envelope(), status = 200, extra = {}) {
  const calls = [];
  const provider = createTranscriptFetchProvider(
    { apiKey: key, ...extra },
    {
      maxRetries: 0,
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  );
  return { provider, calls };
}
describe("official TranscriptFetch SDK with mocked transport only", () => {
  it("uses installed SDK, canonical URL, explicit captions/timestamps and idempotency", async () => {
    const { provider, calls } = mock();
    const outcome = await provider.acquire(source, "en");
    assert.equal(outcome.status, "available");
    assert.equal(VERSION, "2.4.1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://transcriptfetch.com/api/v2/transcripts/video");
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      video: source.canonicalUrl,
      mode: "captions",
      timestamps: true,
    });
    assert.ok(calls[0].init.headers["Idempotency-Key"]);
    assert.equal(calls[0].init.redirect, "error");
    assert.equal(outcome.transcript.text, "Hello everyone. Welcome back.");
    assert.deepEqual(outcome.transcript.segments, segments);
    assert.equal(outcome.transcript.metadata.returnedLanguage, "en");
    assert.equal(outcome.transcript.metadata.usage.balance, 49);
  });
  it("joins segments, ignores missing/null/conflicting result.text", async () => {
    for (const text of [undefined, null, "Do not use this text"]) {
      const { provider } = mock(envelope({ text }));
      assert.equal(
        (await provider.acquire(source, "en")).transcript.text,
        segments.map((s) => s.text).join(" "),
      );
    }
  });
  it("preserves Hindi, decimal timestamps, source metadata and nulls", async () => {
    const cues = [{ start: 0.123, duration: 3.439, text: "नमस्ते दोस्तों।" }];
    const { provider } = mock(
      envelope({
        segments: cues,
        language: "hi",
        title: "हिन्दी पाठ",
        channel: "Fixture",
        duration: 9,
        url: source.canonicalUrl,
        platform: "youtube",
        thumbnail_url: null,
      }),
    );
    const result = (await provider.acquire(source, "hi")).transcript;
    assert.deepEqual(result.segments, cues);
    assert.equal(result.metadata.returnedLanguage, "hi");
    assert.equal(result.metadata.sourceMetadata.title, "हिन्दी पाठ");
    assert.equal(result.metadata.sourceMetadata.thumbnailUrl, null);
  });
  it("handles absent or null metadata without inventing language or title", async () => {
    for (const value of [undefined, null]) {
      const { provider } = mock(
        envelope({
          language: "en",
          source: value,
          title: value,
          channel: value,
          duration: value,
          url: value,
          platform: value,
        }),
      );
      const t = (await provider.acquire(source, "en")).transcript;
      assert.equal(t.metadata.returnedLanguage, "en");
      assert.deepEqual(t.metadata.sourceMetadata, {
        platform: null,
        title: null,
        channel: null,
        url: null,
        thumbnailUrl: null,
        duration: null,
        source: null,
      });
    }
  });
  it("does not pretend the SDK selects/translates language, and accepts regional tags", async () => {
    for (const language of [undefined, null, "und"])
      assert.equal(
        (await mock(envelope({ language })).provider.acquire(source, "en")).reason,
        "language_unavailable",
      );
    assert.equal((await mock().provider.acquire(source, "hi")).reason, "language_unavailable");
    assert.equal(
      (await mock(envelope({ language: "en-US" })).provider.acquire(source, "en")).transcript
        .metadata.returnedLanguage,
      "en-US",
    );
  });
  for (const [label, bad] of [
    ["empty", []],
    ["missing", undefined],
    ["null", null],
    ["missing start", [{ duration: 1, text: "x" }]],
    ["string timing", [{ start: "0", duration: 1, text: "x" }]],
    ["negative", [{ start: -1, duration: 1, text: "x" }]],
    ["empty text", [{ start: 0, duration: 1, text: " " }]],
    ["null timing", [{ start: null, duration: 1, text: "x" }]],
  ])
    it(`rejects ${label} segments before SDK normalization`, async () => {
      await assert.rejects(
        mock(envelope({ segments: bad })).provider.acquire(source, "en"),
        (e) => e.code === "TRANSCRIPT_INVALID_OUTPUT",
      );
    });
  it("does not start extraction for an invalid canonical URL or unsupported language", async () => {
    const { provider, calls } = mock();
    await assert.rejects(
      provider.acquire({ ...source, canonicalUrl: "https://evil.invalid" }, "en"),
    );
    assert.equal((await provider.acquire(source, "und")).reason, "language_unavailable");
    assert.equal(calls.length, 0);
  });
  it("rejects wrong video IDs, URLs and malformed timings/languages", async () => {
    for (const data of [
      { video_id: "AbCdEf12_-3" },
      { url: "https://www.youtube.com/watch?v=AbCdEf12_-3" },
      { duration: "30" },
      { language: 42 },
    ])
      await assert.rejects(mock(envelope(data)).provider.acquire(source, "en"));
  });
  it("accepts real SDK transcripts with diarization, audio source or unusual metadata", async () => {
    const cues = [
      { start: 0.5, duration: 2.5, text: "First.", speaker: 0 },
      { start: 3, duration: 2, text: "Second.", speaker: 1 },
    ];
    for (const data of [
      { segments: cues, source: "audio" },
      { segments: cues, source: "unknown", platform: "file" },
    ]) {
      const result = (await mock(envelope(data)).provider.acquire(source, "en")).transcript;
      assert.equal(result.text, "First. Second.");
      assert.deepEqual(
        result.segments,
        cues.map((cue) => ({ start: cue.start, duration: cue.duration, text: cue.text })),
      );
      assert.equal(result.metadata.sourceMetadata.platform, null);
      assert.equal(result.metadata.sourceMetadata.source, null);
    }
  });
  it("recovers an otherwise valid transcript carrying an unsupported language tag", async () => {
    const result = (await mock(envelope({ language: "en_US_x" })).provider.acquire(source, "auto"))
      .transcript;
    assert.equal(result.metadata.returnedLanguage, undefined);
    assert.equal(result.text, "Hello everyone. Welcome back.");
  });
  it("enforces configurable character/duration and hard byte/segment limits", async () => {
    for (const [body, config] of [
      [envelope(), { maxCharacters: 3 }],
      [envelope({ duration: 11 }), { maxDurationSeconds: 10 }],
      [envelope({ segments: [{ start: 9, duration: 2, text: "x" }] }), { maxDurationSeconds: 10 }],
      [envelope({ segments: [{ start: 0, duration: 1, text: "न".repeat(100001) }] }), {}],
      [envelope({ segments: Array(30001).fill(segments[0]) }), {}],
    ])
      await assert.rejects(
        mock(body, 200, config).provider.acquire(source, "en"),
        (e) => e.code === "TRANSCRIPT_INVALID_OUTPUT",
      );
  });
  it("bounds oversized and malformed downloads", async () => {
    for (const body of ["x".repeat(8000001), "not-json"]) {
      const p = createTranscriptFetchProvider(
        { apiKey: key },
        { fetch: async () => new Response(body) },
      );
      await assert.rejects(p.acquire(source, "en"));
    }
  });
  it("captions unavailable never follows retry_with audio", async () => {
    const { provider, calls } = mock(
      { ok: false, error: { code: "no_captions", message: key, retry_with: { mode: "audio" } } },
      422,
    );
    const result = await provider.acquire(source, "en");
    assert.equal(result.reason, "captions_unavailable");
    assert.ok(!result.message.includes(key));
    assert.equal(calls.length, 1);
  });
  for (const [status, code, expected] of [
    [401, "unauthorized", "TRANSCRIPT_ACCESS_DENIED"],
    [403, "forbidden", "TRANSCRIPT_ACCESS_DENIED"],
    [402, "insufficient_credits", "TRANSCRIPT_CREDITS_REQUIRED"],
    [429, "rate_limited", "TRANSCRIPT_RATE_LIMITED"],
    [503, "upstream_error", "TRANSCRIPT_UPSTREAM_UNAVAILABLE"],
    [500, "insufficient_credits", "TRANSCRIPT_CREDITS_REQUIRED"],
  ])
    it(`safely handles ${status}/${code} without SDK retry`, async () => {
      const { provider, calls } = mock({ ok: false, error: { code, message: key } }, status);
      await assert.rejects(
        provider.acquire(source, "en"),
        (e) => e.code === expected && !e.message.includes(key),
      );
      assert.equal(calls.length, 1);
    });
  it("processing audio responses are fenced failures, never polled", async () => {
    const { provider, calls } = mock(
      {
        ok: true,
        status: "processing",
        job_id: "job_test",
        data: { kind: "transcript_job", video_id: source.videoId },
      },
      202,
    );
    await assert.rejects(
      provider.acquire(source, "en"),
      (e) => e.code === "TRANSCRIPT_AUDIO_DISABLED",
    );
    assert.equal(calls.length, 1);
  });
  it("failed jobs are returned failures, never retried/polled", async () => {
    const { provider, calls } = mock({
      ok: true,
      status: "failed",
      error: { message: key },
      data: { kind: "transcript", video_id: source.videoId },
    });
    await assert.rejects(
      provider.acquire(source, "en"),
      (e) => e.code === "TRANSCRIPT_JOB_FAILED" && !e.message.includes(key),
    );
    assert.equal(calls.length, 1);
  });
  it("bounds header and body timeouts, without transport error leakage", async () => {
    for (const body of [false, true]) {
      let calls = 0;
      const p = createTranscriptFetchProvider(
        { apiKey: key },
        {
          timeoutMs: 10,
          fetch: async (_url, init) => {
            calls++;
            if (body)
              return new Response(
                new ReadableStream({
                  start(controller) {
                    init.signal.addEventListener(
                      "abort",
                      () => controller.error(new DOMException(key, "AbortError")),
                      { once: true },
                    );
                  },
                }),
              );
            return new Promise((_resolve, reject) =>
              init.signal.addEventListener(
                "abort",
                () => reject(new DOMException(key, "AbortError")),
                { once: true },
              ),
            );
          },
        },
      );
      await assert.rejects(
        p.acquire(source, "en"),
        (e) => e.code === "TRANSCRIPT_TIMEOUT" && !e.message.includes(key),
      );
      assert.equal(calls, 1);
    }
  });
  it("validates backend key and configurable limits; old Apify config is no longer required", () => {
    assert.equal(envSchema.safeParse({ TRANSCRIPTFETCH_API_KEY: key }).success, true);
    assert.equal(envSchema.safeParse({ TRANSCRIPTFETCH_API_KEY: key + "\n" }).success, false);
    assert.equal(envSchema.safeParse({ TRANSCRIPT_MAX_CHARACTERS: 500001 }).success, false);
    assert.equal(envSchema.safeParse({ TRANSCRIPT_MAX_DURATION_SECONDS: 18001 }).success, false);
    assert.equal(envSchema.safeParse({ APIFY_API_TOKEN: "obsolete" }).success, true);
  });
});
