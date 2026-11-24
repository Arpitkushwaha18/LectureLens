// Explicit opt-in. One generation per selected source; no saved URLs/captions/notes.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { createRequire } from "node:module";
import { textPdf } from "../../backend/tests/helpers/documents.mjs";
import { scanPdf } from "../../backend/tests/helpers/document-visual-fixtures.mjs";
import { notebookSchema } from "@lecturelens/contracts";
import { geminiResponseSchema } from "../../backend/dist/modules/ai/gemini-schema.js";
import { restoreOptionalFields } from "../../backend/dist/modules/ai/structured-schema.js";
const { PDFDocument } = createRequire(new URL("../../backend/package.json", import.meta.url))(
  "pdf-lib",
);

if (!process.argv.includes("--live"))
  throw new Error("Pass --live; real providers may consume quota.");
const hosted = process.argv.includes("--hosted");
const base = hosted ? "https://lecture-lens-rho-three.vercel.app" : "http://localhost:5173";
let server;
const providerOutcomes = [];
const nativeFetch = globalThis.fetch;
if (!hosted) {
  process.env.LOG_LEVEL = "silent";
  globalThis.fetch = async (input, init) => {
    const host = new URL(input instanceof Request ? input.url : String(input)).hostname;
    const provider =
      host === "openrouter.ai" ? "openrouter" : host === "freegg.app" ? "freegg" : undefined;
    try {
      const response = await nativeFetch(input, init);
      if (provider) {
        const outcome = { provider, status: response.status };
        if (response.ok) {
          try {
            const body = await response.clone().json();
            const text =
              provider === "openrouter"
                ? body.choices?.[0]?.message?.content
                : body.output
                    ?.filter((item) => item.type === "message" && item.role === "assistant")
                    .flatMap((item) => item.content ?? [])
                    .filter((part) => part.type === "output_text")
                    .map((part) => part.text)
                    .join("");
            const notebook = JSON.parse(text);
            if (Array.isArray(notebook.blocks)) outcome.blocks = notebook.blocks.length;
            if (Array.isArray(notebook.limitations))
              outcome.limitations = notebook.limitations.length;
            const restored =
              provider === "openrouter"
                ? restoreOptionalFields(notebook, geminiResponseSchema(notebookSchema))
                : notebook;
            const validated = notebookSchema.safeParse(restored);
            if (!validated.success)
              outcome.validationCodes = validated.error.issues.map((issue) => issue.code);
          } catch {
            /* Counts only; never log provider content. */
          }
        }
        providerOutcomes.push(outcome);
      }
      return response;
    } catch (error) {
      if (provider) providerOutcomes.push({ provider, status: 0 });
      throw error;
    }
  };
  const { createApp } = await import("../../backend/dist/app.js");
  server = createApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
}
const cases = [];
if (process.env.LIVE_YOUTUBE_URL)
  cases.push({ kind: "youtube", url: process.env.LIVE_YOUTUBE_URL });
if (process.argv.includes("--pdf")) cases.push({ kind: "pdf", bytes: await textPdf() });
if (process.argv.includes("--scan")) cases.push({ kind: "scan", bytes: await scanPdf() });
if (!cases.length) throw new Error("Set LIVE_YOUTUBE_URL and/or pass --pdf / --scan.");
const browser = await chromium.launch({ headless: true });
const summaries = [];
try {
  for (const source of cases) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    if (server)
      await page.route("**/api/v1/**", (route) => {
        const url = new URL(route.request().url());
        return route.continue({
          url: `http://127.0.0.1:${server.address().port}${url.pathname}${url.search}`,
        });
      });
    let pageErrors = 0,
      generationRequests = 0;
    page.on("pageerror", () => pageErrors++);
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.endsWith("/workspace/process")) generationRequests++;
    });
    const summary = { source: source.kind, hosted };
    const firstOutcome = providerOutcomes.length;
    try {
      await page.goto(`${base}/assistant?source=${source.kind === "youtube" ? "youtube" : "pdf"}`);
      if (source.kind === "youtube") {
        await page.getByRole("textbox", { name: "YouTube URL", exact: true }).fill(source.url);
        await page.getByText(/YouTube URL is valid/).waitFor({ timeout: 90000 });
      } else {
        await page.getByLabel("Select PDF file").setInputFiles({
          name: "synthetic-lecture.pdf",
          mimeType: "application/pdf",
          buffer: source.bytes,
        });
      }
      for (const checkbox of await page.getByRole("checkbox").all()) await checkbox.uncheck();
      await page.getByRole("checkbox", { name: "Detailed notes", exact: true }).check();
      const pending = page.waitForResponse(
        (response) => new URL(response.url()).pathname.endsWith("/workspace/process"),
        { timeout: 600000 },
      );
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      const response = await pending;
      summary.httpStatus = response.status();
      const events = (await response.text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      summary.progressEvents = events.filter((event) => event.event === "progress").length;
      const partCounts = events
        .filter((event) => event.event === "progress")
        .map((event) => Number(/source part \d+ of (\d+)/.exec(event.message)?.[1] ?? 0));
      summary.sourceParts = Math.max(0, ...partCounts);
      const failure = events.find((event) => event.event === "error");
      if (failure) {
        summary.code = failure.code;
        throw new Error("GENERATION_REJECTED");
      }
      const result = events.findLast((event) => event.event === "result")?.result;
      assert.equal(result?.status, "ready");
      assert.equal(result.materials.length, 1);
      assert.equal(result.materials[0].cached, false);
      summary.blocks = result.materials[0].notebook.blocks.length;
      await page
        .getByRole("button", { name: "Export PDF", exact: true })
        .waitFor({ timeout: 30000 });
      const notebook = page.locator('[aria-label="Generated study material"] .study-notebook');
      assert.equal(await notebook.count(), 1);
      if (source.kind !== "youtube")
        assert.match(await notebook.textContent(), /atomicity|transaction|database/i);
      const exportResponse = page.waitForResponse(
        (r) => new URL(r.url()).pathname.endsWith("/workspace/export"),
        { timeout: 90000 },
      );
      await page.getByRole("button", { name: "Export PDF", exact: true }).click();
      const exported = await exportResponse;
      summary.exportStatus = exported.status();
      assert.equal(exported.status(), 200);
      const bytes = await exported.body();
      assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
      summary.pdfPages = (await PDFDocument.load(bytes)).getPageCount();
      const { extractDocument } =
        await import("../../backend/dist/modules/extraction/documents.js");
      const parsedPdf = await extractDocument(bytes, "export.pdf", "pdf");
      const normalize = (text) => text.replace(/\s+/g, " ").trim().toLowerCase();
      summary.readablePdf = normalize(parsedPdf.text).includes(
        normalize(result.materials[0].notebook.title),
      );
      assert.ok(
        summary.readablePdf,
        "The exported PDF must contain the generated notebook title as readable text",
      );
      summary.handwrittenFonts =
        /Kalam/.test(bytes.toString("latin1")) && /Caveat/.test(bytes.toString("latin1"));
      assert.ok(summary.handwrittenFonts);
      assert.equal(pageErrors, 0);
      assert.equal(generationRequests, 1, "Live verification must not silently regenerate/retry");
      summary.passed = true;
    } catch {
      summary.passed = false;
      summary.code ??= "WORKFLOW_ASSERTION_OR_TIMEOUT";
      process.exitCode = 1;
    } finally {
      summary.generationRequests = generationRequests;
      summary.pageErrors = pageErrors;
      if (!hosted) summary.providerOutcomes = providerOutcomes.slice(firstOutcome);
      summaries.push(summary);
      console.log(JSON.stringify(summary));
      await page.close();
    }
  }
} finally {
  await browser.close();
  globalThis.fetch = nativeFetch;
  if (server) await new Promise((resolve) => server.close(resolve));
}
