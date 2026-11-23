import { PDFDocument, StandardFonts } from "pdf-lib";
import * as XLSX from "@e965/xlsx";
import PDFKit from "pdfkit";

export async function protectedPdf() {
  return new Promise((resolve) => {
    const pdf = new PDFKit({ userPassword: "test-password", ownerPassword: "test-owner" });
    const chunks = [];
    pdf.on("data", (chunk) => chunks.push(chunk));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.text("Protected test document");
    pdf.end();
  });
}

export async function textPdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const text of [
    "Database Transactions: Atomicity means all changes succeed or roll back.",
    "Consistency preserves constraints. Isolation separates concurrent transactions. Durability keeps committed changes.",
  ]) {
    const page = pdf.addPage([595, 842]);
    page.drawText(text, { x: 40, y: 760, size: 11, font, maxWidth: 500 });
  }
  return Buffer.from(await pdf.save());
}
export async function scannedPdf() {
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]);
  return Buffer.from(await pdf.save());
}
export function workbook(bookType = "xlsx") {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ["Concept", "Meaning"],
      ["Atomicity", "All or nothing"],
      ["Consistency", "Valid constraints"],
    ]),
    "Transactions",
  );
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ["Year", "Revenue"],
      [2025, 100],
      [2026, 120],
    ]),
    "Data",
  );
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([]), "Empty");
  return XLSX.write(book, { type: "buffer", bookType });
}
export const csv = Buffer.from(
  'Concept,Meaning\r\nAtomicity,"All or nothing, never partial"\r\nConsistency,"Valid constraints"\r\n',
);
