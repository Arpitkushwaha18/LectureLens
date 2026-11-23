import assert from "node:assert/strict";
import { it } from "node:test";
import { extractDocument } from "../dist/modules/extraction/documents.js";
import { scanPdf, imageWorkbook } from "./helpers/ocr-fixtures.mjs";
import { scannedPdf } from "./helpers/documents.mjs";
for (const options of [{}, { mixed: true }, { rotated: true }])
  it(`real local Tesseract PDF OCR ${JSON.stringify(options)}`, { timeout: 180000 }, async () => {
    const stages = [],
      source = await extractDocument(await scanPdf(options), "scan.pdf", "pdf", (message) =>
        stages.push(message),
      );
    assert.match(source.text, /Atomicity/i);
    assert.ok(source.pages.at(-1).ocr);
    assert.ok(stages.some((stage) => stage.includes("OCR")));
    if (options.mixed) {
      assert.match(source.pages[0].text, /Isolation/);
      assert.equal(source.pages[0].ocr, undefined);
      assert.equal(source.pages.length, 2);
    }
  });
it("real Hindi OCR from scanned PDF", { timeout: 180000 }, async () => {
  const source = await extractDocument(await scanPdf({ hindi: true }), "hindi.pdf", "pdf");
  assert.match(source.text, /भारत|शिक्षा|ज्ञान/);
});
it(
  "unreadable/blank scans return structured failed pages, not OCR success",
  { timeout: 180000 },
  async () => {
    const source = await extractDocument(await scannedPdf(), "blank.pdf", "pdf");
    assert.equal(source.partial, true);
    assert.equal(source.failedPages.length, 1);
    assert.match(source.failedPages[0].reason, /OCR|readable/);
    assert.equal(source.pages[0].ocr, undefined);
  },
);
it(
  "real XLSX embedded-image OCR preserves cell data, sheet association and anchor location",
  { timeout: 180000 },
  async () => {
    const source = await extractDocument(
      await imageWorkbook({ multiple: true }),
      "images.xlsx",
      "spreadsheet",
    );
    assert.equal(source.sheets[0].headers[0], "Concept");
    for (const sheet of source.sheets.slice(0, 2)) {
      assert.match(sheet.images[0].text, /Atomicity/);
      assert.equal(sheet.images[0].location, "Row 5, column 3");
    }
    assert.match(source.text, /OCR-derived image/);
    assert.match(source.text, /Cell text/);
  },
);
it("real Hindi embedded-image OCR", { timeout: 180000 }, async () => {
  const source = await extractDocument(
    await imageWorkbook({ hindi: true }),
    "hindi.xlsx",
    "spreadsheet",
  );
  assert.match(source.sheets[0].images[0].text, /भारत|शिक्षा|ज्ञान/);
});
it(
  "unsupported embedded image warns without destroying ordinary cells",
  { timeout: 180000 },
  async () => {
    const source = await extractDocument(
      await imageWorkbook({ unsupported: true }),
      "bad-image.xlsx",
      "spreadsheet",
    );
    assert.match(source.warnings.join(" "), /unsupported/);
    assert.equal(source.sheets[0].rows[0][0], "Atomicity");
  },
);
it(
  "combined PDF text/OCR exceeds 100,000 characters with a clear error, never truncation",
  { timeout: 180000 },
  async () => {
    await assert.rejects(
      extractDocument(await scanPdf({ largeText: true }), "large-text.pdf", "pdf"),
      /100,000/,
    );
  },
);
