// Opt-in, bounded LIVE verification. No Supabase or persistent user records.
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";
import { textPdf } from "../tests/helpers/documents.mjs";
import {
  askTemporaryTutor,
  processTemporaryWorkspace,
} from "../dist/services/temporary-workspace.service.js";
import { videoVerifier } from "../dist/services/video-verification.js";
if (!process.argv.includes("--live"))
  throw new Error("Use --live: selected checks may incur provider charges.");
let failed = false;
async function check(name, run) {
  const started = Date.now();
  try {
    console.log(
      JSON.stringify({ check: name, ok: true, ...(await run()), ms: Date.now() - started }),
    );
  } catch (error) {
    failed = true;
    console.log(
      JSON.stringify({
        check: name,
        ok: false,
        code: error.code ?? error.name,
        ms: Date.now() - started,
      }),
    );
  }
}
const options = { outputTypes: ["short_notes"] };
if (process.argv.includes("--ask"))
  await check("quick Gemini Ask", async () => {
    const r = await askTemporaryTutor({ prompt: "what is recursion", answerMode: "quick" });
    assert.equal(r.provider, "Gemini");
    assert.match(JSON.stringify(r.notebook), /recurs/i);
    assert.match(JSON.stringify(r.notebook), /base case|stop/i);
    return { provider: r.provider, blocks: r.notebook.blocks.length };
  });
if (process.argv.includes("--detailed"))
  await check("detailed FreeGG Ask", async () => {
    const r = await askTemporaryTutor({
      prompt: "Explain recursion in detail, with a worked factorial example and common mistakes.",
      answerMode: "detailed",
    });
    assert.equal(r.provider, "FreeGG");
    assert.match(JSON.stringify(r.notebook), /recurs/i);
    return { provider: r.provider, blocks: r.notebook.blocks.length };
  });
if (process.argv.includes("--pdf")) {
  await check("text PDF upload → FreeGG", async () => {
    const r = await processTemporaryWorkspace(
      { ...options, sourceType: "pdf" },
      { buffer: await textPdf(), originalname: "fixture.pdf" },
      () => {},
    );
    assert.equal(r.status, "ready");
    assert.match(JSON.stringify(r.materials), /atomicity|transaction/i);
    return { outputs: r.materials.length };
  });
  await check("image-only PDF forwarded directly → FreeGG semantic notes", async () => {
    const canvas = createCanvas(1500, 600),
      context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, 1500, 600);
    context.fillStyle = "black";
    context.font = "42px Arial";
    [
      "Fictional robotics exercise",
      "The Cedar robot has exactly 47 sensors.",
      "Its circuit label is ZETA-913.",
      "Each sensor measures temperature every 8 seconds.",
    ].forEach((line, i) => context.fillText(line, 40, 100 + i * 110));
    const pdf = await PDFDocument.create(),
      image = await pdf.embedPng(canvas.toBuffer("image/png"));
    pdf.addPage([595, 842]).drawImage(image, { x: 10, y: 450, width: 575, height: 230 });
    const r = await processTemporaryWorkspace(
      { ...options, sourceType: "pdf" },
      { buffer: Buffer.from(await pdf.save()), originalname: "visual-fixture.pdf" },
      () => {},
    );
    assert.equal(r.status, "ready");
    const content = JSON.stringify(r.materials);
    assert.match(content, /Cedar/i);
    assert.match(content, /47/);
    assert.match(content, /ZETA.?913/i);
    return { visualFactsVerified: true, localOcr: false };
  });
}
const url = process.argv.find((arg) => arg.startsWith("--youtube="))?.slice("--youtube=".length);
if (url)
  await check("YouTube validation + live captions + FreeGG notes", async () => {
    const verified = await videoVerifier.verify(url);
    const r = await processTemporaryWorkspace(
      { ...options, sourceType: "youtube", url, verificationToken: verified.verificationToken },
      undefined,
      () => {},
    );
    assert.equal(r.status, "ready");
    assert.equal(r.source.kind, "youtube");
    return { outputs: r.materials.length, persisted: false };
  });
if (failed) process.exitCode = 1;
