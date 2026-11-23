import { it } from "node:test";
import assert from "node:assert/strict";
import { extractDocument } from "../dist/modules/extraction/documents.js";
import { OcrSession } from "../dist/modules/extraction/ocr.js";
import { textImage, scanPdf } from "./helpers/ocr-fixtures.mjs";
import { PDFDocument, StandardFonts } from "pdf-lib";
it("page deadline kills the native engine and leaves no active process", async () => {
  const old = process.env.OCR_PAGE_TIMEOUT_MS;
  process.env.OCR_PAGE_TIMEOUT_MS = "1";
  const session = new OcrSession();
  try {
    await assert.rejects(session.image(textImage()), /cancelled|deadline|timed out|stopped/);
    await session.close();
    assert.equal(session.diagnostics.liveProcesses, 0);
  } finally {
    await session.close();
    if (old === undefined) delete process.env.OCR_PAGE_TIMEOUT_MS;
    else process.env.OCR_PAGE_TIMEOUT_MS = old;
  }
});
it("document deadline returns successfully completed pages and marks remaining pages retryable", async () => {
  const old = process.env.DOCUMENT_EXTRACT_TIMEOUT_MS,
    oldPage = process.env.OCR_PAGE_TIMEOUT_MS;
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    first = pdf.addPage([595, 842]);
  first.drawText("Embedded transactions text is always preserved before OCR starts.", {
    x: 30,
    y: 700,
    font,
    size: 12,
  });
  const scan = await PDFDocument.load(await scanPdf());
  for (let i = 0; i < 50; i++) {
    const page = pdf.addPage((await pdf.copyPages(scan, [0]))[0]);
    page.drawText(`Scan ${i + 1}`, { x: 30, y: 600, font, size: 14 });
  }
  process.env.DOCUMENT_EXTRACT_TIMEOUT_MS = "1500";
  process.env.OCR_PAGE_TIMEOUT_MS = "15000";
  try {
    const source = await extractDocument(Buffer.from(await pdf.save()), "deadline.pdf", "pdf");
    assert.equal(source.partial, true);
    assert.equal(source.pages.length, 51);
    assert.match(source.pages[0].text, /always preserved/);
    assert.ok(source.failedPages.some((page) => page.reason.includes("deadline")));
    assert.ok(source.failedPages.every((page) => page.retryable));
  } finally {
    if (old === undefined) delete process.env.DOCUMENT_EXTRACT_TIMEOUT_MS;
    else process.env.DOCUMENT_EXTRACT_TIMEOUT_MS = old;
    if (oldPage === undefined) delete process.env.OCR_PAGE_TIMEOUT_MS;
    else process.env.OCR_PAGE_TIMEOUT_MS = oldPage;
  }
});
