import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { parentPort } from "node:worker_threads";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { BACKEND_ROOT } from "../../config/load-env.js";
export const ocrError = (message: string) =>
  Object.assign(new Error(message), { name: "DocumentInputError" });
type Result = { text: string; confidence: number };
type Metric = { phase: string; ms: number; rss: number };
const metric = (value: Metric) => parentPort?.postMessage({ metric: value });
/** One native engine per document, sequential/bounded and deduplicated; never shared between users. */
export class OcrSession {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private pending?: { id: number; resolve: (r: Result) => void; reject: (e: Error) => void };
  private cache = new Map<string, string>();
  private sequence = 0;
  private stopped = false;
  private closing: Promise<void> = Promise.resolve();
  readonly diagnostics = { workerStarts: 0, recognitions: 0, cacheHits: 0, liveProcesses: 0 };
  private async initialize() {
    if (this.ready) return this.ready;
    this.stopped = false;
    this.ready = new Promise<void>((resolve, reject) => {
      const directory =
        process.env.OCR_TESSDATA_DIR ||
        (existsSync(join(BACKEND_ROOT, ".cache/tessdata/eng.traineddata"))
          ? join(BACKEND_ROOT, ".cache/tessdata")
          : "");
      const child = (this.child = spawn(
        process.execPath,
        [fileURLToPath(new URL("../../../scripts/ocr-engine.mjs", import.meta.url))],
        {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            PATH: process.env.PATH,
            OCR_LANGUAGES: process.env.OCR_LANGUAGES || "eng+hin",
            OCR_TESSDATA_DIR: directory,
            OCR_TESSERACT_LIBRARY: process.env.OCR_TESSERACT_LIBRARY,
          },
        },
      ));
      this.diagnostics.workerStarts++;
      this.diagnostics.liveProcesses++;
      if (child.pid) parentPort?.postMessage({ ocrPid: child.pid, active: true });
      const timer = setTimeout(() => {
        reject(ocrError("OCR engine initialization timed out."));
        this.close();
      }, 10000);
      child.stdin.on("error", () => {});
      child.stderr.resume();
      createInterface({ input: child.stdout }).on("line", (line) => {
        if (line.length > 1000000) {
          this.close();
          return;
        }
        try {
          const value = JSON.parse(line);
          if (value.metric) metric(value.metric);
          if (value.ready) {
            clearTimeout(timer);
            resolve();
          } else if (!value.id && value.error) {
            clearTimeout(timer);
            reject(ocrError(value.error));
          } else if (this.pending && this.pending.id === value.id) {
            const pending = this.pending;
            this.pending = undefined;
            if (value.error) pending.reject(ocrError(value.error));
            else pending.resolve({ text: value.text, confidence: value.confidence });
          }
        } catch {
          this.close();
        }
      });
      child.on("error", () => {
        clearTimeout(timer);
        reject(ocrError("OCR engine could not start."));
        this.close();
      });
      child.on("close", () => {
        this.diagnostics.liveProcesses--;
        clearTimeout(timer);
        if (child.pid) parentPort?.postMessage({ ocrPid: child.pid, active: false });
        reject(ocrError("OCR engine closed before initialization."));
        this.pending?.reject(ocrError("OCR engine stopped before the page completed."));
        this.pending = undefined;
        if (this.child === child) {
          this.child = undefined;
          this.ready = undefined;
        }
      });
    });
    return this.ready;
  }
  close() {
    this.stopped = true;
    this.pending?.reject(ocrError("OCR cancelled or page deadline exceeded."));
    this.pending = undefined;
    const child = this.child;
    const done = child
      ? new Promise<void>((resolve) => child.once("close", () => resolve()))
      : this.closing;
    this.closing = done;
    child?.kill("SIGKILL");
    this.child = undefined;
    this.ready = undefined;
    this.cache.clear();
    return done;
  }
  private async recognize(
    bytes: Buffer,
    width: number,
    height: number,
    timeout: number,
  ): Promise<Result> {
    await this.initialize();
    if (this.stopped) throw ocrError("OCR cancelled.");
    return new Promise((resolve, reject) => {
      this.diagnostics.recognitions++;
      const id = ++this.sequence;
      this.pending = { id, resolve, reject };
      this.child!.stdin.write(
        JSON.stringify({
          id,
          data: bytes.toString("base64"),
          width,
          height,
          dpi: Number(process.env.OCR_DPI || 150),
          timeout,
        }) + "\n",
      );
    });
  }
  async image(bytes: Buffer, rotation = 0): Promise<string> {
    if (!this.child && !this.ready) this.stopped = false;
    const hash = createHash("sha256").update(bytes).update(String(rotation)).digest("hex");
    const cached = this.cache.get(hash);
    if (cached) {
      this.diagnostics.cacheHits++;
      metric({ phase: "ocr-cache-hit", ms: 0, rss: process.memoryUsage().rss });
      return cached;
    }
    const deadline = Date.now() + Number(process.env.OCR_PAGE_TIMEOUT_MS || 15000);
    const timer = setTimeout(() => this.close(), Math.max(1, deadline - Date.now()));
    try {
      const started = performance.now(),
        image = sharp(bytes, { limitInputPixels: 16000000, animated: false }),
        metadata = await image.metadata();
      if (
        !["png", "jpeg", "webp", "gif", "tiff"].includes(metadata.format || "") ||
        (metadata.pages || 1) > 1 ||
        !metadata.width ||
        !metadata.height ||
        metadata.width < 30 ||
        metadata.height < 15
      )
        throw ocrError(
          "Embedded image/scan format is unsupported, too large or unreadable. Use a readable PNG/JPEG.",
        );
      const base = await image
        .rotate()
        .flatten({ background: "white" })
        .resize({
          width: Math.min(1900, Math.max(metadata.width, 1200)),
          withoutEnlargement: false,
        })
        .greyscale()
        .normalise()
        .raw()
        .toBuffer({ resolveWithObject: true });
      metric({
        phase: "preprocess",
        ms: performance.now() - started,
        rss: process.memoryUsage().rss,
      });
      let best: Result = { text: "", confidence: 0 };
      for (const angle of [...new Set([rotation, 0, 90, 270, 180])]) {
        if (Date.now() >= deadline || this.stopped)
          throw ocrError("OCR page deadline exceeded. Retry with a smaller/sharper scan.");
        const rotated = angle
          ? await sharp(base.data, {
              raw: { width: base.info.width, height: base.info.height, channels: 1 },
            })
              .rotate(angle)
              .greyscale()
              .raw()
              .toBuffer({ resolveWithObject: true })
          : base;
        const result = await this.recognize(
          rotated.data,
          rotated.info.width,
          rotated.info.height,
          deadline - Date.now(),
        );
        if (result.confidence > best.confidence && result.text.replace(/\s/g, "").length >= 4)
          best = result;
        if (best.confidence >= 65 && best.text.replace(/\s/g, "").length >= 20) break;
      }
      if (best.confidence < 35 || best.text.replace(/\s/g, "").length < 4)
        throw ocrError(
          "OCR found no reliably readable text. Improve resolution/contrast or upload a text-based copy.",
        );
      const text = best.text.trim();
      this.cache.set(hash, text);
      return text;
    } catch (error) {
      if (error instanceof Error && error.name === "DocumentInputError") throw error;
      throw ocrError("Embedded image/scan is unsupported or could not be read.");
    } finally {
      clearTimeout(timer);
    }
  }
}
export async function ocrImage(bytes: Buffer): Promise<string> {
  const session = new OcrSession();
  try {
    return await session.image(bytes);
  } finally {
    await session.close();
  }
}
