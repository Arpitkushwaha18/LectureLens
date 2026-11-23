import assert from "node:assert/strict";
import { it } from "node:test";
import { parseYouTubeUrl } from "@lecturelens/contracts";
import { createTranscriptFetchProvider } from "../dist/modules/extraction/transcriptfetch-transcript.js";
import { createGeminiStudyGenerator } from "../dist/modules/ai/gemini-study.js";
import { generationBudget } from "../dist/modules/ai/source-preparation.js";

const source = parseYouTubeUrl("https://youtu.be/K6BCYpTuwa0");
const segments = Array.from({ length: 9000 }, (_, i) => ({
  start: i * 2,
  duration: 2,
  text: "कंप्यूटर संगठन में निर्देश और स्मृति महत्वपूर्ण हैं।",
}));
const text = segments.map((s) => s.text).join(" ");
const wire = (duration) =>
  JSON.stringify({
    ok: true,
    data: {
      kind: "transcript",
      video_id: source.videoId,
      segments,
      language: "hi",
      source: "captions",
      duration,
    },
  });
it("a full five-hour Unicode lecture is fetched and passed losslessly to notes generation, using real token-count preflight instead of a byte count", async () => {
  const provider = createTranscriptFetchProvider(
    { apiKey: "synthetic-test-key" },
    { maxRetries: 0, fetch: async () => new Response(wire(18000)) },
  );
  const outcome = await provider.acquire(source, "auto");
  assert.equal(outcome.status, "available");
  assert.equal(outcome.transcript.text, text);
  assert.ok(text.length < 500000);
  assert.ok(Buffer.byteLength(text) > 1000000);
  let tokenChecks = 0,
    paidCalls = 0;
  const generator = createGeminiStudyGenerator("test-model", {
    get: async () => ({
      name: "models/test-model",
      supportedActions: ["generateContent"],
      inputTokenLimit: 1000000,
      outputTokenLimit: 32768,
    }),
    countTokens: async ({ contents }) => {
      tokenChecks++;
      assert.equal(JSON.parse(contents).sourceSegments.join(""), text);
      return { totalTokens: 300000 };
    },
    generateContent: async (input) => {
      paidCalls++;
      assert.equal(JSON.parse(input.contents[0].parts[0].text).sourceSegments.join(""), text);
      assert.match(input.config.systemInstruction, /in English/);
      return {
        text: JSON.stringify({
          schemaVersion: 2,
          title: "Computer organization",
          blocks: [
            {
              type: "paragraph",
              text: "Instructions define the operations performed by a computer.",
            },
          ],
          limitations: [],
        }),
        candidates: [{ finishReason: "STOP" }],
      };
    },
  });
  await generator(outcome.transcript.text, "detailed_notes", { sourceLanguage: "hi" });
  assert.equal(tokenChecks, 1);
  assert.equal(paidCalls, 1);
  assert.equal(generationBudget(text.length, true).timeoutMs, 300000);
});
it("a video longer than five hours is rejected before any notes request", async () => {
  const provider = createTranscriptFetchProvider(
    { apiKey: "synthetic-test-key" },
    { maxRetries: 0, fetch: async () => new Response(wire(18001)) },
  );
  await assert.rejects(
    () => provider.acquire(source, "auto"),
    (e) => e.code === "TRANSCRIPT_INVALID_OUTPUT",
  );
});
