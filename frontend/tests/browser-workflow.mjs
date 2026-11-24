import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { notebookFixture } from "./helpers/notebook-fixture.mjs";
import { textPdf, workbook, csv } from "../../backend/tests/helpers/documents.mjs";
import { scanPdf } from "../../backend/tests/helpers/document-visual-fixtures.mjs";
import { galleryClientFixture } from "../../backend/tests/helpers/admin-gallery-client.mjs";
const backendRequire = createRequire(new URL("../../backend/package.json", import.meta.url));
const { Router } = backendRequire("express");
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.GALLERY_ADMIN_PASSWORD = "synthetic-browser-admin-password-only";
for (const key of [
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "TRANSCRIPTFETCH_API_KEY",
  "FREEGG_API_KEY",
  "OPENROUTER_API_KEY",
])
  process.env[key] = "";
const { createApp } = await import("../../backend/dist/app.js");
const { createWorkspaceRouter } = await import("../../backend/dist/routes/workspace.routes.js");
const { createTemporaryWorkspaceService } =
  await import("../../backend/dist/services/temporary-workspace.service.js");
const { createAdminGallery } = await import("../../backend/dist/repositories/admin-gallery.js");
const { createAdminGalleryRouter } =
  await import("../../backend/dist/routes/admin-gallery.routes.js");
const { extractDocument } = await import("../../backend/dist/modules/extraction/documents.js");
const { AppError } = await import("../../backend/dist/lib/errors.js");
const fixture = galleryClientFixture();
let generations = 0,
  captions = 0,
  failShort = false;
const service = createTemporaryWorkspaceService({
  extract: extractDocument,
  transcript: () => ({
    acquire: async () => {
      captions++;
      return {
        status: "available",
        transcript: {
          text: "Atomicity means all changes succeed or roll back.",
          segments: [],
          metadata: {},
        },
      };
    },
  }),
  gemini: () => ({
    model: "fixture",
    generate: async (_text, type, options) => {
      generations++;
      if (options.pdf)
        assert.equal(Buffer.from(options.pdf.data, "base64").subarray(0, 5).toString(), "%PDF-");
      if (failShort && type === "short_notes") {
        failShort = false;
        throw new Error("SECRET_PROVIDER_DETAIL");
      }
      if (type === "flashcards" || type === "mcq_quiz") {
        const blockType = type === "flashcards" ? "flashcard" : "quiz",
          count =
            type === "flashcards" ? (options.flashcardCount ?? 10) : (options.quizCount ?? 10);
        return {
          ...notebookFixture,
          blocks: notebookFixture.blocks.flatMap((b) =>
            b.type === blockType
              ? Array.from({ length: count }, (_, i) => ({
                  ...b,
                  question: `${b.question} (${i + 1})`,
                  ...(blockType === "quiz"
                    ? { options: ["Atomicity", "Isolation", "Durability", "Consistency"] }
                    : {}),
                }))
              : b,
          ),
        };
      }
      return notebookFixture;
    },
  }),
});
const router = Router();
const askModes = [];
let failAsk = false;
router.use("/gallery", createAdminGalleryRouter(createAdminGallery(() => fixture.client)));
router.use(
  "/workspace",
  createWorkspaceRouter(service, undefined, 200, undefined, undefined, async (input) => {
    askModes.push(input.answerMode);
    if (failAsk) {
      failAsk = false;
      throw new AppError("Gemini is busy right now. Please try again shortly.", {
        code: "GEMINI_TEMPORARY",
        statusCode: 503,
      });
    }
    return {
      notebook: notebookFixture,
      cached: false,
      provider: input.answerMode === "detailed" ? "FreeGG" : "Gemini",
    };
  }),
);
const server = createApp(router).listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const api = `http://localhost:${server.address().port}`;
const browser = await chromium.launch(),
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [],
  requests = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/api/v1/**", (route) => {
  const url = new URL(route.request().url());
  requests.push(url.pathname);
  return route.continue({ url: api + url.pathname + url.search });
});
const base = process.env.FRONTEND_TEST_URL || "http://localhost:5173";
const pdfBytes = await textPdf();
async function generatePdf(types = ["Detailed notes"], bytes = pdfBytes) {
  await page.goto(`${base}/assistant?source=pdf`);
  await page
    .getByLabel("Select PDF file")
    .setInputFiles({ name: "lecture.pdf", mimeType: "application/pdf", buffer: bytes });
  for (const name of types) await page.getByRole("checkbox", { name, exact: true }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Export PDF", exact: true }).waitFor();
}
try {
  await generatePdf();
  const paper = page.locator('[aria-label="Generated study material"] .study-notebook');
  for (const type of new Set(notebookFixture.blocks.map((block) => block.type)))
    assert.ok(await paper.locator(`[data-block-type="${type}"]`).count());
  await paper.getByText("What does atomicity guarantee?", { exact: true }).click();
  await paper.getByText("All changes happen or none do.", { exact: true }).first().waitFor();
  await paper.getByRole("button", { name: "A. Atomicity", exact: true }).click();
  const sourceChecks = page.locator(
    '[aria-label="Generated study material"] details.notebook-limitations',
  );
  assert.equal(await sourceChecks.getAttribute("open"), null);
  assert.equal(await paper.locator(".notebook-limitations").count(), 0);
  assert.match(await paper.evaluate((node) => getComputedStyle(node).fontFamily), /Kalam/);
  assert.equal(await paper.locator("math mfrac").count(), 1);
  assert.equal(await paper.locator("math msqrt").count(), 1);
  assert.match(
    await paper.locator("math").evaluate((node) => getComputedStyle(node).fontFamily),
    /STIX Two Math/,
  );
  assert.ok((await paper.locator(".notebook-graph path[marker-end]").count()) > 0);
  const arrowId = await paper.locator(".notebook-graph marker").first().getAttribute("id");
  assert.ok(!arrowId.includes("«") && !arrowId.includes("»"));
  await mkdir(".cache/e2e", { recursive: true });
  await paper
    .locator(".notebook-formula")
    .last()
    .screenshot({ path: ".cache/e2e/notebook-math.png" });
  await paper
    .locator(".notebook-graph")
    .first()
    .screenshot({ path: ".cache/e2e/notebook-diagram.png" });
  await page.screenshot({ path: ".cache/e2e/notes-reading.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.setViewportSize({ width: 1280, height: 900 });
  const screenFonts = await paper.evaluate((node) => ({
    body: getComputedStyle(node).fontFamily,
    heading: getComputedStyle(node.querySelector("h1")).fontFamily,
    formula: getComputedStyle(node.querySelector("math")).fontFamily,
  }));
  await page.emulateMedia({ media: "print" });
  const printFonts = await page
    .locator("#notebook-print-root .study-notebook")
    .evaluate((node) => ({
      body: getComputedStyle(node).fontFamily,
      heading: getComputedStyle(node.querySelector("h1")).fontFamily,
      formula: getComputedStyle(node.querySelector("math")).fontFamily,
    }));
  assert.match(screenFonts.body, /Kalam/);
  assert.match(screenFonts.heading, /Caveat/);
  assert.match(printFonts.body, /Kalam/);
  assert.match(printFonts.heading, /Caveat/);
  assert.equal(printFonts.formula, screenFonts.formula);
  await page.pdf({ path: ".cache/e2e/browser-print.pdf", format: "A4", printBackground: true });
  await page.emulateMedia({ media: "screen" });
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export PDF", exact: true }).click();
  await (await download).saveAs(".cache/e2e/notebook-export.pdf");
  for (const file of [".cache/e2e/notebook-export.pdf", ".cache/e2e/browser-print.pdf"]) {
    const bytes = await readFile(file);
    assert.match(bytes.toString("latin1"), /Kalam/);
    assert.match(bytes.toString("latin1"), /Caveat/);
  }
  const exported = await extractDocument(
    await readFile(".cache/e2e/notebook-export.pdf"),
    "export.pdf",
    "pdf",
  );
  assert.ok(exported.pages.length >= 3);
  assert.match(exported.text, /FINAL SECTION/);
  assert.match(exported.text, /Begin transaction/);
  assert.match(exported.text, /Commit changes/);
  assert.doesNotMatch(
    exported.text,
    /Keep in mind|Isolated mocked-provider browser test|Not actual previous.year questions|Source checks/,
  );
  for (let i = 1; i <= 18; i++) assert.match(exported.text, new RegExp(`Extended section ${i}\\.`));
  const exportEndpoint = "**/api/v1/workspace/export";
  await page.route(exportEndpoint, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"error":{"code":"PDF_EXPORT_FAILED","message":"private server path must not be shown"}}',
    }),
  );
  await page.getByRole("button", { name: "Export PDF", exact: true }).click();
  await page.getByRole("button", { name: "Print / Save as PDF", exact: true }).waitFor();
  assert.match(await page.getByRole("alert").textContent(), /server could not prepare/);
  assert.doesNotMatch(await page.getByRole("alert").textContent(), /private server path/);
  await page.evaluate(() => {
    window.print = () => {
      window.__printInvoked = true;
    };
  });
  await page.getByRole("button", { name: "Print / Save as PDF", exact: true }).click();
  await page.waitForFunction(() => window.__printInvoked === true);
  await page.unroute(exportEndpoint);
  await page.route(exportEndpoint, (route) =>
    route.fulfill({ status: 200, contentType: "application/pdf", body: "Not actually a PDF" }),
  );
  await page.getByRole("button", { name: "Export PDF", exact: true }).click();
  await page
    .getByText("The server did not return a valid PDF. Use Print / Save as PDF or retry.", {
      exact: true,
    })
    .waitFor();
  await page.unroute(exportEndpoint);
  const count = generations;
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Export PDF", exact: true }).waitFor();
  assert.equal(generations, count + 1);
  console.log(
    `PASS: real PDF parsing, notebook blocks/interactivity and readable ${exported.pages.length}-page Chromium export; repeated document generates anew.`,
  );
  for (const [name, buffer] of [
    ["lecture.xlsx", workbook()],
    ["lecture.xls", workbook("xls")],
    ["lecture.csv", csv],
  ]) {
    await page.goto(`${base}/assistant?source=spreadsheet`);
    await page.getByLabel("Select Excel or CSV file").setInputFiles({ name, buffer });
    await page.getByRole("checkbox", { name: "Detailed notes", exact: true }).check();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("button", { name: "Export PDF", exact: true }).waitFor();
  }
  await generatePdf([
    "Detailed notes",
    "Short notes",
    "Flashcards",
    "MCQ quizzes",
    "Mind maps",
    "Sample question papers",
  ]);
  for (const name of [
    "Detailed notes",
    "Short notes",
    "Flashcards",
    "Quiz",
    "Mind map",
    "Sample paper",
  ]) {
    await page.getByRole("tab", { name: new RegExp(name, "i") }).click();
    assert.equal(await page.getByRole("button", { name: "Export PDF", exact: true }).count(), 1);
  }
  await page.getByRole("tab", { name: /Flashcards/ }).click();
  await page.getByRole("button", { name: "Next card", exact: true }).click();
  await page.getByRole("tab", { name: /Quiz/ }).click();
  await page.getByRole("radio", { name: /Atomicity/ }).check();
  await page.getByRole("button", { name: "Submit quiz", exact: true }).click();
  await page.getByRole("button", { name: "Retry quiz", exact: true }).waitFor();
  await page.getByRole("tab", { name: /Flashcards/ }).click();
  assert.match(await page.locator(".flashcard-deck").textContent(), /Card 2 of/);
  assert.equal(fixture.rows.length, 0);
  await generatePdf(["Detailed notes"], await scanPdf());
  failShort = true;
  await generatePdf(["Detailed notes", "Short notes"]);
  await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
  assert.doesNotMatch(await page.getByRole("alert").textContent(), /SECRET_PROVIDER_DETAIL/);
  const beforeRetry = generations;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByRole("tab", { name: /Short notes/ }).click();
  assert.match(
    await page.locator(".revision-sheet").evaluate((node) => getComputedStyle(node).fontFamily),
    /Kalam/,
  );
  assert.equal(generations, beforeRetry + 1);
  await page.reload();
  assert.equal(await page.getByRole("button", { name: "Export PDF", exact: true }).count(), 0);
  console.log(
    "PASS: spreadsheets, all six outputs, page-local quizzes/cards, direct scanned PDF forwarding and failed-output-only Retry; refresh discards generated work.",
  );
  await page.goto(`${base}/assistant?source=youtube`);
  await page
    .getByRole("textbox", { name: "YouTube URL", exact: true })
    .fill("https://youtu.be/AbCdEf12_-3");
  await page.getByRole("checkbox", { name: "Detailed notes", exact: true }).check();
  await page.getByText(/YouTube URL is valid/).waitFor();
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("button", { name: "Export PDF", exact: true }).waitFor();
  }
  assert.equal(captions, 2);
  await page.goto(`${base}/ask`);
  await page
    .getByRole("textbox", { name: "Message UrTutor", exact: true })
    .fill("Explain atomicity");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.locator(".study-notebook").waitFor();
  assert.equal(askModes.at(-1), "auto");
  await page.getByLabel("Answer length").selectOption("detailed");
  await page
    .getByRole("textbox", { name: "Message UrTutor", exact: true })
    .fill("Explain recursion in detail");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByText("Answered by FreeGG", { exact: true }).waitFor();
  assert.equal(askModes.at(-1), "detailed");
  await page.getByLabel("Answer length").selectOption("quick");
  failAsk = true;
  await page
    .getByRole("textbox", { name: "Message UrTutor", exact: true })
    .fill("what is recursion");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page
    .getByText("Gemini is busy right now. Please try again shortly.", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page
    .getByText("Gemini is busy right now. Please try again shortly.", { exact: true })
    .waitFor({ state: "detached" });
  assert.equal(askModes.at(-1), "quick");
  assert.ok(!requests.some((path) => /\/library\/|\/youtube\/|\/operator\//.test(path)));
  assert.equal(fixture.rows.length, 0);
  console.log(
    "PASS: same YouTube URL refetches captions; Ask works without login or user database records.",
  );
  await page.goto(`${base}/admin`);
  await page.getByLabel("Admin password").fill("wrong");
  await page.getByRole("button", { name: "Sign in as admin" }).click();
  await page.getByText("Incorrect admin password.").waitFor();
  await page.getByLabel("Admin password").fill(process.env.GALLERY_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in as admin" }).click();
  await page.getByRole("button", { name: "Upload notes to gallery" }).waitFor();
  await page.getByLabel("Note title").fill("Database Transactions");
  await page.getByLabel("Course", { exact: true }).fill("B.Tech");
  await page.getByRole("combobox", { name: "Semester", exact: true }).selectOption("3");
  await page.getByLabel("Subject", { exact: true }).fill("DBMS");
  await page
    .getByLabel(/PDF notes/)
    .setInputFiles({ name: "notes.pdf", mimeType: "application/pdf", buffer: pdfBytes });
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Upload notes to gallery" }).click();
  await page.getByText(/Notes uploaded/).waitFor();
  assert.equal(fixture.rows.length, 1);
  const gallery = createAdminGallery(() => fixture.client);
  await gallery.upload(
    {
      title: "Semester four mathematics",
      course: "B.Tech",
      semester: 4,
      subject: "Mathematics",
      rightsConfirmed: true,
    },
    pdfBytes,
  );
  await gallery.upload(
    {
      title: "BCA discrete mathematics",
      course: "BCA",
      semester: 3,
      subject: "Discrete Mathematics",
      rightsConfirmed: true,
    },
    pdfBytes,
  );
  await page.getByRole("button", { name: "Sign out of admin" }).click();
  await page.getByLabel("Admin password").waitFor();
  let rejectPreviewOnce = true;
  const targetNote = fixture.rows.find((note) => note.title === "Database Transactions");
  await page.route(`**/api/v1/gallery/notes/${targetNote.id}/preview*`, (route) => {
    if (rejectPreviewOnce) {
      rejectPreviewOnce = false;
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":{"code":"GALLERY_PREVIEW_UNAVAILABLE"}}',
      });
    }
    return route.fallback();
  });
  await page.goto(`${base}/gallery`);
  await page.getByText("Database Transactions", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Retry preview", exact: true }).click();
  assert.equal(
    await page.getByRole("combobox", { name: "Subject", exact: true }).isDisabled(),
    true,
  );
  await page.getByRole("combobox", { name: "Course", exact: true }).selectOption("B.Tech");
  assert.equal(
    await page.getByRole("combobox", { name: "Subject", exact: true }).isDisabled(),
    true,
  );
  await page.getByRole("combobox", { name: "Semester", exact: true }).selectOption("3");
  assert.doesNotMatch(
    await page.getByRole("combobox", { name: "Subject", exact: true }).textContent(),
    /Mathematics/,
  );
  await page.getByRole("combobox", { name: "Subject", exact: true }).selectOption("DBMS");
  const preview = page.getByRole("img", {
    name: "First page of Database Transactions",
    exact: true,
  });
  await preview.waitFor();
  await preview.evaluate((image) => image.decode());
  assert.ok(await preview.evaluate((image) => image.naturalWidth > 100));
  assert.equal(await preview.evaluate((image) => image.getBoundingClientRect().height), 112);
  assert.ok(
    await preview.evaluate(
      (image) => image.closest("article").getBoundingClientRect().height < 280,
    ),
  );
  await page.getByRole("combobox", { name: "Semester", exact: true }).selectOption("4");
  assert.equal(await page.getByRole("combobox", { name: "Subject", exact: true }).inputValue(), "");
  assert.match(
    await page.getByRole("combobox", { name: "Subject", exact: true }).textContent(),
    /Mathematics/,
  );
  assert.doesNotMatch(
    await page.getByRole("combobox", { name: "Subject", exact: true }).textContent(),
    /DBMS/,
  );
  await page.getByRole("combobox", { name: "Course", exact: true }).selectOption("BCA");
  assert.equal(
    await page.getByRole("combobox", { name: "Semester", exact: true }).inputValue(),
    "",
  );
  await page.getByRole("combobox", { name: "Semester", exact: true }).selectOption("3");
  assert.match(
    await page.getByRole("combobox", { name: "Subject", exact: true }).textContent(),
    /Discrete Mathematics/,
  );
  assert.doesNotMatch(
    await page.getByRole("combobox", { name: "Subject", exact: true }).textContent(),
    /DBMS/,
  );
  await page.getByRole("combobox", { name: "Course", exact: true }).selectOption("B.Tech");
  await page.getByRole("combobox", { name: "Semester", exact: true }).selectOption("3");
  await page.getByRole("combobox", { name: "Subject", exact: true }).selectOption("DBMS");
  await page.getByRole("link", { name: "Open / download PDF", exact: true }).waitFor();
  await page.screenshot({ path: ".cache/e2e/gallery-admin-pdfs.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByText("Database Transactions", { exact: true }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.deepEqual(errors, []);
  console.log(
    "PASS: notes-only PDF, clean screen/mobile notes, admin PDF upload, decoded first-page gallery thumbnails and course-semester-scoped subjects; no live providers/Supabase used.",
  );
} catch (error) {
  console.error(await page.locator("body").innerText());
  throw error;
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
