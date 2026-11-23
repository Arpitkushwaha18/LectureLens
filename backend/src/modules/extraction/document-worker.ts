import { parentPort, workerData } from "node:worker_threads";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import * as XLSX from "@e965/xlsx";
import { parse } from "csv-parse/sync";
import yauzl from "yauzl";
import { createCanvas } from "@napi-rs/canvas";
import { OcrSession } from "./ocr.js";
import { workbookImages } from "./xlsx-images.js";
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
const maxImages = Number(process.env.OCR_MAX_IMAGES || 30);
const ocrSession = new OcrSession();
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
      let ocrPages = 0;
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
        let ocr = false;
        const textCharacters = text.replace(/\s/g, "").length;
        let needsOcr = textCharacters === 0;
        if (
          textCharacters > 0 &&
          textCharacters < Number(process.env.OCR_MIN_TEXT_CHARACTERS || 80)
        ) {
          const operations = await pdfPage.getOperatorList();
          needsOcr = operations.fnArray.some((operation) =>
            [
              OPS.paintImageXObject,
              OPS.paintInlineImageXObject,
              OPS.paintImageXObjectRepeat,
            ].includes(operation),
          );
        }
        if (needsOcr) {
          ++ocrPages;
          try {
            if (ocrPages > maxImages)
              throw new Error(`The ${maxImages}-page OCR budget was reached. Split this PDF.`);
            progress(`Running local English/Hindi OCR on PDF page ${page} of ${pdf.numPages}`);
            const initial = pdfPage.getViewport({ scale: 1 });
            const viewport = pdfPage.getViewport({
              scale: Math.min(
                Number(process.env.OCR_DPI || 150) / 72,
                1900 / Math.max(initial.width, initial.height),
              ),
            });
            if (viewport.width * viewport.height > 16000000)
              fail("PDF page exceeds OCR pixel limits. Resize the scan.");
            const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
            const renderStart = performance.now();
            const render = pdfPage.render({
              canvas,
              canvasContext: canvas.getContext("2d"),
              viewport,
            } as unknown as Parameters<typeof pdfPage.render>[0]);
            const renderTimer = setTimeout(
              () => render.cancel(),
              Number(process.env.OCR_PAGE_TIMEOUT_MS || 15000),
            );
            try {
              await render.promise;
            } finally {
              clearTimeout(renderTimer);
            }
            metric("pdf-render", renderStart);
            const recognized = await ocrSession.image(
              canvas.toBuffer("image/png"),
              -pdfPage.rotate,
            );
            text = text.trim() ? `${text}\n[OCR-derived page content]\n${recognized}` : recognized;
            ocr = true;
          } catch (error) {
            failedPages.push({
              page,
              reason: error instanceof Error ? error.message : "OCR failed.",
              retryable: true,
            });
          }
        }
        chars += text.length;
        if (chars > limits.characters)
          fail("Extracted PDF text exceeds 100,000 characters. Split the document.");
        pages.push({ page, text, ...(ocr ? { ocr: true } : {}) });
        parentPort?.postMessage({ checkpoint: { pages, failedPages, totalPages: pdf.numPages } });
        pdfPage.cleanup();
      }
      if (ocrPages)
        warnings.push(
          `Local OCR used for ${ocrPages} page(s). Verify OCR-derived text, especially formulas and low-quality scans.`,
        );
      const text = pages
        .map(
          (page) =>
            `[Page ${page.page}${page.ocr ? " · OCR-derived text" : ""}]\n${page.text}${failedPages.some((failed) => failed.page === page.page) ? "\n[This page could not be fully extracted; no missing text was invented.]" : ""}`,
        )
        .join("\n\n");
      if (text.length > limits.characters)
        fail("Extracted PDF text/OCR exceeds 100,000 characters. Split the document.");
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
    if (extension === "xlsx") {
      const imageStart = performance.now();
      const { images, warnings: imageWarnings } = await workbookImages(bytes);
      metric("xlsx-images", imageStart);
      warnings.push(...imageWarnings);
      for (const [i, image] of images.entries()) {
        progress(
          `Running local OCR on worksheet ${image.sheet}, image ${i + 1} of ${images.length}`,
        );
        const sheet = sheets.find((sheet) => sheet.name === image.sheet);
        if (!sheet) continue;
        try {
          const previous = workerData.previous as ExtractedSource | undefined;
          const reused = previous?.sheets
            ?.find((entry) => entry.name === image.sheet)
            ?.images?.find(
              (entry) => entry.name === image.name && entry.location === image.location,
            );
          if (!reused && i >= maxImages)
            throw new Error(`The ${maxImages}-image OCR budget was reached. Split the workbook.`);
          const text = reused?.text ?? (await ocrSession.image(image.bytes));
          sheet.images ??= [];
          sheet.images.push({
            name: image.name,
            text,
            ...(image.location ? { location: image.location } : {}),
          });
        } catch (error) {
          failedImages.push({
            sheet: image.sheet,
            name: image.name,
            ...(image.location ? { location: image.location } : {}),
            reason: error instanceof Error ? error.message : "OCR failed.",
            retryable: true,
          });
          warnings.push(
            `Worksheet “${image.sheet}”, ${image.name}: ${error instanceof Error ? error.message : "OCR failed"}`,
          );
        }
      }
      if (images.length)
        warnings.push(
          "Embedded-image OCR is separate from cell text. Verify OCR-derived text before studying.",
        );
    } else
      warnings.push(
        "Legacy XLS embedded-image extraction is not supported. Cell data is preserved; export to XLSX for image OCR.",
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
        `[Sheet: ${sheet.name}]\n[Cell text]\nHeaders: ${JSON.stringify(sheet.headers)}\n${sheet.rows.map((row, i) => `Row ${i + 2}: ${JSON.stringify(row)}`).join("\n")}\n${(sheet.images || []).map((image) => `[OCR-derived image: ${image.name}${image.location ? `; ${image.location}` : ""}]\n${image.text}`).join("\n\n")}`,
    )
    .join("\n\n");
  if (text.length > limits.characters)
    fail("Extracted spreadsheet/OCR text exceeds 100,000 characters. Split the workbook.");
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
} finally {
  await ocrSession.close();
}
