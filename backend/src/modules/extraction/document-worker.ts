import { parentPort, workerData } from "node:worker_threads";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import * as XLSX from "@e965/xlsx";
import { parse } from "csv-parse/sync";
import yauzl from "yauzl";
import { MAX_SOURCE_CHARACTERS, type ExtractedSource } from "@lecturelens/contracts";

const inputError = (message: string) => {
  const error = new Error(message);
  error.name = "DocumentInputError";
  return error;
};
const fail = (message: string): never => {
  throw inputError(message);
};
const bytes = Buffer.from(workerData.bytes as Uint8Array);
const kind: string = workerData.kind;
const extension: string = workerData.extension;
const limits = { pages: 200, sheets: 30, rows: 5000, cols: 100, characters: MAX_SOURCE_CHARACTERS };
const progress = (message: string) => parentPort?.postMessage({ progress: message });
const metric = (phase: string, started: number) =>
  parentPort?.postMessage({
    metric: { phase, ms: performance.now() - started, rss: process.memoryUsage().rss },
  });

async function checkZip() {
  await new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(inputError("Invalid XLSX archive."));
        return;
      }
      let expanded = 0,
        entries = 0;
      zip.on("error", () => reject(inputError("Corrupt XLSX archive.")));
      zip.on("entry", (entry) => {
        expanded += entry.uncompressedSize;
        entries++;
        if (expanded > 40 * 1024 * 1024 || entries > 2000 || entry.generalPurposeBitFlag & 1) {
          zip.close();
          reject(inputError("Spreadsheet is encrypted or exceeds decompression limits."));
          return;
        }
        zip.readEntry();
      });
      zip.on("end", resolve);
      zip.readEntry();
    });
  });
}
async function extract() {
  progress("Reading document and extracting embedded text");
  const warnings: string[] = [];
  const failedImages: NonNullable<ExtractedSource["failedImages"]> = [];
  if (kind === "pdf") {
    if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-")))
      fail("This is not a valid PDF file.");
    const task = getDocument({
      data: new Uint8Array(bytes),
      useWasm: false,
      useSystemFonts: true,
      verbosity: 0,
    });
    try {
      const pdf = await task.promise;
      if (pdf.numPages > limits.pages)
        fail("PDF exceeds the 200-page limit. Upload a smaller document.");
      const pages = [];
      const failedPages: { page: number; reason: string; retryable: boolean }[] = [];
      let chars = 0;
      for (let page = 1; page <= pdf.numPages; page++) {
        const previous = workerData.previous as ExtractedSource | undefined;
        const reused = previous?.pages?.find(
          (entry) =>
            entry.page === page && !previous.failedPages?.some((failed) => failed.page === page),
        );
        if (reused) {
          pages.push(reused);
          chars += reused.text.length;
          continue;
        }
        progress(
          `Extracting embedded text and detecting scanned pages: page ${page} of ${pdf.numPages}`,
        );
        const pdfPage = await pdf.getPage(page);
        const embeddedStart = performance.now();
        const content = await pdfPage.getTextContent();
        metric("embedded-text", embeddedStart);
        let text = content.items
          .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : ""))
          .join("")
          .trim();
        // This is a bounded preview only. The complete PDF is sent to the model.
        text = text.slice(0, Math.max(0, 80000 - chars));
        chars += text.length;
        pages.push({ page, text });
        parentPort?.postMessage({ checkpoint: { pages, failedPages, totalPages: pdf.numPages } });
        pdfPage.cleanup();
      }
      warnings.push(
        "Embedded-text preview only. The complete PDF is sent to the AI provider, including scanned pages. Local OCR is disabled; model file support and readability determine the result.",
      );
      const text = pages
        .map(
          (page) =>
            `[Page ${page.page}]\n${page.text || "[No embedded text; read this page from the attached PDF.]"}`,
        )
        .join("\n\n");
      if (text.length > limits.characters)
        fail("PDF preview exceeds the content limit. Split the document.");
      return {
        kind: "pdf",
        text,
        pages,
        warnings,
        partial: failedPages.length > 0,
        retryable: failedPages.length > 0,
        failedPages,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "PasswordException")
        fail("This PDF is password-protected. Upload an unlocked copy.");
      if (error instanceof Error && error.name === "InvalidPDFException")
        fail("This PDF is corrupt or invalid. Upload a readable PDF.");
      throw error;
    } finally {
      await task.destroy();
    }
  }
  let sheets: NonNullable<ExtractedSource["sheets"]>;
  if (extension === "csv") {
    let input: string;
    try {
      input = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      fail("CSV must be UTF-8 text. Save it as CSV UTF-8 and upload again.");
    }
    if (input!.includes("\0")) fail("CSV contains binary data. Upload a UTF-8 CSV file.");
    let rows: string[][];
    try {
      rows = parse(input!, {
        bom: true,
        skip_empty_lines: true,
        relax_column_count: false,
        max_record_size: 20000,
      });
    } catch {
      fail("Invalid CSV: check quotes, delimiters and consistent column counts.");
    }
    sheets = [{ name: "CSV", headers: rows![0] ?? [], rows: rows!.slice(1) }];
  } else {
    if (extension === "xlsx") {
      if (!bytes.subarray(0, 2).equals(Buffer.from("PK")))
        fail("Invalid XLSX file. Upload a real Excel workbook.");
      await checkZip();
    } else if (
      !bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
    )
      fail("Invalid XLS file. Upload an Excel 97–2003 workbook.");
    let book: XLSX.WorkBook;
    try {
      book = XLSX.read(bytes, {
        type: "buffer",
        cellDates: false,
        cellHTML: false,
        cellFormula: false,
        dense: true,
      });
    } catch {
      fail("Spreadsheet is corrupt, encrypted or unsupported. Upload an unlocked Excel file.");
    }
    if (!book!.SheetNames.length || book!.SheetNames.length > limits.sheets)
      fail("Workbook must contain 1–30 sheets.");
    sheets = book!.SheetNames.map((name) => {
      const sheet = book!.Sheets[name]!;
      if (!sheet["!ref"]) return { name, headers: [], rows: [] };
      const range = XLSX.utils.decode_range(sheet["!ref"]);
      if (range.e.r > limits.rows || range.e.c >= limits.cols)
        fail("Spreadsheet exceeds 5,000 rows or 100 columns per sheet.");
      const values = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        defval: "",
        raw: false,
        blankrows: false,
      });
      const width = Math.max(0, ...values.map((row) => row.length));
      const rows = values.map((row) =>
        Array.from({ length: width }, (_, i) => String(row[i] ?? "")),
      );
      return { name, headers: rows[0] ?? [], rows: rows.slice(1) };
    });
    warnings.push(
      "Only spreadsheet cell text is read. Embedded images are not processed; upload a PDF to send visual content to the AI provider.",
    );
  }
  for (const sheet of sheets) {
    if (
      sheet.rows.length > limits.rows ||
      sheet.headers.length > limits.cols ||
      [...sheet.headers, ...sheet.rows.flat()].some((cell) => cell.length > 2000)
    )
      fail("Spreadsheet exceeds row, column or cell-size limits.");
    if (!sheet.headers.length && !sheet.rows.length && !sheet.images?.length)
      warnings.push(`Sheet “${sheet.name}” is empty.`);
  }
  if (
    sheets.every(
      (sheet) =>
        ![...sheet.headers, ...sheet.rows.flat()].some((cell) => cell.trim()) &&
        !sheet.images?.length,
    )
  )
    fail(
      `Spreadsheet has no readable cells or reliably readable embedded-image text.${warnings.length ? " " + warnings.join(" ") : ""}`,
    );
  const text = sheets
    .map(
      (sheet) =>
        `[Sheet: ${sheet.name}]\n[Cell text]\nHeaders: ${JSON.stringify(sheet.headers)}\n${sheet.rows.map((row, i) => `Row ${i + 2}: ${JSON.stringify(row)}`).join("\n")}`,
    )
    .join("\n\n");
  if (text.length > limits.characters)
    fail("Extracted spreadsheet text exceeds 100,000 characters. Split the workbook.");
  return {
    kind: "spreadsheet",
    partial: failedImages.length > 0,
    retryable: failedImages.length > 0,
    failedImages,
    sheets,
    warnings,
    text,
  };
}
try {
  parentPort?.postMessage({ ok: true, result: await extract() });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    message:
      error instanceof Error && error.name === "DocumentInputError"
        ? error.message
        : "File is corrupt, encrypted or unsupported. Upload a valid unlocked PDF or spreadsheet.",
  });
}
