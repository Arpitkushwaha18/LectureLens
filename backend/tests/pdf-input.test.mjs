import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
process.env.NODE_ENV = "test";
const { extractDocument } = await import("../dist/modules/extraction/documents.js");
const { createWorkspaceService } = await import("../dist/services/workspace.service.js");
const { WorkspaceCache } = await import("../dist/repositories/workspace-cache.js");
const { scanPdf, imageWorkbook } = await import("./helpers/document-visual-fixtures.mjs");
const notebook = {
  schemaVersion: 2,
  title: "PDF answer",
  blocks: [{ type: "paragraph", text: "Mocked answer." }],
  limitations: [],
};

it("scanned PDF reaches generation intact without local OCR, and duplicate uploads reuse the result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lecturelens-pdf-input-"));
  const cache = new WorkspaceCache(directory);
  try {
    const bytes = await scanPdf({ mixed: true, rotated: true });
    let calls = 0;
    const service = createWorkspaceService({
      cache: () => cache,
      gemini: () => ({
        model: "freegg:fixture",
        generate: async (text, output, options) => {
          calls++;
          assert.equal(output, "detailed_notes");
          assert.deepEqual(Buffer.from(options.pdf.data, "base64"), bytes);
          assert.equal(options.pdf.name, "scan.pdf");
          assert.match(text, /Normal text page/);
          return notebook;
        },
      }),
    });
    const input = { sourceType: "pdf", outputTypes: ["detailed_notes"] };
    const file = { buffer: bytes, originalname: "scan.pdf" };
    const result = await service(input, file, () => {});
    assert.equal(result.status, "ready");
    assert.equal(result.source.partial, false);
    assert.ok(result.source.pages.every((page) => !page.ocr));
    const saved = await service(input, file, () => {});
    assert.equal(saved.materials[0].cached, true);
    assert.equal(calls, 1);
  } finally {
    cache.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("large PDFs retain a bounded preview and never require local OCR", async () => {
  const source = await extractDocument(await scanPdf({ largeText: true }), "large.pdf", "pdf");
  assert.equal(source.partial, false);
  assert.ok(source.text.length < 100000);
  assert.equal(source.pages.length, 21);
  assert.ok(source.pages.every((page) => !page.ocr));
});

it("spreadsheet cell text survives while embedded images are explicitly not processed", async () => {
  const source = await extractDocument(await imageWorkbook(), "cells.xlsx", "spreadsheet");
  assert.match(source.text, /Atomicity/);
  assert.ok(source.sheets.every((sheet) => !sheet.images?.length));
  assert.match(source.warnings.join(" "), /Embedded images are not processed/);
});
