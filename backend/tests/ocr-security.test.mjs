import { it } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { workbookImages } from "../dist/modules/extraction/xlsx-images.js";
import { validateDocumentUpload } from "../dist/modules/extraction/documents.js";
import { imageWorkbook } from "./helpers/ocr-fixtures.mjs";
it("upload validation accepts 20 MiB exactly and rejects one byte above", () => {
  assert.equal(
    validateDocumentUpload(Buffer.alloc(20 * 1024 * 1024), "boundary.pdf", "pdf"),
    "pdf",
  );
  assert.throws(
    () => validateDocumentUpload(Buffer.alloc(20 * 1024 * 1024 + 1), "too-large.pdf", "pdf"),
    /20 MB/,
  );
});
it("XLSX external image links never use network and unsupported associations are disclosed", async () => {
  const zip = await JSZip.loadAsync(await imageWorkbook()),
    path = "xl/drawings/_rels/drawing1.xml.rels";
  zip.file(
    path,
    (await zip.file(path).async("string")).replace(
      'Target="../media/image1.png"',
      'Target="https://127.0.0.1/private" TargetMode="External"',
    ),
  );
  const fetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("Network prohibited");
  };
  try {
    const result = await workbookImages(await zip.generateAsync({ type: "nodebuffer" }));
    assert.equal(result.images.length, 0);
    assert.match(result.warnings.join(" "), /unsupported|unassociated/);
    assert.match(result.warnings.join(" "), /never fetched/);
  } finally {
    globalThis.fetch = fetch;
  }
});
it("XLSX image XML disallows entities and archive path escapes", async () => {
  for (const attack of ["doctype", "path"]) {
    const zip = await JSZip.loadAsync(await imageWorkbook()),
      path = attack === "doctype" ? "xl/workbook.xml" : "xl/drawings/_rels/drawing1.xml.rels",
      xml = await zip.file(path).async("string");
    zip.file(
      path,
      attack === "doctype"
        ? '<!DOCTYPE workbook [<!ENTITY hidden SYSTEM "file:///etc/passwd">]>' + xml
        : xml.replace("../media/image1.png", "../../../private.png"),
    );
    await assert.rejects(
      workbookImages(await zip.generateAsync({ type: "nodebuffer" })),
      /document types|outside/,
    );
  }
});
