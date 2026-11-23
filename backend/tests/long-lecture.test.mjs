import assert from "node:assert/strict";
import { it } from "node:test";
import {
  parseYouTubeUrl,
  transcriptTextSchema,
  MAX_TRANSCRIPT_CHARACTERS,
} from "@lecturelens/contracts";
import { createTranscriptFetchProvider } from "../dist/modules/extraction/transcriptfetch-transcript.js";
import { createGeminiStudyGenerator } from "../dist/modules/ai/gemini-study.js";

it("a 120k-character Hindi lecture survives parsing and lossless generation for all six English outputs", async () => {
  const source = parseYouTubeUrl("https://youtu.be/K6BCYpTuwa0");
  const segments = Array.from({ length: 3200 }, (_, i) => ({
    start: i * 2,
    duration: 2,
    text: "कंप्यूटर के संगठन और संरचना को समझना जरूरी है।",
  }));
  const text = segments.map((s) => s.text).join(" ");
  assert.ok(text.length > 100000);
  const provider = createTranscriptFetchProvider(
    { apiKey: "synthetic-test-key" },
    {
      maxRetries: 0,
      fetch: async () =>
        new Response(
          JSON.stringify({
            ok: true,
            data: {
              kind: "transcript",
              video_id: source.videoId,
              segments,
              duration: 6521,
              language: "hi",
              source: "captions",
            },
          }),
        ),
    },
  );
  const outcome = await provider.acquire(source, "auto");
  assert.equal(outcome.status, "available");
  assert.equal(outcome.transcript.text, text);
  assert.equal(outcome.transcript.metadata.language, "hi");
  const generator = createGeminiStudyGenerator("test-model", {
    get: async () => ({
      name: "models/test-model",
      supportedActions: ["generateContent"],
      inputTokenLimit: 1000000,
      outputTokenLimit: 32768,
    }),
    generateContent: async (input) => {
      const payload = JSON.parse(input.contents[0].parts[0].text);
      assert.equal((payload.sourceSegments ?? [payload.source]).join(""), text);
      assert.match(input.config.systemInstruction, /Always write every generated.*in English/);
      assert.doesNotMatch(
        input.config.systemInstruction,
        /follow any requested output language|do not automatically translate/,
      );
      const type = payload.requestedOutput;
      let blocks = [
        { type: "paragraph", text: "Computer organization explains how components work together." },
      ];
      if (type === "flashcards")
        blocks = Array.from({ length: 10 }, () => ({
          type: "flashcard",
          question: "What is a CPU?",
          answer: "The central processing unit.",
        }));
      if (type === "mcq_quiz")
        blocks = Array.from({ length: 10 }, () => ({
          type: "quiz",
          question: "Which unit executes instructions?",
          options: ["CPU", "Keyboard", "Screen", "Printer"],
          answerIndex: 0,
          explanation: "The CPU executes instructions.",
        }));
      if (type === "mindmap")
        blocks = [
          { type: "mindmap", title: "Computer", nodes: [{ id: "cpu", label: "CPU" }], edges: [] },
        ];
      if (type === "sample_question_paper")
        blocks = [
          { type: "section", text: "Questions" },
          { type: "numbered_list", items: ["Explain the CPU."] },
          ...blocks,
        ];
      return {
        text: JSON.stringify({
          schemaVersion: 2,
          title: "Computer organization",
          blocks,
          limitations: [],
        }),
        candidates: [{ finishReason: "STOP" }],
      };
    },
  });
  for (const output of [
    "detailed_notes",
    "short_notes",
    "flashcards",
    "mcq_quiz",
    "mindmap",
    "sample_question_paper",
  ])
    await generator(text, output, {
      sourceLanguage: "hi",
      preferences: {
        notesStyle: "classroom",
        tone: "academic",
        format: "mixed",
        examples: "simple",
        outputLanguage: "hi",
      },
    });
  assert.equal(
    transcriptTextSchema.safeParse("x".repeat(MAX_TRANSCRIPT_CHARACTERS + 1)).success,
    false,
  );
});
