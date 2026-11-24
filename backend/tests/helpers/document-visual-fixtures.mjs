import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import JSZip from "jszip";
import { workbook } from "./documents.mjs";
export function textImage(hindi = false) {
  const canvas = createCanvas(1600, 380),
    context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, 1600, 380);
  context.fillStyle = "black";
  context.font = hindi ? '48px "Devanagari Sangam MN", sans-serif' : "48px Arial";
  const lines = hindi
    ? ["भारत में शिक्षा और विज्ञान महत्वपूर्ण हैं।", "विद्यार्थी ध्यान से पढ़ते हैं और ज्ञान सीखते हैं।"]
    : [
        "Database transactions protect committed data.",
        "Atomicity means all changes succeed or roll back.",
        "Consistency preserves valid constraints.",
      ];
  lines.forEach((line, i) => context.fillText(line, 50, 85 + i * 90));
  return canvas.toBuffer("image/png");
}
export async function scanPdf({
  mixed = false,
  hindi = false,
  rotated = false,
  largeText = false,
} = {}) {
  const pdf = await PDFDocument.create();
  if (mixed) {
    const page = pdf.addPage([595, 842]),
      font = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText("Normal text page: Isolation separates concurrent database transactions.", {
      x: 30,
      y: 760,
      size: 12,
      font,
    });
  }
  if (largeText) {
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let index = 0; index < 20; index++) {
      const page = pdf.addPage([595, 842]);
      for (let line = 0; line < (index === 19 ? 49 : 50); line++)
        page.drawText("Atomicity ".repeat(10), { x: 30, y: 780 - line * 14, size: 8, font });
    }
  }
  const page = pdf.addPage([595, 842]),
    image = await pdf.embedPng(textImage(hindi));
  page.drawImage(image, { x: 20, y: 500, width: 550, height: 140 });
  if (rotated) page.setRotation(degrees(90));
  return Buffer.from(await pdf.save());
}
export async function imageWorkbook({ hindi = false, multiple = false, unsupported = false } = {}) {
  const zip = await JSZip.loadAsync(workbook());
  for (const index of multiple ? [1, 2] : [1]) {
    const path = `xl/worksheets/sheet${index}.xml`,
      xml = await zip.file(path).async("string");
    zip.file(
      path,
      xml.replace(
        "</worksheet>",
        '<drawing xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="imageDrawing"/></worksheet>',
      ),
    );
    zip.file(
      `xl/worksheets/_rels/sheet${index}.xml.rels`,
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="imageDrawing" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${index}.xml"/></Relationships>`,
    );
    zip.file(
      `xl/drawings/drawing${index}.xml`,
      `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><xdr:twoCellAnchor><xdr:from><xdr:col>2</xdr:col><xdr:row>4</xdr:row></xdr:from><xdr:pic><xdr:blipFill><a:blip r:embed="image1"/></xdr:blipFill></xdr:pic></xdr:twoCellAnchor></xdr:wsDr>`,
    );
    zip.file(
      `xl/drawings/_rels/drawing${index}.xml.rels`,
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="image1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${index}.png"/></Relationships>`,
    );
    zip.file(
      `xl/media/image${index}.png`,
      unsupported ? Buffer.from("unsupported image bytes") : textImage(hindi),
    );
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
