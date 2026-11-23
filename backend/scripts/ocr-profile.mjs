import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { createCanvas } from "@napi-rs/canvas";
import { textImage, imageWorkbook } from "../tests/helpers/ocr-fixtures.mjs";
import { extractDocument } from "../dist/modules/extraction/documents.js";
import { writeFile } from "node:fs/promises";
const results = [];
for (const [name, kind, buffer] of [
  ["mixed-12-pages", "pdf", await document(false)],
  ["scanned-8-pages", "pdf", await document(true)],
  ["xlsx-2-identical-images", "spreadsheet", await imageWorkbook({ multiple: true })],
]) {
  const metrics = [],
    stages = [],
    started = performance.now();
  try {
    const source = await extractDocument(
      buffer,
      `${name}.${kind === "pdf" ? "pdf" : "xlsx"}`,
      kind,
      (message) => stages.push(message),
      (m) => metrics.push(m),
    );
    results.push({
      name,
      totalMs: performance.now() - started,
      characters: source.text.length,
      ocrPages: source.pages?.filter((p) => p.ocr).length,
      partial: source.partial ?? false,
      failedPages: source.failedPages ?? [],
      metrics,
      stages,
    });
  } catch (error) {
    results.push({
      name,
      totalMs: performance.now() - started,
      error: error.message,
      metrics,
      stages,
    });
  }
}
const output = {
  label: process.argv[2] || "profile",
  date: new Date().toISOString(),
  node: process.version,
  results,
};
await writeFile(
  new URL(`../.cache/verification/ocr-${output.label}.json`, import.meta.url),
  JSON.stringify(output, null, 2),
);
console.log(JSON.stringify(output, null, 2));
async function document(allScanned) {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < (allScanned ? 8 : 12); i++) {
    const page = pdf.addPage([595, 842]);
    if (!allScanned && i % 2 === 0) {
      page.drawText(
        `Embedded page ${i + 1}: Atomicity protects committed transactions and preserves consistency.`,
        { x: 30, y: 760, font, size: 12 },
      );
      continue;
    }
    const c = createCanvas(1600, 480),
      ctx = c.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 1600, 480);
    const { loadImage } = await import("@napi-rs/canvas");
    ctx.drawImage(await loadImage(textImage(i % 3 === 0)), 0, 0);
    ctx.fillStyle = "black";
    ctx.font = "42px Arial";
    ctx.fillText(`Study sheet ${i + 1}`, 50, 445);
    const image = await pdf.embedPng(c.toBuffer("image/png"));
    page.drawImage(image, { x: 20, y: 500, width: 550, height: 165 });
    if (i === 3) page.setRotation(degrees(90));
  }
  return Buffer.from(await pdf.save());
}
