import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
process.env.NODE_ENV = "test";
const { WorkspaceCache } = await import("../dist/repositories/workspace-cache.js");
const { createTutorService } = await import("../dist/services/tutor.service.js");
const { NotesGenerationError } = await import("../dist/modules/ai/gemini-notes.js");
const notebook = {
  schemaVersion: 2,
  title: "Recursion basics",
  blocks: [
    {
      type: "paragraph",
      text: "Recursion solves a problem by calling the same procedure on a smaller input.",
    },
    { type: "bullet_list", items: ["Define the base case.", "Make progress toward it."] },
  ],
  limitations: [],
};
async function fixture(work) {
  const directory = await mkdtemp(join(tmpdir(), "lecturelens-tutor-"));
  const cache = new WorkspaceCache(directory);
  try {
    await work(cache);
  } finally {
    cache.close();
    await rm(directory, { recursive: true, force: true });
  }
}
it("tutor answers are private, cached by prompt and never expose provider errors", () =>
  fixture(async (cache) => {
    let calls = 0;
    const seen = [];
    const service = createTutorService({
      cache: () => cache,
      gemini: () => ({
        model: "test-model",
        generate: async (prompt, output, options) => {
          calls++;
          seen.push({ prompt, output, options });
          return notebook;
        },
      }),
    });
    const first = await service({ prompt: "Explain recursion with a simple example." }, "owner-a");
    assert.equal(first.cached, false);
    assert.equal(first.notebook.title, "Recursion basics");
    assert.equal(calls, 1);
    assert.equal(seen[0].output, "detailed_notes");
    assert.equal(seen[0].options.task, "tutor");
    assert.equal(seen[0].options.preferences.outputLanguage, "en");
    const reused = await service({ prompt: "Explain recursion with a simple example." }, "owner-a");
    assert.equal(reused.cached, true);
    assert.equal(calls, 1);
    await service({ prompt: "Explain recursion with a simple example." }, "owner-b");
    assert.equal(calls, 2, "another owner must not receive a private cached answer");
    await assert.rejects(() => service({ prompt: "x" }, "owner-a"), /too small|at least/i);
    let failureCalls = 0;
    const failing = createTutorService({
      cache: () => cache,
      gemini: () => ({
        model: "test-model",
        generate: async () => {
          failureCalls++;
          throw new NotesGenerationError("GEMINI_INVALID_OUTPUT", "private provider detail");
        },
      }),
    });
    await assert.rejects(
      () => failing({ prompt: "Explain a completely different topic." }, "owner-a"),
      (error) =>
        error.code === "TUTOR_FAILED" &&
        !error.message.includes("private provider detail") &&
        !error.message.includes("Gemini"),
    );
    assert.equal(failureCalls, 1);
  }));
it("the English-policy cache change never bypasses an older uncertain tutor job", () =>
  fixture(async (cache) => {
    const prompt = "Explain recursion in Hindi.",
      ownerId = "owner-a";
    const legacy = createHash("sha256")
      .update(
        JSON.stringify({
          ownerId,
          prompt,
          model: "test-model",
          version: "urtutor-question-v1",
          schema: 2,
        }),
      )
      .digest("hex");
    const token = cache.claim(legacy, legacy);
    cache.evidence(legacy, token, { kind: "dispatch" });
    cache.fail(legacy, token, "GEMINI_UNCERTAIN", false);
    let calls = 0;
    const service = createTutorService({
      cache: () => cache,
      gemini: () => ({
        model: "test-model",
        generate: async () => {
          calls++;
          return notebook;
        },
      }),
    });
    await assert.rejects(
      () => service({ prompt }, ownerId),
      (error) => error.code === "TUTOR_PENDING",
    );
    assert.equal(calls, 0);
  }));
it("switching to FreeGG does not replay an uncertain Gemini tutor request", () =>
  fixture(async (cache) => {
    const previous = process.env.GEMINI_MODEL;
    process.env.GEMINI_MODEL = "gemini-previous";
    try {
      const prompt = "Explain recursion in Hindi.",
        ownerId = "owner-a";
      const operation = createHash("sha256")
        .update(
          JSON.stringify({
            ownerId,
            prompt,
            model: "gemini-previous",
            version: "urtutor-question-v1",
            schema: 2,
          }),
        )
        .digest("hex");
      const key = createHash("sha256").update(`${operation}:english-v2`).digest("hex");
      const token = cache.claim(key, operation);
      cache.evidence(key, token, { kind: "dispatch" });
      cache.fail(key, token, "GEMINI_UNCERTAIN", false);
      let calls = 0;
      const service = createTutorService({
        cache: () => cache,
        gemini: () => ({
          model: "freegg:gpt-6.1-sol",
          generate: async () => {
            calls++;
            return notebook;
          },
        }),
      });
      await assert.rejects(
        () => service({ prompt }, ownerId),
        (e) => e.code === "TUTOR_PENDING",
      );
      assert.equal(calls, 0);
    } finally {
      if (previous === undefined) delete process.env.GEMINI_MODEL;
      else process.env.GEMINI_MODEL = previous;
    }
  }));
it("switching Ask doubts from FreeGG to Gemini preserves the previous uncertain fence", () =>
  fixture(async (cache) => {
    const { env } = await import("../dist/config/env.js");
    const prompt = "Explain stack memory.",
      ownerId = "owner-a";
    const operation = createHash("sha256")
      .update(
        JSON.stringify({
          ownerId,
          prompt,
          model: `freegg:${env.FREEGG_MODEL}`,
          version: "urtutor-question-v1",
          schema: 2,
        }),
      )
      .digest("hex");
    const key = createHash("sha256").update(`${operation}:english-v2`).digest("hex");
    const token = cache.claim(key, operation);
    cache.evidence(key, token, { kind: "dispatch" });
    cache.fail(key, token, "GEMINI_UNCERTAIN", false);
    let calls = 0;
    const service = createTutorService({
      cache: () => cache,
      gemini: () => ({
        model: "gemini-3.5-flash-lite",
        generate: async () => {
          calls++;
          return notebook;
        },
      }),
    });
    await assert.rejects(
      () => service({ prompt }, ownerId),
      (error) => error.code === "TUTOR_PENDING",
    );
    assert.equal(calls, 0);
  }));
