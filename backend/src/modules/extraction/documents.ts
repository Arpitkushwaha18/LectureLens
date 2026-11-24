import { Worker } from "node:worker_threads";
import { extname } from "node:path";
import {
  extractedSourceSchema,
  MAX_UPLOAD_BYTES,
  MAX_SOURCE_BYTES,
  type ExtractedSource,
} from "@lecturelens/contracts";
import { AppError } from "../../lib/errors.js";

export { MAX_UPLOAD_BYTES };
export function safeDocumentName(name: string) {
  return Array.from(name)
    .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
    .join("")
    .slice(0, 240);
}
export function validateDocumentUpload(
  bytes: Buffer,
  name: string,
  kind: "pdf" | "spreadsheet",
): string {
  const extension = extname(name).slice(1).toLowerCase();
  if (!(kind === "pdf" ? ["pdf"] : ["xls", "xlsx", "csv"]).includes(extension))
    throw new AppError("File extension does not match the selected source.", {
      code: "FILE_TYPE",
      statusCode: 400,
    });
  if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES)
    throw new AppError("Upload a non-empty file no larger than 20 MB.", {
      code: "FILE_SIZE",
      statusCode: 413,
    });
  return extension;
}
export async function extractDocument(
  bytes: Buffer,
  name: string,
  kind: "pdf" | "spreadsheet",
  onProgress?: (message: string) => void,
  onMetric?: (metric: { phase: string; ms: number; rss: number }) => void,
  options?: { signal?: AbortSignal; previous?: ExtractedSource },
): Promise<ExtractedSource> {
  const extension = validateDocumentUpload(bytes, name, kind);
  return new Promise((resolve, reject) => {
    let checkpoint:
      | {
          pages: NonNullable<ExtractedSource["pages"]>;
          failedPages: NonNullable<ExtractedSource["failedPages"]>;
          totalPages: number;
        }
      | undefined;
    const started = performance.now();
    const worker = new Worker(
      new URL(
        import.meta.url.endsWith(".ts") ? "./document-worker.ts" : "./document-worker.js",
        import.meta.url,
      ),
      {
        workerData: { bytes, kind, extension, previous: options?.previous },
        resourceLimits: { maxOldGenerationSizeMb: 256 },
        execArgv: import.meta.url.endsWith(".ts") ? ["--import", "tsx"] : [],
      },
    );
    const timer = setTimeout(
      () => {
        void worker.terminate();
        if (checkpoint?.pages.some((page) => page.text.trim())) {
          const pages = [...checkpoint.pages],
            failedPages = [...checkpoint.failedPages];
          for (let page = pages.length + 1; page <= checkpoint.totalPages; page++) {
            pages.push({ page, text: "" });
            failedPages.push({
              page,
              reason:
                "Document extraction deadline reached before this page completed. Retry remaining pages or split the PDF.",
              retryable: true,
            });
          }
          const fallback = extractedSourceSchema.safeParse({
            kind: "pdf",
            name: safeDocumentName(name),
            pages,
            failedPages,
            partial: true,
            retryable: true,
            warnings: [
              "Document processing stopped at its deadline; successful pages were retained.",
            ],
            text: pages
              .map(
                (page) =>
                  `[Page ${page.page}]\n${page.text || "[Page not extracted; no missing text was invented.]"}`,
              )
              .join("\n\n"),
          });
          if (fallback.success) {
            resolve(fallback.data);
            return;
          }
        }
        reject(
          new AppError("File extraction timed out. Split or simplify the file.", {
            code: "FILE_TIMEOUT",
            statusCode: 422,
          }),
        );
      },
      Number(process.env.DOCUMENT_EXTRACT_TIMEOUT_MS || 180000),
    );
    const cancel = () => {
      clearTimeout(timer);
      void worker.terminate();
      reject(
        new AppError("Extraction cancelled. No generation request was started.", {
          code: "EXTRACTION_CANCELLED",
          statusCode: 499,
        }),
      );
    };
    options?.signal?.addEventListener("abort", cancel, { once: true });
    if (options?.signal?.aborted) cancel();
    worker.on("message", (message) => {
      if (message.checkpoint) {
        checkpoint = message.checkpoint;
        return;
      }
      if (message.metric) {
        onMetric?.(message.metric);
        return;
      }
      if (message.progress) {
        onProgress?.(message.progress);
        return;
      }
      clearTimeout(timer);
      onMetric?.({
        phase: "document-total",
        ms: performance.now() - started,
        rss: process.memoryUsage().rss,
      });
      void worker.terminate();
      if (!message.ok) {
        reject(new AppError(message.message, { code: "FILE_EXTRACTION", statusCode: 422 }));
        return;
      }
      const parsed = extractedSourceSchema.safeParse({
        ...message.result,
        name: safeDocumentName(name),
      });
      if (!parsed.success || Buffer.byteLength(message.result.text) > MAX_SOURCE_BYTES)
        reject(
          new AppError(
            "Extracted content exceeds the 100,000-character study limit or structural limits. Split the file into smaller sections.",
            { code: "CONTENT_LIMIT", statusCode: 422 },
          ),
        );
      else resolve(parsed.data);
    });
    worker.once("error", () => {
      clearTimeout(timer);
      reject(
        new AppError("File could not be processed safely. Upload a smaller, valid file.", {
          code: "FILE_EXTRACTION",
          statusCode: 422,
        }),
      );
    });
    worker.once("exit", (code) => {
      options?.signal?.removeEventListener("abort", cancel);
      if (code !== 0) {
        clearTimeout(timer);
        reject(
          new AppError("File parser stopped. Upload a smaller, valid file.", {
            code: "FILE_EXTRACTION",
            statusCode: 422,
          }),
        );
      }
    });
  });
}
