import assert from "node:assert/strict";
import { it } from "node:test";
import { extractDocument } from "../dist/modules/extraction/documents.js";
import { textPdf, scannedPdf, protectedPdf, workbook, csv } from "./helpers/documents.mjs";
import * as XLSX from "@e965/xlsx";
import { PDFDocument } from "pdf-lib";

it("real PDF parser preserves text and page boundaries", async () => {
  const result = await extractDocument(await textPdf(), "lecture.pdf", "pdf");
  assert.equal(result.pages.length, 2);
  assert.match(result.text, /\[Page 1\]/);
  assert.match(result.pages[1].text, /Durability/);
});
it("actual workbook structures enforce sheet, row and column limits", async () => {
  const book = XLSX.utils.book_new();
  for (let i = 0; i < 31; i++)
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([["Header"], ["Value"]]),
      `Sheet ${i}`,
    );
  await assert.rejects(
    extractDocument(
      XLSX.write(book, { type: "buffer", bookType: "xlsx" }),
      "sheets.xlsx",
      "spreadsheet",
    ),
    /1–30 sheets/,
  );
  for (const ref of ["A1:A5002", "A1:CW2"]) {
    const single = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([["Header"], ["Value"]]);
    sheet["!ref"] = ref;
    XLSX.utils.book_append_sheet(single, sheet, "Too large");
    await assert.rejects(
      extractDocument(
        XLSX.write(single, { type: "buffer", bookType: "xlsx" }),
        "large.xlsx",
        "spreadsheet",
      ),
      /5,000 rows or 100 columns/,
    );
  }
  await assert.rejects(
    extractDocument(Buffer.from("Header\n" + "x\n".repeat(5001)), "rows.csv", "spreadsheet"),
    /row, column or cell-size/,
  );
});
it("PDF page-count limit rejects before reading page contents", async () => {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 201; i++) pdf.addPage();
  await assert.rejects(
    extractDocument(Buffer.from(await pdf.save()), "pages.pdf", "pdf"),
    /200-page/,
  );
});
it("password-protected PDFs give a useful unlocked-copy error", async () => {
  await assert.rejects(
    extractDocument(await protectedPdf(), "locked.pdf", "pdf"),
    /password-protected/,
  );
});
it("image-based PDFs are prepared for model file input without local OCR; invalid PDFs fail honestly", async () => {
  const source = await extractDocument(await scannedPdf(), "scanned.pdf", "pdf");
  assert.equal(source.partial, false);
  assert.deepEqual(source.failedPages, []);
  assert.match(source.warnings.join(" "), /Local OCR is disabled/);
  for (const bytes of [Buffer.from("not a pdf"), Buffer.from("%PDF-1.7 corrupt")])
    await assert.rejects(extractDocument(bytes, "bad.pdf", "pdf"), /PDF/i);
});
for (const extension of ["xlsx", "xls"])
  it(`real ${extension} parser preserves multiple sheets, headers, cells and empty sheets`, async () => {
    const result = await extractDocument(
      workbook(extension),
      `lecture.${extension}`,
      "spreadsheet",
    );
    assert.equal(result.sheets.length, 3);
    assert.deepEqual(result.sheets[0].headers, ["Concept", "Meaning"]);
    assert.deepEqual(result.sheets[1].rows[1], ["2026", "120"]);
    assert.match(result.warnings.join(" "), /Empty/);
    assert.match(result.text, /Sheet: Data/);
  });
it("real CSV parser preserves quoted fields and rejects invalid CSV/binary", async () => {
  const result = await extractDocument(csv, "lecture.csv", "spreadsheet");
  assert.equal(result.sheets[0].rows[0][1], "All or nothing, never partial");
  for (const input of ['a,b\n"unterminated', "a,b\n1,2,3", "a,b\n\0,2"])
    await assert.rejects(extractDocument(Buffer.from(input), "bad.csv", "spreadsheet"));
});
it("file size, extension, invalid workbook and excessive text limits are enforced", async () => {
  for (const ext of ["xls", "xlsx"])
    await assert.rejects(
      extractDocument(Buffer.from("random data"), `bad.${ext}`, "spreadsheet"),
      /Invalid/,
    );
  await assert.rejects(extractDocument(Buffer.alloc(0), "empty.csv", "spreadsheet"), /non-empty/);
  await assert.rejects(
    extractDocument(Buffer.alloc(20 * 1024 * 1024 + 1), "huge.pdf", "pdf"),
    /20 MB/,
  );
  await assert.rejects(extractDocument(csv, "file.exe", "spreadsheet"), /extension/);
  await assert.rejects(
    extractDocument(Buffer.from("Text\n" + "x".repeat(100001)), "huge.csv", "spreadsheet"),
  );
});
