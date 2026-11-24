// Explicit opt-in: talks to the running local API with its REAL configured providers.
// Prepare/generate the tiny PDF fixture via backend/scripts/live-workflow.mjs first.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
if (!process.argv.includes("--live")) throw new Error("Pass --live to verify the real local app");
const directory = fileURLToPath(new URL("../.cache/live-workflow/", import.meta.url));
await mkdir(directory, { recursive: true, mode: 0o700 });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
  errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  const youtube = process.argv.includes("--youtube");
  // This browser check must only replay saved results. A missing/uncertain cache
  // cannot silently turn a verification rerun into another paid generation.
  const api = process.env.LIVE_API_URL ?? "http://localhost:4000/api/v1";
  if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+\/api\/v1$/.test(api))
    throw new Error("Only a local API is allowed");
  const preflight = new FormData();
  preflight.append(
    "options",
    JSON.stringify(
      youtube
        ? {
            sourceType: "youtube",
            url: "https://www.youtube.com/watch?v=iJC87bWWuPM",
            transcriptLanguage: "hi",
            outputTypes: ["short_notes"],
            checkOnly: true,
          }
        : {
            sourceType: "pdf",
            outputTypes: [
              "detailed_notes",
              "short_notes",
              "flashcards",
              "mcq_quiz",
              "mindmap",
              "sample_question_paper",
            ],
            checkOnly: true,
          },
    ),
  );
  if (!youtube)
    preflight.append(
      "file",
      new Blob([
        await readFile(
          fileURLToPath(
            new URL("../../backend/.cache/live-workflow/transactions.pdf", import.meta.url),
          ),
        ),
      ]),
      "transactions.pdf",
    );
  const checked = await fetch(`${api}/workspace/process`, { method: "POST", body: preflight });
  const finalEvent = (await checked.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .at(-1);
  assert.equal(
    finalEvent?.result?.status,
    "ready",
    "Generate the fixture once through the backend live tool first; browser verification does not generate missing outputs",
  );
  assert.ok(finalEvent.result.materials.every((material) => material.cached));
  if (process.env.LIVE_API_URL) {
    const api = process.env.LIVE_API_URL;
    if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+\/api\/v1$/.test(api))
      throw new Error("Only a local API is allowed");
    await page.route("**/api/v1/workspace/**", (route) =>
      route.continue({ url: api + new URL(route.request().url()).pathname.replace("/api/v1", "") }),
    );
  }
  if (youtube) {
    await page.goto("http://localhost:5173/assistant?source=youtube");
    await page
      .getByRole("textbox", { name: "YouTube URL", exact: true })
      .fill("https://www.youtube.com/watch?v=iJC87bWWuPM");
    await page.getByLabel("Caption language").selectOption("hi");
    for (const box of await page.getByRole("checkbox").all()) await box.uncheck();
    await page.getByRole("checkbox", { name: "Short notes", exact: true }).check();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page
      .getByRole("button", { name: "Export PDF", exact: true })
      .waitFor({ timeout: 180000 });
    const material = page.locator('[aria-label="Generated study material"]');
    assert.equal(await material.locator(".study-notebook").count(), 1);
    assert.match(await material.textContent(), /Reused from cache/);
    await page.screenshot({ path: directory + "real-youtube-hi.png", fullPage: true });
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 65000 }),
      page.getByRole("button", { name: "Export PDF", exact: true }).click(),
    ]);
    await download.saveAs(directory + "real-youtube-hi.pdf");
    assert.deepEqual(errors, []);
    console.log(
      "PASS: actual YouTube URL → persisted Hindi captions → real Gemini notes → cached notebook rendering → downloaded PDF.",
    );
  } else {
    await page.goto("http://localhost:5173/assistant?source=pdf");
    await page
      .getByLabel("Select PDF file")
      .setInputFiles(
        fileURLToPath(
          new URL("../../backend/.cache/live-workflow/transactions.pdf", import.meta.url),
        ),
      );
    for (const name of ["Detailed notes", "Short notes", "Mind maps", "Sample question papers"])
      await page.getByRole("checkbox", { name, exact: true }).check();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page
      .getByRole("button", { name: "Export PDF", exact: true })
      .waitFor({ timeout: 180000 });
    const materials = page.locator('[aria-label="Generated study material"]');
    assert.equal(await materials.locator(".study-notebook").count(), 4);
    assert.equal(
      (await materials.textContent()).match(/Reused from cache/g)?.length,
      4,
      "No duplicate paid requests for the same fixture",
    );
    assert.match(await materials.textContent(), /Atomicity|atomicity/);
    await page.screenshot({ path: directory + "real-notebooks.png", fullPage: true });
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 65000 }),
      page.getByRole("button", { name: "Export PDF", exact: true }).click(),
    ]);
    await download.saveAs(directory + "real-notebooks.pdf");
    await writeFile(
      directory + "verification.json",
      JSON.stringify(
        {
          realProviderResults: true,
          materials: 4,
          allCached: true,
          exportedPdf: "real-notebooks.pdf",
          uncaughtErrors: errors,
        },
        null,
        2,
      ),
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: actual local UI renders the four available persisted Gemini outputs; cached replay and combined PDF download succeed.",
    );
  }
} finally {
  await browser.close();
}
