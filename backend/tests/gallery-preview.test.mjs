import assert from "node:assert/strict";
import { it } from "node:test";
import { PDFDocument } from "pdf-lib";
import { galleryPreview } from "../dist/services/gallery-preview.service.js";
import { scanPdf } from "./helpers/document-visual-fixtures.mjs";

it("renders scanned PDF pages as images, without treating them as unreadable text", async () => {
  const image = await galleryPreview(async () => scanPdf());
  assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(image.readUInt32BE(16), 560);
  assert.ok(image.length > 5000);
});

it("rasterizes only a bounded first-page preview without OCR or AI", async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([600, 800]);
  pdf.addPage([800, 600]);
  const bytes = Buffer.from(await pdf.save());
  const image = await galleryPreview(async () => bytes);
  assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(image.readUInt32BE(16), 560);
  assert.ok(image.readUInt32BE(20) > image.readUInt32BE(16));
  await assert.rejects(
    () => galleryPreview(async () => Buffer.from("corrupt")),
    (error) => error.code === "GALLERY_PREVIEW_UNAVAILABLE",
  );
});
it("bounds gallery preview concurrency/queue and releases slots on load failures", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const jobs = Array.from({ length: 25 }, () =>
    galleryPreview(async () => {
      await gate;
      throw new Error("synthetic load error");
    }).catch(() => "rejected"),
  );
  await assert.rejects(
    () => galleryPreview(async () => Buffer.alloc(1)),
    (error) => error.code === "GALLERY_PREVIEW_UNAVAILABLE",
  );
  release();
  assert.deepEqual(await Promise.all(jobs), Array(25).fill("rejected"));
  await assert.rejects(
    () => galleryPreview(async () => Buffer.alloc(21 * 1024 * 1024)),
    (error) => error.code === "GALLERY_PREVIEW_UNAVAILABLE",
  );
});
