import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { requestDetailedNotes } from "../.cache/workspace-tests/features/workspace/notes-api.js";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const url = "https://youtu.be/AbCdEf12_-3";
const source = {
  schemaVersion: 1,
  kind: "youtube",
  videoId: "AbCdEf12_-3",
  canonicalUrl: "https://www.youtube.com/watch?v=AbCdEf12_-3",
};
const signal = () => new AbortController().signal;
const mock = (data, status = 200) => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
};
describe("B3 frontend API; mocked responses, not live integration", () => {
  it("validates requests before network access", async () => {
    globalThis.fetch = async () => {
      throw new Error("must not call");
    };
    await assert.rejects(
      requestDetailedNotes("http://fixture.invalid", { url: "not-youtube" }, signal()),
    );
    await assert.rejects(
      requestDetailedNotes(
        "http://fixture.invalid",
        { url, transcript: "private", shareConsent: false },
        signal(),
      ),
    );
  });
  it("handles explicit transcript-unavailable and processing responses", async () => {
    mock({ status: "extracting", source, retryAfterSeconds: 3 }, 202);
    assert.equal(
      (await requestDetailedNotes("http://fixture.invalid", { url }, signal())).status,
      "extracting",
    );
    mock({
      status: "transcript_required",
      source,
      provider: {
        schemaVersion: 1,
        status: "unavailable",
        reason: "provider_not_configured",
        message: "Paste a transcript.",
      },
    });
    assert.equal(
      (await requestDetailedNotes("http://fixture.invalid", { url }, signal())).status,
      "transcript_required",
    );
    mock(
      {
        status: "processing",
        source,
        contentId: "11111111-1111-4111-8111-111111111111",
        retryAfterSeconds: 3,
      },
      202,
    );
    assert.equal(
      (await requestDetailedNotes("http://fixture.invalid", { url }, signal())).status,
      "processing",
    );
  });
  it("validates ready notes and preserves cache metadata", async () => {
    mock({
      status: "ready",
      source,
      contentId: "11111111-1111-4111-8111-111111111111",
      cached: true,
      transcript: {
        id: "22222222-2222-4222-8222-222222222222",
        contentHash: "0".repeat(64),
        provenance: "manual",
        reused: true,
      },
      notes: {
        schemaVersion: 1,
        title: "Fixture",
        overview: "Technical fixture.",
        sections: [{ heading: "Topic", explanation: "Explanation.", keyPoints: ["A point."] }],
        takeaways: ["A takeaway."],
        limitations: [],
      },
    });
    assert.equal(
      (await requestDetailedNotes("http://fixture.invalid", { url }, signal())).cached,
      true,
    );
    mock({ status: "ready", notes: { fake: "not notes" } });
    await assert.rejects(
      requestDetailedNotes("http://fixture.invalid", { url }, signal()),
      /invalid notes response/,
    );
  });
  it("displays honest backend failures rather than generating a local substitute", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ error: { code: "GEMINI_QUOTA", message: "Quota unavailable." } }),
        { status: 429 },
      );
    await assert.rejects(
      requestDetailedNotes("http://fixture.invalid", { url }, signal()),
      /Quota unavailable/,
    );
  });
});
