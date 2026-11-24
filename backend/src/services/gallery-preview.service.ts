import { Worker } from "node:worker_threads";
import { AppError } from "../lib/errors.js";

let active = 0;
const waiting: (() => void)[] = [];
const unavailable = () =>
  new AppError("This PDF preview is unavailable. You can still open the original PDF.", {
    code: "GALLERY_PREVIEW_UNAVAILABLE",
    statusCode: 503,
  });

/** One 256 MB renderer and 24 queued previews, leaving room for the API on small hosts. */
export async function galleryPreview(load: () => Promise<Buffer>) {
  if (active >= 1) {
    if (waiting.length >= 24) throw unavailable();
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else active++;
  try {
    const bytes = await load();
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw unavailable();
    return await new Promise<Buffer>((resolve, reject) => {
      const worker = new Worker(
        new URL(
          import.meta.url.endsWith(".ts")
            ? "./gallery-preview.worker.ts"
            : "./gallery-preview.worker.js",
          import.meta.url,
        ),
        {
          workerData: { bytes },
          resourceLimits: { maxOldGenerationSizeMb: 256 },
          execArgv: import.meta.url.endsWith(".ts") ? ["--import", "tsx"] : [],
        },
      );
      let done = false;
      const finish = (image?: Uint8Array) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        void worker.terminate();
        if (image?.length && image.length <= 2_000_000) resolve(Buffer.from(image));
        else reject(unavailable());
      };
      const timer = setTimeout(() => finish(), 15000);
      worker.on("message", (message) => finish(message.image));
      worker.once("error", () => finish());
      worker.once("exit", () => {
        if (!done) finish();
      });
    });
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}
