import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// Rasterize only the first page of an already-public admin PDF. No OCR, disk or AI.
const require = createRequire(import.meta.url);
async function render() {
  const task = getDocument({
    data: new Uint8Array(workerData.bytes),
    useWasm: false,
    useSystemFonts: true,
    verbosity: 0,
    standardFontDataUrl: join(
      dirname(require.resolve("pdfjs-dist/package.json")),
      "standard_fonts/",
    ),
  });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1),
      base = page.getViewport({ scale: 1 });
    if (!Number.isFinite(base.width * base.height) || base.width <= 0 || base.height <= 0)
      throw new Error("Invalid page");
    const scale = Math.min(560 / base.width, 1000 / base.height);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(
      Math.max(1, Math.ceil(viewport.width)),
      Math.max(1, Math.ceil(viewport.height)),
    );
    type RenderInput = Parameters<typeof page.render>[0];
    await page.render({
      canvas: canvas as unknown as RenderInput["canvas"],
      canvasContext: canvas.getContext("2d") as unknown as RenderInput["canvasContext"],
      viewport,
    }).promise;
    const image = canvas.toBuffer("image/png");
    if (image.length > 2_000_000) throw new Error("Preview too large");
    return image;
  } finally {
    await task.destroy();
  }
}
render()
  .then((image) => parentPort?.postMessage({ image }))
  .catch(() => parentPort?.postMessage({ error: true }));
