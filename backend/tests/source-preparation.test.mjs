import { it } from "node:test";
import assert from "node:assert/strict";
import {
  prepareGenerationSource,
  generationBudget,
} from "../dist/modules/ai/source-preparation.js";
import { createGeminiStudyGenerator } from "../dist/modules/ai/gemini-study.js";
it("lossless segmentation preserves all English/Hindi content and Unicode pairs up to 500000 characters", () => {
  for (const text of [
    "Line about transactions and consistency.\n".repeat(2400),
    "लेन-देन में सभी बदलाव एक साथ होते हैं।\n".repeat(2200),
    "a".repeat(11999) + "🧠" + "b".repeat(85000),
    "Long lecture content. ".repeat(20000),
  ]) {
    const prepared = prepareGenerationSource(text);
    assert.equal(prepared.segments.join(""), text);
    assert.ok(
      prepared.segments.every(
        (segment) => segment.length <= 12000 && !/[\uD800-\uDBFF]$/.test(segment),
      ),
    );
  }
  assert.throws(() => prepareGenerationSource("x".repeat(500001)));
});
it("large source uses a single bounded Gemini request with all segments and adequate output budget", async () => {
  const source = "Consistency prevents invalid data.\n".repeat(2800);
  let request,
    calls = 0;
  const generate = createGeminiStudyGenerator("gemini-3.5-flash", {
    get: async () => ({
      name: "models/gemini-3.5-flash",
      supportedActions: ["generateContent"],
      inputTokenLimit: 1048576,
      outputTokenLimit: 65536,
    }),
    generateContent: async (input) => {
      request = input;
      calls++;
      return {
        candidates: [{ finishReason: "STOP" }],
        text: JSON.stringify({
          schemaVersion: 2,
          title: "Transactions",
          blocks: [{ type: "paragraph", text: "Source grounded notes." }],
          limitations: [],
        }),
      };
    },
  });
  await generate(source, "detailed_notes");
  assert.equal(calls, 1);
  assert.equal(JSON.parse(request.contents[0].parts[0].text).sourceSegments.join(""), source);
  assert.equal(request.config.maxOutputTokens, 32768);
  assert.equal(request.config.httpOptions.timeout, 180000);
  assert.equal(request.config.thinkingConfig.thinkingLevel, "LOW");
  assert.equal(request.config.httpOptions.retryOptions.attempts, 1);
  assert.equal(generationBudget(100000, false).maxOutputTokens, 16384);
});
