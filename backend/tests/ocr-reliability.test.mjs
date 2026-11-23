import { it } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import sharp from "sharp";
import { extractDocument } from "../dist/modules/extraction/documents.js";
import { OcrSession } from "../dist/modules/extraction/ocr.js";
import { textImage, imageWorkbook } from "./helpers/ocr-fixtures.mjs";
async function qualityPdf() {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const type of ["text", "english", "blank", "hindi", "mixed", "low", "rotated", "table"]) {
    const page = pdf.addPage([595, 842]);
    if (type === "text") {
      page.drawText("Readable embedded text: Isolation separates concurrent transactions.", {
        x: 30,
        y: 760,
        font,
        size: 12,
      });
      continue;
    }
    if (type === "blank") continue;
    let image = textImage(type === "hindi");
    if (type === "mixed") {
      const canvas = createCanvas(1600, 700),
        c = canvas.getContext("2d");
      c.fillStyle = "white";
      c.fillRect(0, 0, 1600, 700);
      c.drawImage(await loadImage(textImage(true)), 0, 0);
      c.drawImage(await loadImage(textImage()), 0, 320);
      image = canvas.toBuffer("image/png");
    }
    if (type === "low") image = await sharp(image).resize({ width: 650 }).png().toBuffer();
    if (type === "table") {
      const canvas = createCanvas(1500, 500),
        c = canvas.getContext("2d");
      c.fillStyle = "white";
      c.fillRect(0, 0, 1500, 500);
      c.fillStyle = "black";
      c.font = "40px Arial";
      for (const [i, row] of [
        ["Concept", "Meaning"],
        ["Atomicity", "All changes or none"],
        ["Consistency", "Valid constraints"],
      ].entries()) {
        c.fillText(row[0], 40, 90 + i * 100);
        c.fillText(row[1], 600, 90 + i * 100);
      }
      image = canvas.toBuffer("image/png");
    }
    const embedded = await pdf.embedPng(image);
    page.drawImage(embedded, { x: 20, y: 450, width: 550, height: type === "mixed" ? 240 : 150 });
    if (type === "rotated") page.setRotation(degrees(90));
  }
  return Buffer.from(await pdf.save());
}
it(
  "real mixed multi-page OCR preserves English, Hindi, rotation, low-resolution and table content while a blank page fails",
  { timeout: 180000 },
  async () => {
    const metrics = [],
      source = await extractDocument(await qualityPdf(), "quality.pdf", "pdf", undefined, (m) =>
        metrics.push(m),
      );
    assert.equal(source.pages.length, 8);
    assert.equal(source.partial, true);
    assert.deepEqual(
      source.failedPages.map((page) => page.page),
      [3],
    );
    assert.match(source.pages[0].text, /Isolation/);
    assert.equal(source.pages[0].ocr, undefined);
    for (const index of [1, 5, 6, 7]) assert.match(source.pages[index].text, /Atomicity/i);
    assert.match(source.pages[3].text, /भारत|शिक्षा/);
    assert.match(source.pages[4].text, /Atomicity/);
    assert.match(source.pages[4].text, /भारत|शिक्षा/);
    assert.equal(metrics.filter((m) => m.phase === "pdf-render").length, 7);
    assert.equal(metrics.filter((m) => m.phase === "engine-init").length, 1);
    assert.ok(!source.pages[2].ocr);
  },
);
it(
  "retry processes only failed pages, preserving previous successful pages exactly",
  { timeout: 180000 },
  async () => {
    const bytes = await qualityPdf(),
      first = await extractDocument(bytes, "partial.pdf", "pdf"),
      metrics = [];
    const retried = await extractDocument(
      bytes,
      "partial.pdf",
      "pdf",
      undefined,
      (m) => metrics.push(m),
      { previous: first },
    );
    assert.equal(metrics.filter((m) => m.phase === "pdf-render").length, 1);
    for (let i = 0; i < first.pages.length; i++)
      if (i !== 2) assert.deepEqual(retried.pages[i], first.pages[i]);
    assert.deepEqual(
      retried.failedPages.map((page) => page.page),
      [3],
    );
  },
);
it(
  "reused native OCR engines deduplicate images and release all subprocesses",
  { timeout: 180000 },
  async () => {
    for (let run = 0; run < 3; run++) {
      const session = new OcrSession();
      try {
        assert.match(await session.image(textImage()), /Atomicity/);
        assert.match(await session.image(textImage(true)), /भारत|शिक्षा/);
        assert.match(await session.image(textImage()), /Atomicity/);
        assert.equal(session.diagnostics.workerStarts, 1);
        assert.equal(session.diagnostics.cacheHits, 1);
        assert.equal(session.diagnostics.liveProcesses, 1);
      } finally {
        await session.close();
        assert.equal(session.diagnostics.liveProcesses, 0);
      }
    }
  },
);
it("identical XLSX pictures are recognized once and still associated with both sheets", async () => {
  const metrics = [],
    source = await extractDocument(
      await imageWorkbook({ multiple: true }),
      "duplicate.xlsx",
      "spreadsheet",
      undefined,
      (m) => metrics.push(m),
    );
  assert.equal(metrics.filter((m) => m.phase === "ocr-engine").length, 1);
  assert.equal(source.sheets[0].images[0].text, source.sheets[1].images[0].text);
  assert.equal(source.sheets[0].headers[0], "Concept");
});
it("local extraction cancellation terminates work before any generation", async () => {
  const controller = new AbortController();
  await assert.rejects(
    extractDocument(
      await qualityPdf(),
      "cancel.pdf",
      "pdf",
      (message) => {
        if (message.includes("OCR")) controller.abort();
      },
      undefined,
      { signal: controller.signal },
    ),
    (error) => error.code === "EXTRACTION_CANCELLED",
  );
});
