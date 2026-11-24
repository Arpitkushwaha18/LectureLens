import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { chromium, type Browser } from "playwright";
import sanitizeHtml from "sanitize-html";
import { BACKEND_ROOT } from "../config/load-env.js";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { pdfBrowserOptions } from "./pdf-browser.js";
const require = createRequire(import.meta.url);
let css: Promise<string> | undefined;
export async function notebookCss() {
  let value = (
    await readFile(
      resolve(
        BACKEND_ROOT,
        import.meta.url.endsWith(".ts")
          ? "../frontend/src/features/notebook/notebook.css"
          : "dist/assets/notebook.css",
      ),
      "utf8",
    )
  ).replace(/^@import[^;]+;/gm, "");
  const mathFont = await readFile(
    resolve(
      BACKEND_ROOT,
      import.meta.url.endsWith(".ts")
        ? "../frontend/src/features/notebook/fonts/STIXTwoMath-Regular.woff2"
        : "dist/assets/STIXTwoMath-Regular.woff2",
    ),
  );
  value = value.replace(
    /url\(["']?\.\/fonts\/STIXTwoMath-Regular\.woff2["']?\)/g,
    `url(data:font/woff2;base64,${mathFont.toString("base64")})`,
  );
  const fontSheets = [
    "@fontsource-variable/inter/index.css",
    "@fontsource-variable/fraunces/index.css",
  ];
  for (const sheet of fontSheets) {
    const path = require.resolve(sheet);
    let font = await readFile(path, "utf8");
    const urls = [...font.matchAll(/url\(([^)]+)\)/g)];
    for (const match of urls) {
      const file = match[1]!.replace(/["']/g, "");
      const bytes = await readFile(resolve(dirname(path), file));
      font = font.replace(
        match[0],
        `url(data:font/${file.endsWith("woff2") ? "woff2" : "woff"};base64,${bytes.toString("base64")})`,
      );
    }
    value = font + "\n" + value;
  }
  return value;
}
export function sanitizeNotebookHtml(html: string) {
  return sanitizeHtml(html, {
    // Source diagnostics remain available on screen, never inside exported notes.
    exclusiveFilter: (frame) =>
      (frame.attribs.class ?? "")
        .split(/\s+/)
        .some((name) =>
          ["notebook-limitations", "notebook-disclaimer", "source-review"].includes(name),
        ),
    allowedTags: [
      "section",
      "article",
      "div",
      "header",
      "footer",
      "h1",
      "h2",
      "h3",
      "p",
      "span",
      "strong",
      "em",
      "small",
      "ul",
      "ol",
      "li",
      "figure",
      "figcaption",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "details",
      "summary",
      "svg",
      "g",
      "defs",
      "marker",
      "path",
      "rect",
      "circle",
      "line",
      "polygon",
      "text",
      "tspan",
      "br",
      "math",
      "semantics",
      "annotation",
      "mrow",
      "mi",
      "mo",
      "mn",
      "mtext",
      "mspace",
      "msup",
      "msub",
      "msubsup",
      "mfrac",
      "msqrt",
      "mroot",
      "mover",
      "munder",
      "munderover",
      "mtable",
      "mtr",
      "mtd",
      "mstyle",
      "mpadded",
      "mphantom",
      "menclose",
    ],
    allowedAttributes: {
      "*": ["class", "id"],
      math: ["xmlns", "display"],
      annotation: ["encoding"],
      mo: ["stretchy", "fence", "separator", "lspace", "rspace", "minsize", "maxsize"],
      mi: ["mathvariant"],
      mspace: ["width", "height", "depth"],
      mstyle: ["displaystyle", "scriptlevel", "mathvariant"],
      mtable: ["columnalign", "columnspacing", "rowspacing"],
      mtd: ["columnalign"],
      mpadded: ["width", "height", "depth", "lspace", "voffset"],
      menclose: ["notation"],
      svg: ["viewBox", "width", "height", "role", "aria-label"],
      g: ["transform"],
      marker: ["id", "markerWidth", "markerHeight", "refX", "refY", "orient", "viewBox"],
      path: [
        "d",
        "fill",
        "stroke",
        "stroke-width",
        "marker-end",
        "stroke-linejoin",
        "stroke-linecap",
      ],
      line: ["x1", "x2", "y1", "y2", "stroke", "marker-end"],
      rect: ["x", "y", "width", "height", "rx", "fill", "stroke"],
      circle: ["cx", "cy", "r", "fill", "stroke"],
      polygon: ["points", "fill", "stroke"],
      text: [
        "x",
        "y",
        "text-anchor",
        "dominant-baseline",
        "fill",
        "font-size",
        "stroke",
        "stroke-width",
        "paint-order",
      ],
      tspan: ["x", "dy"],
    },
    parser: { lowerCaseAttributeNames: false, lowerCaseTags: false },
    transformTags: { button: "span" },
  });
}
let active = false;
export async function generateNotebookPdf(html: string) {
  if (active)
    throw new AppError("Another PDF is being prepared. Try again shortly.", {
      code: "PDF_BUSY",
      statusCode: 429,
    });
  active = true;
  let browser: Browser | undefined;
  const deadline = setTimeout(() => void browser?.close(), 45000);
  deadline.unref();
  let stage = "assets";
  try {
    css ??= notebookCss().catch((error) => {
      css = undefined;
      throw error;
    });
    const styles = await css;
    stage = "browser";
    browser = await chromium.launch({ ...(await pdfBrowserOptions()), timeout: 30000 });
    stage = "render";
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block" });
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    await page.emulateMedia({ media: "print" });
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:"><style>*{box-sizing:border-box}#notebook-print-root :where(h1,h2,h3,p,figure,ul,ol){margin:0}${styles}</style></head><body><div id="notebook-print-root">${sanitizeNotebookHtml(html)}</div></body></html>`,
      { waitUntil: "load", timeout: 30000 },
    );
    await page.evaluate("document.fonts.ready");
    return await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
  } catch (error) {
    if (error instanceof AppError) throw error;
    // Do not log submitted HTML, provider data or filesystem/error messages.
    logger.error({ stage }, "PDF export preparation failed");
    throw new AppError(
      "The server could not prepare the PDF. Retry, or use Print / Save as PDF while the server runtime is checked.",
      { code: "PDF_EXPORT_FAILED", statusCode: 503 },
    );
  } finally {
    clearTimeout(deadline);
    try {
      await browser?.close();
    } finally {
      active = false;
    }
  }
}
