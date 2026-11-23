import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "express";
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
const { WorkspaceCache } = await import("../dist/repositories/workspace-cache.js");
const { createWorkspaceService } = await import("../dist/services/workspace.service.js");
const { createWorkspaceRouter } = await import("../dist/routes/workspace.routes.js");
const { createApp } = await import("../dist/app.js");
const { NotesGenerationError } = await import("../dist/modules/ai/gemini-notes.js");
import { textPdf, workbook, csv } from "./helpers/documents.mjs";
const notebook = {
  schemaVersion: 2,
  title: "Source-grounded test material",
  blocks: [{ type: "paragraph", text: "A transport fixture, not a live Gemini result." }],
  limitations: ["Provider mocked in this test."],
};
async function withCache(fn) {
  const dir = await mkdtemp(join(tmpdir(), "lecturelens-workspace-"));
  const cache = new WorkspaceCache(dir);
  try {
    await fn(cache, dir);
  } finally {
    cache.close();
    await rm(dir, { recursive: true, force: true });
  }
}
it("actual HTTP uploads/parsers and stage stream pass real PDF/XLSX/XLS/CSV text to injected Gemini and reuse durable cache", async () =>
  withCache(async (cache) => {
    const inputs = [];
    const service = createWorkspaceService({
      cache: () => cache,
      gemini: () => ({
        model: "test-model",
        generate: async (text, output) => {
          inputs.push({ text, output });
          return notebook;
        },
      }),
    });
    const router = Router();
    router.use("/workspace", createWorkspaceRouter(service));
    const server = createApp(router).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const request = async (bytes, name, sourceType) => {
      const data = new FormData();
      data.append(
        "options",
        JSON.stringify({ sourceType, outputTypes: ["detailed_notes", "flashcards"] }),
      );
      data.append("file", new Blob([bytes]), name);
      const res = await fetch(
        `http://127.0.0.1:${server.address().port}/api/v1/workspace/process`,
        { method: "POST", body: data },
      );
      assert.equal(res.status, 200);
      return (await res.text()).trim().split("\n").map(JSON.parse);
    };
    try {
      for (const [bytes, name, type] of [
        [await textPdf(), "a.pdf", "pdf"],
        [workbook(), "a.xlsx", "spreadsheet"],
        [workbook("xls"), "a.xls", "spreadsheet"],
        [csv, "a.csv", "spreadsheet"],
      ]) {
        const events = await request(bytes, name, type);
        const result = events.at(-1).result;
        assert.equal(result.status, "ready");
        assert.equal(result.materials.length, 2);
        assert.match(inputs.at(-1).text, /Atomicity/);
        assert.deepEqual(
          events
            .filter((e) => e.event === "stage" && !e.outputType)
            .map((e) => e.stage)
            .filter(
              (stage, index, stages) =>
                stage !== "extracting" || stages[index - 1] !== "extracting",
            ),
          [
            "validating",
            "extracting",
            "preparing",
            ...result.materials.filter((m) => !m.cached).map(() => "generating"),
            "rendering",
          ],
        );
        const count = inputs.length;
        const cached = await request(bytes, name, type);
        assert.equal(
          cached.at(-1).result.materials.every((m) => m.cached),
          true,
        );
        assert.equal(inputs.length, count);
        const renamed = await request(bytes, "bad.exe", type);
        assert.equal(
          renamed.at(-1).event,
          "error",
          "cached bytes cannot bypass file-extension validation",
        );
      }
      const bad = await request(Buffer.from("not pdf"), "bad.pdf", "pdf");
      assert.equal(bad.at(-1).event, "error");
      assert.equal(bad.at(-1).retryable, true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }));
it("SQLite claims protect concurrent processes, retain cached notes after reopen, and fence unknown failures", async () =>
  withCache(async (cache, dir) => {
    const second = new WorkspaceCache(dir);
    try {
      const token = cache.claim("one");
      assert.ok(token);
      assert.equal(second.claim("one"), null);
      cache.finish("one", token, notebook);
      assert.deepEqual(second.material("one"), notebook);
      const failed = cache.claim("bad");
      cache.fail("bad", failed, "GEMINI_UNCERTAIN", false);
      assert.throws(
        () => second.claim("bad"),
        (error) => error.code === "JOB_RECOVERY_REQUIRED",
      );
    } finally {
      second.close();
    }
  }));
it("all six outputs are actually dispatched, never silently ignored", async () =>
  withCache(async (cache) => {
    const outputs = [
      "detailed_notes",
      "short_notes",
      "flashcards",
      "mcq_quiz",
      "mindmap",
      "sample_question_paper",
    ];
    const calls = [];
    const service = createWorkspaceService({
      cache: () => cache,
      gemini: () => ({
        model: "test",
        generate: async (_text, type) => {
          calls.push(type);
          return notebook;
        },
      }),
    });
    const result = await service(
      { sourceType: "spreadsheet", outputTypes: outputs },
      { buffer: csv, originalname: "test.csv" },
      () => {},
    );
    assert.deepEqual(calls, outputs);
    assert.equal(result.materials.length, 6);
  }));
it("unavailable YouTube captions are rejected without a public feed", async () =>
  withCache(async (cache) => {
    let acquisitions = 0;
    const service = createWorkspaceService({
      cache: () => cache,
      resources: { ensureSource: async () => "source", findTranscript: async () => null },
      provider: {
        acquire: async () => {
          acquisitions++;
          return {
            schemaVersion: 1,
            status: "unavailable",
            reason: "captions_unavailable",
            message: "No captions available",
          };
        },
      },
      gemini: () => ({
        model: "test",
        generate: async () => {
          throw new Error("Must not generate unrelated notes");
        },
      }),
    });
    const request = {
      sourceType: "youtube",
      url: "https://youtu.be/AbCdEf12_-3",
      outputTypes: ["detailed_notes"],
    };
    await assert.rejects(
      () => service(request, undefined, () => {}),
      (e) => e.code === "TRANSCRIPT_UNAVAILABLE",
    );
    cache.publishGallery(notebook, "IELMSD2kdmk");
    await assert.rejects(
      () => service(request, undefined, () => {}),
      (e) => e.code === "TRANSCRIPT_UNAVAILABLE",
    );
    cache.publishGallery(notebook, "AbCdEf12_-3");
    await assert.rejects(
      () => service(request, undefined, () => {}),
      (e) => e.code === "TRANSCRIPT_UNAVAILABLE",
    );
    assert.equal(
      acquisitions,
      1,
      "remember missing captions instead of triggering a fenced-failure response or duplicate provider call",
    );
    await assert.rejects(service({ ...request, url: "https://evil.com" }, undefined, () => {}));
  }));
it("quota retries stay bounded and unknown paid-call failures do not replay", async () =>
  withCache(async (cache) => {
    let calls = 0;
    const service = createWorkspaceService({
      cache: () => cache,
      gemini: () => ({
        model: "test",
        generate: async () => {
          calls++;
          throw new NotesGenerationError("GEMINI_QUOTA", "Quota unavailable", true, 429);
        },
      }),
    });
    const input = { sourceType: "spreadsheet", outputTypes: ["short_notes"] };
    await assert.rejects(service(input, { buffer: csv, originalname: "a.csv" }, () => {}));
    assert.equal(
      (await service(input, { buffer: csv, originalname: "a.csv" }, () => {})).status,
      "pending",
    );
    assert.equal(calls, 1);
  }));
