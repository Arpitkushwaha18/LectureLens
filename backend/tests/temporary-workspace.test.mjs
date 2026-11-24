import assert from "node:assert/strict";
import { it } from "node:test";
import { createTemporaryWorkspaceService } from "../dist/services/temporary-workspace.service.js";
import { extractDocument } from "../dist/modules/extraction/documents.js";
import { NotesGenerationError } from "../dist/modules/ai/gemini-notes.js";
import { textPdf, workbook, csv } from "./helpers/documents.mjs";
import { notebookFixture as notebook } from "../../frontend/tests/helpers/notebook-fixture.mjs";

it("temporary generation rereads identical PDFs/spreadsheets without records and forwards PDF bytes", async () => {
  let extracted = 0,
    generated = 0;
  const service = createTemporaryWorkspaceService({
    extract: async (...args) => {
      extracted++;
      return extractDocument(...args);
    },
    gemini: () => ({
      model: "test",
      generate: async (text, _type, options) => {
        generated++;
        assert.match(text, /Atomicity|document content/i);
        if (options.pdf)
          assert.equal(Buffer.from(options.pdf.data, "base64").subarray(0, 5).toString(), "%PDF-");
        return notebook;
      },
    }),
    transcript: () => {
      throw new Error("Unexpected captions");
    },
  });
  for (const [bytes, name, sourceType] of [
    [await textPdf(), "a.pdf", "pdf"],
    [workbook(), "a.xlsx", "spreadsheet"],
    [workbook("xls"), "a.xls", "spreadsheet"],
    [csv, "a.csv", "spreadsheet"],
  ]) {
    for (let i = 0; i < 2; i++) {
      const events = [],
        result = await service(
          { sourceType, outputTypes: ["detailed_notes"] },
          { buffer: bytes, originalname: name },
          (event) => events.push(event),
        );
      assert.equal(result.status, "ready");
      assert.equal(result.materials[0].cached, false);
      assert.equal(result.materials[0].resourceId, undefined);
      assert.ok(events.some((event) => event.event === "source"));
    }
  }
  assert.equal(extracted, 8);
  assert.equal(generated, 8);
});
it("same YouTube URL always fetches again, failed outputs are independent and provider details stay private", async () => {
  let captions = 0,
    generations = 0;
  const service = createTemporaryWorkspaceService({
    extract: extractDocument,
    transcript: () => ({
      acquire: async () => {
        captions++;
        return {
          status: "available",
          transcript: {
            text: "Atomicity means all changes succeed or roll back.",
            segments: [],
            metadata: {},
          },
        };
      },
    }),
    gemini: () => ({
      model: "test",
      generate: async (_text, type) => {
        generations++;
        if (type === "short_notes")
          throw new NotesGenerationError("GEMINI_TIMEOUT", "SECRET_PROVIDER_DETAIL");
        return notebook;
      },
    }),
  });
  for (let i = 0; i < 2; i++) {
    const result = await service(
      {
        sourceType: "youtube",
        url: "https://youtu.be/AbCdEf12_-3",
        outputTypes: ["detailed_notes", "short_notes"],
      },
      undefined,
      () => {},
    );
    assert.equal(result.completionStatus, "partially_completed");
    assert.equal(result.materials.length, 1);
    assert.equal(result.failures[0].retryable, true);
    assert.doesNotMatch(JSON.stringify(result), /SECRET_PROVIDER_DETAIL|resourceId/);
  }
  assert.equal(captions, 2);
  assert.equal(generations, 4);
});
