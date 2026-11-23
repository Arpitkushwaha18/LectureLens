import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detailedNotesSchema,
  notesRequestSchema,
  manualNotesTranscriptSchema,
  generationOutputTypeSchema,
  generationOutputTypeV2Schema,
  transcriptProviderOutcomeSchema,
  notesOutcomeSchema,
  parseYouTubeUrl,
} from "../dist/index.js";
describe("B3 additive detailed notes contracts", () => {
  it("preserves nullable caption metadata and validates returned usage", () => {
    const outcome = {
      schemaVersion: 1,
      status: "available",
      transcript: {
        text: "fixture",
        segments: [{ start: 0, duration: 1, text: "fixture" }],
        metadata: {
          schemaVersion: 1,
          videoId: "AbCdEf12_-3",
          language: "en",
          returnedLanguage: "en",
          provenance: "licensed_provider",
          provider: { id: "transcriptfetch", version: "sdk-2.4.1-captions-v1" },
          characterCount: 7,
          obtainedAt: "2026-11-21T00:00:00.000Z",
          sourceMetadata: {
            platform: "youtube",
            title: null,
            channel: null,
            url: null,
            thumbnailUrl: null,
            duration: null,
            source: "captions",
          },
          usage: { creditsSpent: 1, balance: null, bytes: 12 },
        },
      },
    };
    assert.equal(transcriptProviderOutcomeSchema.safeParse(outcome).success, true);
    assert.equal(
      transcriptProviderOutcomeSchema.safeParse({
        ...outcome,
        transcript: {
          ...outcome.transcript,
          metadata: {
            ...outcome.transcript.metadata,
            usage: { creditsSpent: 1, balance: -1, bytes: 12 },
          },
        },
      }).success,
      false,
    );
  });
  it("accepts extraction progress without a Gemini job or content ID", () => {
    assert.equal(
      notesOutcomeSchema.safeParse({
        status: "extracting",
        source: parseYouTubeUrl("https://youtu.be/AbCdEf12_-3"),
        retryAfterSeconds: 3,
      }).success,
      true,
    );
  });
  it("preserves optional segments and requested language without claiming a returned language", () => {
    const outcome = {
      schemaVersion: 1,
      status: "available",
      transcript: {
        text: "fixture",
        segments: [{ start: 0, duration: 3.439, text: "fixture" }],
        metadata: {
          schemaVersion: 1,
          videoId: "AbCdEf12_-3",
          language: "hi",
          requestedLanguage: "hi",
          provenance: "licensed_provider",
          provider: { id: "transcriptfetch", version: "sdk-2.4.1-captions-v1" },
          characterCount: 7,
          obtainedAt: "2026-11-21T00:00:00.000Z",
        },
      },
    };
    assert.equal(transcriptProviderOutcomeSchema.safeParse(outcome).success, true);
    assert.equal(
      transcriptProviderOutcomeSchema.parse(outcome).transcript.metadata.returnedLanguage,
      undefined,
    );
    assert.equal(
      transcriptProviderOutcomeSchema.safeParse({
        ...outcome,
        transcript: {
          ...outcome.transcript,
          segments: [{ start: 0, duration: 1, text: "mismatch" }],
        },
      }).success,
      false,
    );
  });
  it("preserves the V1 and six-output V2 selections", () => {
    assert.equal(generationOutputTypeSchema.options.length, 4);
    assert.equal(generationOutputTypeV2Schema.options.length, 6);
    assert.ok(generationOutputTypeV2Schema.options.includes("sample_question_paper"));
  });
  it("requires a valid YouTube URL and consent for manual public transcripts", () => {
    assert.equal(
      notesRequestSchema.safeParse({ url: "https://youtu.be/AbCdEf12_-3" }).success,
      true,
    );
    assert.equal(notesRequestSchema.safeParse({ url: "https://evil.invalid" }).success, false);
    assert.equal(
      notesRequestSchema.safeParse({ url: "https://youtu.be/AbCdEf12_-3", transcript: "fixture" })
        .success,
      false,
    );
  });
  it("enforces character, byte, null-byte and empty-text limits", () => {
    for (const text of [" ", "x".repeat(100001), "界".repeat(100001), "null\u0000byte"])
      assert.equal(manualNotesTranscriptSchema.safeParse(text).success, false);
    assert.equal(manualNotesTranscriptSchema.parse(" fixture "), "fixture");
    assert.equal(manualNotesTranscriptSchema.parse("界".repeat(100000)).length, 100000);
  });
  it("rejects loose model payloads, unknown fields and empty sections", () => {
    const fixture = {
      schemaVersion: 1,
      title: "Fixture",
      overview: "Technical fixture.",
      sections: [{ heading: "Topic", explanation: "Explanation", keyPoints: ["point"] }],
      takeaways: ["takeaway"],
      limitations: [],
    };
    assert.equal(detailedNotesSchema.safeParse(fixture).success, true);
    for (const invalid of [
      { ...fixture, sections: [] },
      { ...fixture, actualPYQs: [] },
      { ...fixture, schemaVersion: 2 },
      { ...fixture, title: "" },
    ])
      assert.equal(detailedNotesSchema.safeParse(invalid).success, false);
  });
});
