// A document-scoped persistent native engine. Isolated process memory is reclaimed on kill.
import koffi from "koffi";
import { createInterface } from "node:readline";
const started = performance.now();
let library;
for (const path of [
  process.env.OCR_TESSERACT_LIBRARY,
  ...(process.platform === "darwin"
    ? ["/opt/homebrew/lib/libtesseract.dylib", "/usr/local/lib/libtesseract.dylib"]
    : ["libtesseract.so.5", "libtesseract.so"]),
].filter(Boolean)) {
  try {
    library = koffi.load(path);
    break;
  } catch {}
}
if (!library) {
  console.log(
    JSON.stringify({
      error:
        "Local Tesseract shared library is unavailable. Install Tesseract 5 (libtesseract5 on Linux).",
    }),
  );
  process.exit(1);
}
const create = library.func("void *TessBaseAPICreate()"),
  init = library.func("int TessBaseAPIInit3(void *api, const char *path, const char *lang)"),
  clear = library.func("void TessBaseAPIClear(void *api)"),
  remove = library.func("void TessBaseAPIDelete(void *api)"),
  end = library.func("void TessBaseAPIEnd(void *api)"),
  setImage = library.func(
    "void TessBaseAPISetImage(void *api,const uint8_t *bytes,int width,int height,int channels,int stride)",
  ),
  setDpi = library.func("void TessBaseAPISetSourceResolution(void *api,int dpi)"),
  setVariable = library.func(
    "bool TessBaseAPISetVariable(void *api,const char *name,const char *value)",
  ),
  setMode = library.func("void TessBaseAPISetPageSegMode(void *api,int mode)"),
  recognize = library.func("int TessBaseAPIRecognize(void *api,void *monitor)"),
  getText = library.func("void *TessBaseAPIGetUTF8Text(void *api)"),
  deleteText = library.func("void TessDeleteText(void *text)"),
  confidence = library.func("int TessBaseAPIMeanTextConf(void *api)"),
  monitorCreate = library.func("void *TessMonitorCreate()"),
  monitorDeadline = library.func("void TessMonitorSetDeadlineMSecs(void *monitor,int ms)"),
  monitorDelete = library.func("void TessMonitorDelete(void *monitor)");
const engine = create();
console.log(
  JSON.stringify({
    metric: {
      phase: "engine-library-load",
      ms: performance.now() - started,
      rss: process.memoryUsage().rss,
    },
  }),
);
const languageStarted = performance.now();
if (
  init(engine, process.env.OCR_TESSDATA_DIR || null, process.env.OCR_LANGUAGES || "eng+hin") !== 0
) {
  remove(engine);
  console.log(JSON.stringify({ error: "OCR language packs are missing. Run npm run ocr:setup." }));
  process.exit(1);
}
setMode(engine, 6);
console.log(
  JSON.stringify({
    metric: {
      phase: "language-load",
      ms: performance.now() - languageStarted,
      rss: process.memoryUsage().rss,
    },
  }),
);
setVariable(engine, "preserve_interword_spaces", "1");
console.log(
  JSON.stringify({
    ready: true,
    metric: {
      phase: "engine-init",
      ms: performance.now() - started,
      rss: process.memoryUsage().rss,
    },
  }),
);
try {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const start = performance.now();
    let input;
    try {
      input = JSON.parse(line);
      if (
        !Number.isInteger(input.width) ||
        !Number.isInteger(input.height) ||
        input.width * input.height > 16000000 ||
        input.width < 1 ||
        input.height < 1
      )
        throw new Error("Invalid pixels");
      const bytes = Buffer.from(input.data, "base64");
      if (bytes.length !== input.width * input.height) throw new Error("Invalid pixels");
      setImage(engine, bytes, input.width, input.height, 1, input.width);
      setDpi(engine, input.dpi);
      const monitor = monitorCreate();
      let result;
      try {
        monitorDeadline(monitor, Math.max(1, Math.min(60000, input.timeout)));
        result = recognize(engine, monitor);
      } finally {
        monitorDelete(monitor);
      }
      if (result !== 0) throw new Error("OCR page deadline exceeded or recognition failed");
      const pointer = getText(engine);
      let text = "";
      try {
        if (pointer) text = koffi.decode(pointer, "char", -1);
      } finally {
        if (pointer) deleteText(pointer);
      }
      console.log(
        JSON.stringify({
          id: input.id,
          text,
          confidence: confidence(engine),
          metric: {
            phase: "ocr-engine",
            ms: performance.now() - start,
            rss: process.memoryUsage().rss,
          },
        }),
      );
    } catch {
      console.log(
        JSON.stringify({
          id: input?.id,
          error: "OCR page timed out or could not be recognized.",
          metric: {
            phase: "ocr-engine",
            ms: performance.now() - start,
            rss: process.memoryUsage().rss,
          },
        }),
      );
    } finally {
      clear(engine);
    }
  }
} finally {
  end(engine);
  remove(engine);
}
