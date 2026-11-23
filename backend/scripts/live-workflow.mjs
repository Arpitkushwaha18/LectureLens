// Opt-in real provider verification. Default only creates small synthetic fixtures.
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";
import XLSX from "@e965/xlsx";
const directory = fileURLToPath(new URL("../.cache/live-workflow/", import.meta.url));
await mkdir(directory, { recursive: true, mode: 0o700 });
const lines = [
  "Database Transactions: Study Verification",
  "A transaction groups database changes into one unit of work.",
  "Atomicity: all changes commit together, or all changes roll back.",
  "Consistency: transactions preserve database constraints.",
  "Isolation: concurrent transactions should not see partial changes.",
  "Durability: committed changes survive a restart.",
  "Example: transferring 100 rupees debits one account and credits another.",
  "If the credit fails, the debit must roll back to avoid losing money.",
  "A primary key uniquely identifies a row; foreign keys preserve references.",
  "BEGIN starts a transaction. COMMIT saves it. ROLLBACK cancels its changes.",
];
const pdf = await PDFDocument.create();
pdf.setCreationDate(new Date("2026-11-22T00:00:00Z"));
pdf.setModificationDate(new Date("2026-11-22T00:00:00Z"));
const page = pdf.addPage([595, 842]),
  font = await pdf.embedFont(StandardFonts.Helvetica);
lines.forEach((line, i) => page.drawText(line, { x: 48, y: 790 - i * 26, size: 12, font }));
await writeFile(join(directory, "transactions.pdf"), await pdf.save());
const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(
  workbook,
  XLSX.utils.aoa_to_sheet([
    ["Concept", "Explanation"],
    ...lines.slice(1).map((line) => {
      const [head, ...tail] = line.split(":");
      return [tail.length ? head : "Transactions", tail.length ? tail.join(":").trim() : head];
    }),
  ]),
  "Transactions",
);
for (const bookType of ["xlsx", "xls", "csv"])
  await writeFile(
    join(directory, `transactions.${bookType}`),
    XLSX.write(workbook, { type: "buffer", bookType }),
  );
console.log(`Synthetic fixtures: ${directory}`);
if (process.argv.includes("--live")) {
  const extension = process.env.LIVE_SOURCE ?? "pdf";
  if (!["pdf", "xlsx", "xls", "csv", "youtube"].includes(extension))
    throw new Error("Invalid fixture type");
  const outputs = (process.env.LIVE_OUTPUTS ?? "detailed_notes").split(",");
  if (process.argv.includes("--diagnostic")) {
    if (extension === "youtube") throw new Error("Use the HTTP workflow for YouTube diagnostics");
    const { env } = await import("../dist/config/env.js");
    const { workspaceCache } = await import("../dist/repositories/workspace-cache.js");
    const { createWorkspaceService } = await import("../dist/services/workspace.service.js");
    // Diagnostics must share the app's paid fence, not create a fresh billing namespace.
    const cache = workspaceCache(),
      original = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      const response = await original(url, options);
      if (String(url).includes(":generateContent")) {
        console.log({ providerStatus: response.status });
        if (!response.ok)
          console.log({
            providerDiagnostic: (await response.clone().text())
              .replaceAll(env.GEMINI_API_KEY, "[redacted]")
              .slice(0, 2000),
          });
      }
      return response;
    };
    try {
      const result = await createWorkspaceService({ cache: () => cache })(
        { sourceType: extension === "pdf" ? "pdf" : "spreadsheet", outputTypes: outputs },
        {
          buffer: await readFile(join(directory, `transactions.${extension}`)),
          originalname: `transactions.${extension}`,
        },
        () => {},
      );
      console.log({ status: result.status });
      await writeFile(
        join(directory, `diagnostic-${extension}.json`),
        JSON.stringify(result, null, 2),
        { mode: 0o600 },
      );
      if (result.status !== "ready") process.exitCode = 1;
    } catch (error) {
      console.log({ code: error.code });
      process.exitCode = 1;
    } finally {
      cache.close();
      globalThis.fetch = original;
    }
  } else {
    const body = new FormData();
    if (extension === "youtube") {
      if (!process.env.LIVE_YOUTUBE_URL)
        throw new Error(
          "Set LIVE_YOUTUBE_URL explicitly; caption acquisition may consume provider credits.",
        );
      body.append(
        "options",
        JSON.stringify({
          sourceType: "youtube",
          url: process.env.LIVE_YOUTUBE_URL,
          transcriptLanguage: process.env.LIVE_LANGUAGE ?? "en",
          outputTypes: outputs,
        }),
      );
    } else {
      body.append(
        "options",
        JSON.stringify({
          sourceType: extension === "pdf" ? "pdf" : "spreadsheet",
          outputTypes: outputs,
        }),
      );
      body.append(
        "file",
        new Blob([await readFile(join(directory, `transactions.${extension}`))]),
        `transactions.${extension}`,
      );
    }
    const api = process.env.LIVE_API_URL ?? "http://localhost:4000/api/v1";
    if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+\/api\/v1$/.test(api))
      throw new Error("Live verification requires an explicit local API");
    const response = await fetch(`${api}/workspace/process`, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(600000),
    });
    if (!response.ok) throw new Error(`Local API rejected HTTP ${response.status}`);
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    await writeFile(join(directory, `events-${extension}.json`), JSON.stringify(events, null, 2), {
      mode: 0o600,
    });
    for (const event of events) {
      if (event.event === "error") console.log({ error: event.code, message: event.message });
      if (event.event === "stage") console.log({ stage: event.stage, message: event.message });
      if (event.event === "result")
        console.log({
          status: event.result.status,
          materials: event.result.materials?.map((material) => ({
            output: material.outputType,
            cached: material.cached,
            blocks: material.notebook.blocks.length,
          })),
        });
    }
    if (events.at(-1)?.result?.status !== "ready") process.exitCode = 1;
  }
}
