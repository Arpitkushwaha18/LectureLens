import assert from "node:assert/strict";
import { it } from "node:test";
import {
  chunkSource,
  createLongSourceGenerator,
  mergeNotebooks,
} from "../dist/modules/ai/long-source.js";
import { createProviderManager } from "../dist/modules/ai/provider-manager.js";
import { createGeminiStudyGenerator } from "../dist/modules/ai/gemini-study.js";

const make = (text) => ({
  schemaVersion: 2,
  title: "Lecture",
  blocks: [{ type: "paragraph", text }],
  limitations: [],
});
it("500,000-character Unicode transcript chunks retain every original character, with bounded token estimates and overlap", () => {
  const text = "Recursion needs a base case. कंप्यूटर सूत्र √n.\n".repeat(20000).slice(0, 500000);
  const chunks = chunkSource(text, 12000, 150);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.map((c) => text.slice(c.coreStart, c.end)).join(""), text);
  for (const [index, chunk] of chunks.entries()) {
    assert.ok(chunk.tokens <= 12000);
    assert.equal(chunk.text, text.slice(chunk.start, chunk.end));
    if (index) assert.ok(chunk.start < chunk.coreStart);
    assert.doesNotMatch(chunk.text, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
  }
});
it("chunk count/configuration limits fail explicitly rather than truncate the source", () => {
  assert.throws(
    () => chunkSource("word ".repeat(10000), 1000, 20, 1),
    (e) => e.code === "AI_SOURCE_LIMIT",
  );
  assert.throws(
    () => chunkSource("source", 100, 100),
    (e) => e.code === "AI_CONFIGURATION",
  );
});
it("completed chunks are retained request-locally while the failed chunk retries; repeated source starts anew", async () => {
  const text = "Lecture concept atomicity and transactions.\n".repeat(300);
  const chunks = chunkSource(text, 1000, 20);
  const attempts = new Map();
  const progress = [];
  const provider = {
    id: "groq",
    model: "fixture",
    supportsPdf: false,
    generateContent: async (input) => {
      const payload = JSON.parse(input.contents[0].parts[0].text);
      const index = payload.sourcePart.index;
      attempts.set(index, (attempts.get(index) ?? 0) + 1);
      if (index === 2 && attempts.get(index) === 1)
        throw { status: 503, headers: new Headers({ "retry-after": "0" }) };
      return {
        text: JSON.stringify(make(`Concepts from source part ${index}.`)),
        candidates: [{ finishReason: "STOP" }],
      };
    },
  };
  const manager = createProviderManager(
    {
      primary: "groq",
      fallback: "none",
      providers: { groq: provider },
      concurrency: 1,
      maxQueue: 1,
      intervalMs: 0,
      timeoutMs: 1000,
      retries: 1,
      maxRetryWaitMs: 5000,
      maxOutputTokens: 4096,
      temperature: 0.2,
    },
    { random: () => 0, wait: async () => {} },
  );
  const generate = createLongSourceGenerator(createGeminiStudyGenerator("fixture", manager), {
    chunkTokens: 1000,
    overlapTokens: 20,
    maxChunks: 128,
    timeoutMs: 10000,
  });
  const result = await generate(text, "detailed_notes", {
    onChunkProgress: (done, total) => progress.push([done, total]),
  });
  assert.equal(attempts.get(1), 1);
  assert.equal(attempts.get(2), 2);
  assert.ok(result.blocks.some((b) => b.text.includes(`part ${chunks.length}`)));
  assert.deepEqual(progress.at(-1), [chunks.length, chunks.length]);
  await generate(text, "detailed_notes");
  assert.equal(attempts.get(1), 2);
});
it("midway Groq failure preserves earlier chunks and switches subsequent chunks to FreeGG during cooldown", async () => {
  let primary = 0,
    fallback = 0;
  const response = (text) => ({
    text: JSON.stringify(make(text)),
    candidates: [{ finishReason: "STOP" }],
  });
  const manager = createProviderManager(
    {
      primary: "groq",
      fallback: "freegg",
      providers: {
        groq: {
          id: "groq",
          model: "fixture",
          supportsPdf: false,
          generateContent: async () => {
            if (++primary === 2)
              throw { status: 429, headers: new Headers({ "retry-after": "120" }) };
            return response("Preserved early concepts.");
          },
        },
        freegg: {
          id: "freegg",
          model: "fixture",
          supportsPdf: true,
          generateContent: async () => response(`Later concepts ${++fallback}.`),
        },
      },
      concurrency: 1,
      maxQueue: 1,
      intervalMs: 0,
      timeoutMs: 1000,
      retries: 0,
      maxRetryWaitMs: 0,
      maxOutputTokens: 4096,
      temperature: 0.2,
    },
    { wait: async () => {} },
  );
  const generate = createLongSourceGenerator(createGeminiStudyGenerator("fixture", manager), {
    chunkTokens: 1000,
    overlapTokens: 20,
    maxChunks: 128,
    timeoutMs: 10000,
  });
  const result = await generate(
    "Important engineering definitions and examples. ".repeat(500),
    "detailed_notes",
  );
  assert.equal(primary, 2);
  assert.ok(fallback > 1);
  assert.match(result.blocks.map((b) => b.text).join("\n"), /Preserved early concepts/);
});
it("merging removes exact duplicate overlap without dropping unique definitions, formulas or diagrams", () => {
  const definition = { type: "definition", term: "Atomicity", text: "All changes or none." };
  const formula = { type: "formula", text: "E=mc^2" };
  const diagram = {
    type: "diagram",
    title: "Flow",
    nodes: [{ id: "a", label: "Start" }],
    edges: [],
  };
  const result = mergeNotebooks(
    [
      { ...make("First example."), blocks: [definition, formula] },
      { ...make("Second example."), blocks: [definition, diagram] },
    ],
    "detailed_notes",
  );
  assert.deepEqual(result.blocks, [definition, formula, diagram]);
  const titled = mergeNotebooks(
    [
      make("First topic."),
      {
        ...make("Second topic."),
        title: "Applications",
        blocks: [{ type: "title", text: "Practical engineering" }],
      },
    ],
    "detailed_notes",
  );
  assert.ok(titled.blocks.some((b) => b.text === "Applications"));
  assert.ok(titled.blocks.some((b) => b.text === "Practical engineering"));
});
it("long transcript practice items retain the exact requested count and sample across all source parts", async () => {
  const generate = createLongSourceGenerator(
    async (_text, output, counts) => ({
      ...make("fixture"),
      blocks: Array.from({ length: counts.chunkItemCount }, (_, i) =>
        output === "flashcards"
          ? {
              type: "flashcard",
              question: `Part ${counts.chunkPosition.index}, concept ${i}?`,
              answer: "Source-grounded answer.",
            }
          : {
              type: "quiz",
              question: `Part ${counts.chunkPosition.index}, concept ${i}?`,
              options: ["A", "B", "C", "D"],
              answerIndex: 0,
              explanation: "Source-grounded explanation.",
            },
      ),
    }),
    { chunkTokens: 1000, overlapTokens: 20, maxChunks: 128, timeoutMs: 10000 },
  );
  for (const output of ["flashcards", "mcq_quiz"]) {
    const result = await generate(
      "Important engineering concepts, definitions and examples. ".repeat(500),
      output,
      { flashcardCount: 5, quizCount: 5 },
    );
    assert.equal(result.blocks.length, 5);
    assert.match(result.blocks[0].question, /Part 1/);
    assert.notEqual(result.blocks.at(-1).question, result.blocks[0].question);
  }
});
it("irreducible output limits and permanent chunk failure never publish partial successful notes", async () => {
  assert.throws(
    () =>
      mergeNotebooks(
        [
          {
            ...make("text"),
            blocks: Array.from({ length: 161 }, (_, i) => ({
              type: "definition",
              term: `Term ${i}`,
              text: "Explanation.",
            })),
          },
        ],
        "detailed_notes",
      ),
    (e) => e.code === "AI_OUTPUT_LIMIT",
  );
  let calls = 0;
  const generate = createLongSourceGenerator(
    async () => {
      if (++calls === 2) throw new Error("chunk failure");
      return make("First completed part.");
    },
    { chunkTokens: 1000, overlapTokens: 20, maxChunks: 128, timeoutMs: 10000 },
  );
  await assert.rejects(
    generate("Important source data. ".repeat(1000), "detailed_notes"),
    /chunk failure/,
  );
  assert.equal(calls, 2);
});
