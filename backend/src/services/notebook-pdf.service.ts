import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { chromium, type Browser } from "playwright";
import sanitizeHtml from "sanitize-html";
import { BACKEND_ROOT } from "../config/load-env.js";
import { AppError } from "../lib/errors.js";
const require = createRequire(import.meta.url);
let css: Promise<string> | undefined;
async function notebookCss() {
  let value = (
    await readFile(resolve(BACKEND_ROOT, "../frontend/src/features/notebook/notebook.css"), "utf8")
  ).replace(/^@import[^;]+;/gm, "");
  for (const family of ["kalam", "caveat"])
    for (const weight of [400, 700]) {
      const path = require.resolve(`@fontsource/${family}/${weight}.css`);
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
    ],
    allowedAttributes: {
      "*": ["class", "id"],
      svg: ["viewBox", "width", "height", "role", "aria-label"],
      g: ["transform"],
      marker: ["id", "markerWidth", "markerHeight", "refX", "refY", "orient", "viewBox"],
      path: ["d", "fill", "stroke"],
      line: ["x1", "x2", "y1", "y2", "stroke", "marker-end"],
      rect: ["x", "y", "width", "height", "rx", "fill", "stroke"],
      circle: ["cx", "cy", "r", "fill", "stroke"],
      polygon: ["points", "fill", "stroke"],
      text: ["x", "y", "text-anchor", "dominant-baseline", "fill", "font-size"],
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
  try {
    css ??= notebookCss();
    const styles = await css;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block" });
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    await page.emulateMedia({ media: "print" });
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:"><style>body{--font-sans:Arial,sans-serif}*{box-sizing:border-box}${styles}</style></head><body><div id="notebook-print-root">${sanitizeNotebookHtml(html)}</div></body></html>`,
      { waitUntil: "load", timeout: 30000 },
    );
    await page.evaluate("document.fonts.ready");
    return await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "PDF preparation failed. Install the local Chromium browser with npx playwright install chromium, then retry.",
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
