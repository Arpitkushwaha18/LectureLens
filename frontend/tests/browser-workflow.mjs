import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { notebookFixture } from "./helpers/notebook-fixture.mjs";
import { textPdf, workbook, csv } from "../../backend/tests/helpers/documents.mjs";
import { scanPdf, imageWorkbook } from "../../backend/tests/helpers/ocr-fixtures.mjs";
import { createDatabase, embeddedRepository } from "../../backend/tests/helpers/database.mjs";
import { createRequire } from "node:module";
const backendRequire = createRequire(new URL("../../backend/package.json", import.meta.url));
const { Router } = backendRequire("express");
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
for (const key of [
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "TRANSCRIPTFETCH_API_KEY",
])
  process.env[key] = "";
const { createApp } = await import("../../backend/dist/app.js");
const { createWorkspaceRouter } = await import("../../backend/dist/routes/workspace.routes.js");
const { createWorkspaceService } = await import("../../backend/dist/services/workspace.service.js");
const { WorkspaceCache } = await import("../../backend/dist/repositories/workspace-cache.js");
const { createVideoVerifier } = await import("../../backend/dist/services/video-verification.js");
const { extractDocument } = await import("../../backend/dist/modules/extraction/documents.js");
const { StudyLibrary } = await import("../../backend/dist/repositories/study-library.js");
const { createLibraryRouter } = await import("../../backend/dist/routes/library.routes.js");
const directory = await mkdtemp(join(tmpdir(), "lecturelens-browser-"));
const cache = new WorkspaceCache(directory),
  db = await createDatabase(7),
  repo = embeddedRepository(db);
for (const name of [
  "20261122000900_automatic_captions.sql",
  "20261122001100_final_youtube_workflow.sql",
  "20261122001200_caption_retry_safety.sql",
])
  await db.exec(
    await readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), "utf8"),
  );
repo.findBestTranscript = async (sourceId) =>
  (
    await db.query(
      "select id,text_content,content_hash,provenance,metadata from public.transcripts where source_id=$1 order by version desc limit 1",
      [sourceId],
    )
  ).rows[0] ?? null;
const scalar = async (sql, params = []) => (await db.query(sql, params)).rows[0]?.value;
const notesStore = {
  claim: (v, t, o, m, p, c) =>
    scalar("select public.claim_youtube_notebook($1,$2,$3,$4,$5,2,$6) as value", [
      v,
      t,
      o,
      m,
      p,
      c,
    ]),
  evidence: async (i, t, e, n) =>
    assert.equal(
      await scalar("select public.youtube_notebook_evidence($1,$2,$3::jsonb,$4::jsonb) as value", [
        i,
        t,
        JSON.stringify(e),
        n ? JSON.stringify(n) : null,
      ]),
      true,
    ),
  finish: async (i, t, n) =>
    assert.equal(
      await scalar("select public.finish_youtube_notebook($1,$2,$3::jsonb) as value", [
        i,
        t,
        JSON.stringify(n),
      ]),
      true,
    ),
  fail: async (i, t, c, s) =>
    assert.equal(
      await scalar("select public.fail_youtube_notebook($1,$2,$3,$4) as value", [i, t, c, s]),
      true,
    ),
};
const provider = {
  acquire: async () => ({
    schemaVersion: 1,
    status: "unavailable",
    reason: "captions_unavailable",
    message: "No captions for fixture.",
  }),
};
const verifier = createVideoVerifier();
const id = await repo.ensureSource("AbCdEf12_-3");
await db.query(
  "insert into public.transcripts(source_id,text_content,language,content_hash,provenance,provider_id,provider_version,metadata) values ($1,$2,'en',encode(sha256(convert_to($2,'UTF8')),'hex'),'licensed_provider','transcriptfetch','test-sdk',$3::jsonb)",
  [
    id,
    "Atomicity means all changes succeed or roll back.",
    JSON.stringify({
      segments: [
        { start: 0, duration: 3.439, text: "Atomicity means all changes succeed or roll back." },
      ],
      returnedLanguage: "en",
    }),
  ],
);
let generations = 0,
  holdGeneration,
  failShortOnce = false;
const { NotesGenerationError } = await import("../../backend/dist/modules/ai/gemini-notes.js");
const generate = async (_text, type, counts = {}) => {
  generations++;
  if (failShortOnce && type === "short_notes") {
    failShortOnce = false;
    throw new NotesGenerationError("GEMINI_INVALID_OUTPUT", "Private provider response detail");
  }
  if (holdGeneration) await holdGeneration;
  if (type === "flashcards" || type === "mcq_quiz") {
    const blockType = type === "flashcards" ? "flashcard" : "quiz",
      count = type === "flashcards" ? (counts.flashcardCount ?? 10) : (counts.quizCount ?? 10),
      block = notebookFixture.blocks.find((b) => b.type === blockType);
    return {
      ...notebookFixture,
      blocks: notebookFixture.blocks.flatMap((b) =>
        b.type === blockType
          ? Array.from({ length: count }, (_, i) => ({
              ...block,
              question: `${block.question} (${i + 1})`,
              ...(blockType === "quiz"
                ? { options: ["Atomicity", "Isolation", "Durability", "Consistency"] }
                : {}),
            }))
          : b,
      ),
    };
  }
  return notebookFixture;
};
const service = createWorkspaceService({
  cache: () => cache,
  resources: repo,
  gemini: () => ({ model: "test-model", generate }),
  provider,
  notesStore,
  verify: verifier.assert,
});
const router = Router();
const library = new StudyLibrary("local_postgres", join(directory, "library"));
router.use(
  "/library",
  createLibraryRouter(() => library),
);
router.use(
  "/workspace",
  createWorkspaceRouter(
    service,
    () => cache.gallery(),
    200,
    () => library,
    verifier,
    async () => ({ notebook: notebookFixture, cached: false }),
  ),
);
const server = createApp(router).listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const api = `http://localhost:${server.address().port}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/api/v1/workspace/**", (route) =>
  route.continue({ url: api + new URL(route.request().url()).pathname }),
);
await page.route("**/api/v1/library/**", (route) =>
  route.continue({
    url: api + new URL(route.request().url()).pathname + new URL(route.request().url()).search,
  }),
);
const base = process.env.FRONTEND_TEST_URL || "http://localhost:5173";
try {
  let release;
  holdGeneration = new Promise((resolve) => {
    release = resolve;
  });
  await page.goto(`${base}/assistant?source=pdf`);
  assert.equal(await page.getByRole("link", { name: "My Learning", exact: true }).count(), 0);
  assert.equal(await page.getByRole("link", { name: "Progress", exact: true }).count(), 0);
  assert.equal(await page.getByText("Paste transcript", { exact: true }).count(), 0);
  await page
    .getByLabel("Select PDF file")
    .setInputFiles({ name: "lecture.pdf", mimeType: "application/pdf", buffer: await textPdf() });
  await page.getByRole("checkbox", { name: "Detailed notes", exact: true }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("status", { name: "Study material processing", exact: true }).waitFor();
  await page.locator('.output-progress [data-status="generating"]').waitFor();
  assert.equal(
    await page
      .getByRole("status", { name: "Study material processing", exact: true })
      .getAttribute("aria-busy"),
    "true",
  );
  assert.equal(await page.getByRole("progressbar").count(), 0);
  assert.doesNotMatch(
    await page.locator(".generation-progress").textContent(),
    /%|Completed steps|estimated waiting/,
  );
  assert.ok(await page.locator(".generation-progress .animate-spin").count());
  assert.ok(await page.getByRole("button", { name: "Processing…", exact: true }).isDisabled());
  release();
  holdGeneration = null;
  await page.getByRole("button", { name: "Export PDF", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("status", { name: "Study material processing", exact: true })
      .getAttribute("aria-busy"),
    "false",
  );
  assert.equal(await page.locator(".generation-progress .animate-spin").count(), 0);
  assert.equal(await page.locator("[data-workspace-footer]").count(), 1);
  assert.equal(await page.locator("footer").count(), 1);
  const paper = page.locator('[aria-label="Generated study material"] .study-notebook');
  for (const type of new Set(notebookFixture.blocks.map((block) => block.type)))
    assert.ok((await paper.locator(`[data-block-type="${type}"]`).count()) > 0);
  await paper.getByText("What does atomicity guarantee?", { exact: true }).click();
  await paper.getByText("All changes happen or none do.", { exact: true }).first().waitFor();
  await paper.getByRole("button", { name: "A. Atomicity", exact: true }).click();
  await paper.getByRole("status").waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.match(await paper.evaluate((node) => getComputedStyle(node).fontFamily), /Kalam/);
  assert.equal(
    await paper
      .locator(".notebook-block:last-child")
      .evaluate((node) => getComputedStyle(node).marginBottom),
    "0px",
  );
  await mkdir(".cache/e2e", { recursive: true });
  await page.screenshot({ path: ".cache/e2e/workspace-full.png", fullPage: true });
  await paper.screenshot({ path: ".cache/e2e/notebook.png" });
  const pdfDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export PDF", exact: true }).click();
  await (await pdfDownload).saveAs(".cache/e2e/notebook-export.pdf");
  const pdf = await readFile(".cache/e2e/notebook-export.pdf");
  const exported = await extractDocument(pdf, "export.pdf", "pdf");
  assert.ok(exported.pages.length >= 3);
  assert.match(exported.text, /FINAL SECTION/);
  assert.match(exported.text, /All changes happen or none do/);
  assert.match(exported.text, /Atomicity prevents partial commits/);
  for (let i = 1; i <= 18; i++) assert.match(exported.text, new RegExp(`Extended section ${i}\\.`));
  const { getDocument } = await import(backendRequire.resolve("pdfjs-dist/legacy/build/pdf.mjs"));
  const printTask = getDocument({ data: new Uint8Array(pdf), useWasm: false, verbosity: 0 }),
    printed = await printTask.promise;
  for (let i = 1; i <= printed.numPages; i++) {
    const printedPage = await printed.getPage(i),
      [left, bottom, right, top] = printedPage.view;
    for (const item of (await printedPage.getTextContent()).items)
      if ("str" in item && item.str.trim()) {
        assert.ok(
          item.transform[4] >= left - 1 && item.transform[4] + item.width <= right + 1,
          `Page ${i}: text extends past horizontal page bounds`,
        );
        assert.ok(
          item.transform[5] >= bottom - 1 && item.transform[5] <= top + 1,
          `Page ${i}: text extends past vertical page bounds`,
        );
      }
  }
  await printTask.destroy();
  const count = generations;
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByRole("region", { name: "Generated study material" })
    .getByText("Reused · ready", { exact: true })
    .waitFor();
  assert.equal(generations, count);
  console.log(
    `PASS: PDF upload, real parsing, streamed stages, every notebook block, interactivity, cache reuse; exported ${exported.pages.length}-page readable PDF.`,
  );
  for (const [name, buffer] of [
    ["lecture.xlsx", workbook()],
    ["lecture.xls", workbook("xls")],
    ["lecture.csv", csv],
  ]) {
    await page.goto(`${base}/assistant?source=spreadsheet`);
    await page.getByLabel("Select Excel or CSV file").setInputFiles({
      name,
      mimeType: name.endsWith("xlsx")
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : name.endsWith("xls")
          ? "application/vnd.ms-excel"
          : "text/csv",
      buffer,
    });
    await page.getByRole("checkbox", { name: "Detailed notes", exact: true }).check();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("button", { name: "Export PDF", exact: true }).waitFor();
    await page.locator(".source-preview summary").click();
    assert.ok((await page.locator(".source-table").count()) > 0);
    console.log(
      `PASS: ${name} actual browser upload → real backend parser → isolated mocked Gemini → notebook.`,
    );
  }
  for (const name of [
    "Short notes",
    "Flashcards",
    "MCQ quizzes",
    "Mind maps",
    "Sample question papers",
  ])
    await page.getByRole("checkbox", { name, exact: true }).check();
  assert.equal(await page.getByLabel("Number of flashcards").inputValue(), "10");
  assert.equal(await page.getByLabel("Number of quiz questions").inputValue(), "10");
  await page.getByLabel("Number of flashcards").selectOption("20");
  await page.getByLabel("Number of quiz questions").selectOption("30");
  assert.equal(await page.getByRole("link", { name: "Flashcards", exact: true }).count(), 0);
  assert.equal(await page.getByRole("link", { name: "Quizzes", exact: true }).count(), 0);
  assert.doesNotMatch(
    await page.locator("main").textContent(),
    /Only the YouTube URL is checked here|URL validation does not check|YouTube detailed and short notes can be reused|Continue prepares your selected study materials|Completed steps/,
  );
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[aria-label="Generated study material"] [role="tab"]').length ===
      6,
  );
  await page.getByRole("tab", { name: /Flashcards/ }).click();
  await page.getByText(/Card 1 of 20/).waitFor();
  await page.getByRole("button", { name: "Flip card to answer" }).click();
  await page.getByText("All changes happen or none do.", { exact: true }).first().waitFor();
  await page.getByRole("tab", { name: /Quiz/ }).click();
  await page.getByText(/Question 1 of 30/).waitFor();
  await page.getByRole("tab", { name: /Mind map/ }).click();
  await page.getByRole("button", { name: "Zoom in" }).first().click();
  await page.getByText("120%", { exact: true }).first().waitFor();
  await page.getByRole("tab", { name: /Sample paper/ }).click();
  await page.getByRole("button", { name: "View answer guide" }).click();
  await page.getByRole("heading", { name: "Answer guide", exact: true }).waitFor();
  const allDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export PDF", exact: true }).click();
  await (await allDownload).saveAs(".cache/e2e/all-materials.pdf");
  const allTask = getDocument({
      data: new Uint8Array(await readFile(".cache/e2e/all-materials.pdf")),
      useWasm: false,
      verbosity: 0,
    }),
    allMaterials = await allTask.promise;
  let allText = "";
  for (let i = 1; i <= allMaterials.numPages; i++)
    allText += (await (await allMaterials.getPage(i)).getTextContent()).items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
  for (const label of [
    "Detailed Notes",
    "Short Notes",
    "Flashcards",
    "Mcq Quiz",
    "Mindmap",
    "Sample Question Paper",
  ])
    assert.ok(allText.includes(label), `Export includes ${label}`);
  assert.equal((allText.match(/FINAL SECTION/g) || []).length, 6);
  await allTask.destroy();
  assert.equal(await page.getByRole("link", { name: "Notes Gallery", exact: true }).count(), 0);
  assert.equal(await page.getByText(/Publish my completed resources/).count(), 0);
  console.log(
    "PASS: all six study-set outputs render/export with flashcard/quiz count selectors; separate navigation entries stay hidden and processing uses a subtle spinner.",
  );
  await page.goto(`${base}/assistant?source=pdf`);
  for (const [name, sourceType, buffer, expected] of [
    ["scan.pdf", "pdf", await scanPdf(), /Atomicity/],
    ["mixed.pdf", "pdf", await scanPdf({ mixed: true }), /Atomicity/],
    ["rotated.pdf", "pdf", await scanPdf({ rotated: true }), /Atomicity/],
    ["hindi.pdf", "pdf", await scanPdf({ hindi: true }), /भारत|शिक्षा|ज्ञान/],
    ["image.xlsx", "spreadsheet", await imageWorkbook({ multiple: true }), /Atomicity/],
    ["hindi-image.xlsx", "spreadsheet", await imageWorkbook({ hindi: true }), /भारत|शिक्षा|ज्ञान/],
  ]) {
    await page.goto(`${base}/assistant?source=${sourceType}`);
    await page
      .getByLabel(sourceType === "pdf" ? "Select PDF file" : "Select Excel or CSV file")
      .setInputFiles({
        name,
        mimeType:
          sourceType === "pdf"
            ? "application/pdf"
            : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer,
      });
    await page.getByRole("checkbox", { name: "Detailed notes", exact: true }).check();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("button", { name: "Export PDF", exact: true }).waitFor();
    await page.locator(".source-preview summary").click();
    assert.match(await page.locator(".source-preview").textContent(), expected);
    assert.match(await page.locator(".source-preview").textContent(), /OCR-derived/);
    console.log(`PASS: real local OCR browser upload ${name}; mocked Gemini only.`);
  }
  await page.goto(`${base}/assistant?source=pdf`);
  const { PDFDocument } = backendRequire("pdf-lib");
  const partialPdf = await PDFDocument.load(await scanPdf());
  partialPdf.addPage([595, 842]);
  await page.getByLabel("Select PDF file").setInputFiles({
    name: "partial.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await partialPdf.save()),
  });
  await page.getByRole("checkbox", { name: "Detailed notes", exact: true }).check();
  const beforePartial = generations;
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByRole("button", { name: "Use successfully extracted content", exact: true })
    .waitFor();
  assert.equal(generations, beforePartial);
  await page.locator(".source-preview summary").click();
  assert.match(await page.locator(".source-preview").textContent(), /Page 2 could not/);
  assert.match(await page.locator(".source-preview").textContent(), /Atomicity/);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByRole("button", { name: "Use successfully extracted content", exact: true })
    .waitFor();
  assert.equal(generations, beforePartial);
  await page
    .getByRole("button", { name: "Use successfully extracted content", exact: true })
    .click();
  await page.getByRole("button", { name: "Export PDF", exact: true }).waitFor();
  assert.equal(generations, beforePartial + 1);
  console.log(
    "PASS: partial PDF keeps readable content, reports blank page, retries safely and requires explicit consent before mocked generation.",
  );
  await page.goto(`${base}/assistant?source=pdf`);
  const retryPdf = await PDFDocument.load(await textPdf());
  retryPdf.addPage([595, 842]).drawText("Unique source for failed generation Retry verification.");
  await page.getByLabel("Select PDF file").setInputFiles({
    name: "retry.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await retryPdf.save()),
  });
  await page.getByRole("checkbox", { name: "Detailed notes", exact: true }).check();
  await page.getByRole("checkbox", { name: "Short notes", exact: true }).check();
  failShortOnce = true;
  const beforeRetry = generations;
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
  assert.match(
    await page.getByRole("alert").textContent(),
    /We couldn’t prepare your study materials\./,
  );
  assert.doesNotMatch(await page.getByRole("alert").textContent(), /operator|Private provider/i);
  assert.equal(generations, beforeRetry + 2);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByRole("button", { name: "Export PDF", exact: true }).waitFor();
  assert.equal(generations, beforeRetry + 3);
  const retried = page.locator('[aria-label="Generated study material"]');
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[aria-label="Generated study material"] [role="tab"]').length ===
      2,
  );
  assert.equal(await retried.getByRole("tab").count(), 2);
  assert.match(await retried.textContent(), /Reused · ready/);
  assert.match(await retried.textContent(), /Prepared · ready/);
  console.log(
    "PASS: genuine failure exposes working Retry; successful notes are cached and only the missing output is generated/rendered.",
  );
  await page.goto(`${base}/assistant?source=pdf`);
  await page.getByLabel("Select PDF file").setInputFiles({
    name: "corrupt.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("not a PDF"),
  });
  await page.getByRole("checkbox", { name: "Detailed notes", exact: true }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("alert").waitFor();
  assert.match(
    await page.getByRole("alert").textContent(),
    /We couldn’t prepare your study materials\./,
  );
  await page.goto(`${base}/assistant`);
  await page
    .getByRole("textbox", { name: "YouTube URL", exact: true })
    .fill("https://example.com/bad");
  await page.getByRole("checkbox", { name: "Detailed notes", exact: true }).check();
  assert.ok(await page.getByRole("button", { name: "Continue", exact: true }).isDisabled());
  await page
    .getByRole("textbox", { name: "YouTube URL", exact: true })
    .fill("https://youtu.be/AbCdEf12_-3?t=5");
  await page.getByText(/YouTube URL is valid/).waitFor();
  assert.equal(
    await page.getByRole("dialog", { name: "Customize your learning material" }).count(),
    0,
  );
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Export PDF", exact: true }).waitFor();
  assert.equal(await page.locator(".source-preview").count(), 0);
  assert.equal(await page.locator('a[href*="&t="]').count(), 0);
  assert.equal(
    await page
      .getByRole("status", { name: "Study material processing", exact: true })
      .getAttribute("aria-busy"),
    "false",
  );
  const secondContext = await browser.newContext({ viewport: { width: 390, height: 844 } }),
    other = await secondContext.newPage();
  for (const kind of ["workspace", "library"])
    await other.route(`**/api/v1/${kind}/**`, (route) =>
      route.continue({ url: api + new URL(route.request().url()).pathname }),
    );
  await other.goto(`${base}/assistant`);
  await other
    .getByRole("textbox", { name: "YouTube URL", exact: true })
    .fill("https://www.youtube.com/live/AbCdEf12_-3?si=tracking");
  await other.getByRole("checkbox", { name: "Detailed notes", exact: true }).check();
  await other.getByRole("checkbox", { name: "Short notes", exact: true }).check();
  await other.getByText(/YouTube URL is valid/).waitFor();
  const beforeSecondUser = generations;
  await other.getByRole("button", { name: "Continue", exact: true }).click();
  await other.getByRole("tab", { name: /Short notes/ }).waitFor();
  assert.equal(generations, beforeSecondUser + 1);
  await other.getByRole("button", { name: "Continue", exact: true }).click();
  await other.getByText("Reused · ready", { exact: true }).first().waitFor();
  assert.equal(generations, beforeSecondUser + 1);
  assert.ok(
    await other.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  );
  await secondContext.close();
  console.log(
    "PASS: two browser sessions reuse the same canonical video notes in real PostgreSQL; only missing short notes generated, recorded once, and reused.",
  );
  await page.goto(`${base}/assistant`);
  let started, releaseVerification;
  const verificationStarted = new Promise((resolve) => {
      started = resolve;
    }),
    holdVerification = new Promise((resolve) => {
      releaseVerification = resolve;
    });
  const delayedVerification = async (route) => {
    const requested = JSON.parse(route.request().postData()).url;
    if (requested.includes("AbCdEf12_-3")) {
      started();
      await holdVerification;
      await route
        .fulfill({
          json: {
            data: {
              status: "verified",
              videoId: "AbCdEf12_-3",
              title: "Stale fixture",
              verificationToken: "stale-token",
              message: "Stale lecture verified",
            },
          },
        })
        .catch(() => {});
    } else
      await route.fulfill({
        json: {
          data: {
            status: "unavailable",
            videoId: "ZyXwVu98_-1",
            message: "New lecture has no usable captions.",
          },
        },
      });
  };
  await page.route("**/api/v1/workspace/verify", delayedVerification);
  await page
    .getByRole("textbox", { name: "YouTube URL", exact: true })
    .fill("https://youtu.be/AbCdEf12_-3");
  await verificationStarted;
  await page
    .getByRole("textbox", { name: "YouTube URL", exact: true })
    .fill("https://youtu.be/ZyXwVu98_-1");
  await page.getByText("New lecture has no usable captions.", { exact: true }).waitFor();
  releaseVerification();
  assert.ok(await page.getByRole("button", { name: "Continue", exact: true }).isDisabled());
  assert.equal(await page.getByText("Stale lecture verified", { exact: true }).count(), 0);
  await page.unroute("**/api/v1/workspace/verify", delayedVerification);
  console.log(
    "PASS: changing the URL cancels/ignores stale verification and does not enable Continue for the wrong lecture.",
  );
  await page.goto(`${base}/assistant`);
  for (const [status, code, expected] of [
    [503, "LEARNING_SCHEMA_MISSING", "Lecture storage is not ready yet."],
    [503, "LEARNING_STORAGE_FORBIDDEN", "Lecture storage needs a connection repair."],
    [503, "VIDEO_METADATA_UNAVAILABLE", "YouTube could not be reached."],
    [429, "rate_limited", "Too many lectures are being checked right now."],
  ]) {
    const errorRoute = (route) =>
      route.fulfill({ status, json: { error: { code, message: "SECRET_PROVIDER_DETAIL" } } });
    await page.route("**/api/v1/workspace/verify", errorRoute);
    await page
      .getByRole("textbox", { name: "YouTube URL", exact: true })
      .fill("https://youtu.be/AbCdEf12_-3");
    if (await page.getByRole("button", { name: "Check lecture again", exact: true }).count())
      await page.getByRole("button", { name: "Check lecture again", exact: true }).click();
    await page.getByText(expected, { exact: false }).waitFor();
    assert.ok(await page.getByRole("button", { name: "Continue", exact: true }).isDisabled());
    assert.equal(await page.getByText("SECRET_PROVIDER_DETAIL", { exact: false }).count(), 0);
    await page.unroute("**/api/v1/workspace/verify", errorRoute);
  }
  console.log(
    "PASS: schema, permission, metadata and rate-limit failures have distinct safe student messages with no raw server error leakage.",
  );
  await page.goto(`${base}/assistant`);
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page
    .getByRole("textbox", { name: "Ask a doubt or request notes", exact: true })
    .fill("Explain database transactions with a simple example.");
  let askRequests = 0;
  const countAsk = (request) => {
    if (request.url().endsWith("/workspace/ask")) askRequests++;
  };
  page.on("request", countAsk);
  await page.getByRole("button", { name: "Ask UrTutor", exact: true }).click();
  await page.waitForURL(`${base}/ask`);
  const tutor = page.getByRole("region", { name: "Ask UrTutor", exact: true });
  await tutor.waitFor();
  await tutor.getByText("Database transactions", { exact: true }).waitFor();
  assert.equal(askRequests, 1);
  assert.equal(await page.getByRole("dialog").count(), 0);
  await tutor
    .getByRole("textbox", { name: "Message UrTutor", exact: true })
    .fill("Make quick revision notes about atomicity.");
  await tutor.getByRole("textbox", { name: "Message UrTutor", exact: true }).press("Enter");
  await page.waitForFunction(
    () => document.querySelectorAll("article.study-notebook").length === 2,
  );
  assert.equal(askRequests, 2);
  page.off("request", countAsk);
  await tutor.getByRole("link", { name: "Back to workspace", exact: true }).click();
  await tutor.waitFor({ state: "hidden" });
  assert.equal(await tutor.isVisible(), false);
  const askFailure = (route) =>
    route.fulfill({
      status: 503,
      json: { error: { code: "TUTOR_FAILED", message: "SECRET_PROVIDER_DETAIL" } },
    });
  await page.route("**/api/v1/workspace/ask", askFailure);
  await page
    .getByRole("textbox", { name: "Ask a doubt or request notes", exact: true })
    .fill("Explain recursion.");
  await page
    .getByRole("textbox", { name: "Ask a doubt or request notes", exact: true })
    .press("Enter");
  await page.waitForURL(`${base}/ask`);
  await tutor.getByRole("alert").waitFor();
  assert.match(await tutor.getByRole("alert").textContent(), /could not be completed/);
  assert.equal(await tutor.getByText("SECRET_PROVIDER_DETAIL", { exact: false }).count(), 0);
  await tutor.getByRole("button", { name: "Dismiss", exact: true }).click();
  assert.equal(await tutor.getByRole("alert").count(), 0);
  await tutor.getByRole("link", { name: "Back to workspace", exact: true }).click();
  await page.unroute("**/api/v1/workspace/ask", askFailure);
  console.log(
    "PASS: inline search opens a dedicated GPT-style answer page, submits once, supports new questions and dismisses failures without exposing server details.",
  );
  await page.goto(`${base}/assistant`);
  await page
    .getByRole("textbox", { name: "YouTube URL", exact: true })
    .fill("https://youtu.be/IELMSD2kdmk");
  await page.getByRole("checkbox", { name: "Detailed notes", exact: true }).check();
  await page.getByText(/YouTube URL is valid/).waitFor();
  assert.ok(await page.getByRole("button", { name: "Continue", exact: true }).isEnabled());
  assert.equal(await page.getByText(/This lecture has no usable transcript/).count(), 0);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("alert").waitFor();
  assert.match(
    await page.getByRole("alert").textContent(),
    /We couldn’t prepare your study materials\./,
  );
  assert.doesNotMatch(
    await page.getByRole("alert").textContent(),
    /transcript|support|provider|request|service|corrected/i,
  );
  await page.getByRole("button", { name: "Dismiss this attempt", exact: true }).click();
  const privateTranscriptFailure = (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body:
        JSON.stringify({
          event: "error",
          code: "TRANSCRIPT_REQUEST_FAILED",
          message:
            "A previous transcript check did not finish safely. We have not started another request. Please contact support or use another lecture. SECRET_PROVIDER_DETAIL",
          retryable: false,
        }) + "\n",
    });
  await page.route("**/api/v1/workspace/process", privateTranscriptFailure);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("alert").waitFor();
  assert.equal(
    (await page.getByRole("alert").textContent()).trim(),
    "We couldn’t prepare your study materials.Dismiss this attempt",
  );
  await page.getByRole("button", { name: "Dismiss this attempt", exact: true }).click();
  assert.equal(await page.getByRole("alert").count(), 0);
  assert.ok(await page.getByRole("button", { name: "Continue", exact: true }).isEnabled());
  await page.unroute("**/api/v1/workspace/process", privateTranscriptFailure);
  console.log(
    "PASS: transcript failures show only a minimal message; internal details stay hidden and dismissal clears the attempt.",
  );
  let cooldownRequests = 0;
  let cooldownEvent;
  const quotaFailure = (route) => {
    cooldownRequests++;
    return route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: JSON.stringify(cooldownEvent) + "\n",
    });
  };
  await page.route("**/api/v1/workspace/process", quotaFailure);
  for (const event of [
    {
      event: "error",
      code: "GEMINI_QUOTA",
      message: "SECRET_PROVIDER_DETAIL",
      retryable: true,
      retryAfterSeconds: 54553,
    },
    {
      event: "result",
      result: {
        status: "pending",
        message: "SECRET_PROVIDER_DETAIL",
        retrySafe: true,
        retryAfterSeconds: 54553,
      },
    },
    {
      event: "error",
      code: "GEMINI_TEMPORARY",
      message: "SECRET_PROVIDER_DETAIL",
      retryable: true,
      retryAfterSeconds: 1,
    },
  ]) {
    cooldownEvent = event;
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByText("Please try again later.", { exact: true }).waitFor();
    assert.doesNotMatch(
      await page.locator("main").textContent(),
      /54553|Retry available in|SECRET_PROVIDER_DETAIL/,
    );
    assert.equal(await page.getByRole("button", { name: "Retry", exact: true }).count(), 0);
    assert.ok(await page.getByRole("button", { name: "Continue", exact: true }).isDisabled());
    if (event.retryAfterSeconds === 1) {
      await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
      assert.ok(await page.getByRole("button", { name: "Retry", exact: true }).isEnabled());
    }
    await page.getByRole("button", { name: "Dismiss this attempt", exact: true }).click();
  }
  assert.equal(cooldownRequests, 3);
  await page.unroute("**/api/v1/workspace/process", quotaFailure);
  console.log(
    "PASS: quota cooldowns never show a numeric countdown or unusable Retry; safe Retry returns after expiry without automatic requests.",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/assistant?source=pdf`);
  await page
    .getByLabel("Select PDF file")
    .setInputFiles({ name: "lecture.pdf", mimeType: "application/pdf", buffer: await textPdf() });
  await page.getByRole("checkbox", { name: "Detailed notes", exact: true }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Export PDF", exact: true }).waitFor();
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  );
  assert.deepEqual(errors, []);
  const fencedBytes = await scanPdf({ mixed: true, hindi: true });
  const fencedSource = await extractDocument(fencedBytes, "fenced.pdf", "pdf");
  const { createHash } = await import("node:crypto");
  const operation = createHash("sha256")
    .update(
      JSON.stringify({
        source: fencedSource.kind,
        text: fencedSource.text,
        outputType: "short_notes",
      }),
    )
    .digest("hex");
  const fencedToken = cache.claim("legacy-uncertain", operation);
  cache.evidence("legacy-uncertain", fencedToken, { kind: "dispatch" });
  cache.evidence("legacy-uncertain", fencedToken, { kind: "response", httpStatus: 400 });
  cache.fail("legacy-uncertain", fencedToken, "GEMINI_UNCERTAIN", false);
  await page.goto(`${base}/assistant?source=pdf`);
  await page.getByLabel("Select PDF file").setInputFiles({
    name: "new-source.pdf",
    mimeType: "application/pdf",
    buffer: fencedBytes,
  });
  await page.getByRole("checkbox", { name: "Short notes", exact: true }).check();
  const beforeFence = generations;
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("alert").waitFor();
  assert.match(
    await page.getByRole("alert").textContent(),
    /We couldn’t prepare your study materials\./,
  );
  assert.ok(await page.getByRole("button", { name: "Continue", exact: true }).isDisabled());
  assert.doesNotMatch(
    await page.getByRole("alert").textContent(),
    /previous|generation|charges|provider|request|safely|support/i,
  );
  assert.equal(generations, beforeFence);
  await page.getByRole("button", { name: "Check result", exact: true }).click();
  await page.getByRole("button", { name: "Check result", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Retry", exact: true }).count(), 0);
  assert.equal(generations, beforeFence);
  cache.recoverJob(
    "legacy-uncertain",
    {
      revision: cache.inspectJob("legacy-uncertain").revision,
      action: "confirm_rejected",
      reason: "Mocked test response proves rejection; no real provider used.",
    },
    "test-operator",
  );
  await page.getByRole("button", { name: "Check result", exact: true }).click();
  await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
  assert.equal(generations, beforeFence);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByRole("button", { name: "Export PDF", exact: true }).waitFor();
  assert.equal(generations, beforeFence + 1);
  console.log(
    "PASS: uncertain legacy job is fenced; Check result makes no provider call and Retry appears only after definitive backend confirmation.",
  );
  console.log(
    "PASS: corrupt PDF, invalid YouTube URL, automatic verification, unavailable transcripts, no gallery/publishing, mobile layout; zero uncaught browser errors. No live providers used.",
  );
} catch (error) {
  console.error(await page.locator("main").innerText());
  throw error;
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  cache.close();
  await db.close();
  await library.close();
  await rm(directory, { recursive: true, force: true });
}
