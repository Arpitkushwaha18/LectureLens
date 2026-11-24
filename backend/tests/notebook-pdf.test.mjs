import assert from "node:assert/strict";
import { it } from "node:test";
import { sanitizeNotebookHtml } from "../dist/services/notebook-pdf.service.js";
import { readFile } from "node:fs/promises";
import { pdfBrowserOptions } from "../dist/services/pdf-browser.js";

it("PDF builds carry notebook CSS and a local math font without needing frontend at runtime", async () => {
  const css = await readFile(new URL("../dist/assets/notebook.css", import.meta.url), "utf8");
  assert.match(css, /STIXTwoMath-Regular/);
  const font = await readFile(new URL("../dist/assets/STIXTwoMath-Regular.woff2", import.meta.url));
  assert.equal(font.subarray(0, 4).toString(), "wOF2");
  assert.equal(font.length, 551908);
  assert.match(css, /@media print/);
  const options = await pdfBrowserOptions();
  assert.equal(options.headless, true);
  if (process.platform === "linux") assert.ok(options.executablePath);
});
it("PDF sanitizer preserves math fractions and routed SVG arrows, not executable math", () => {
  const html = sanitizeNotebookHtml(
    '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block" onload="alert(1)"><semantics><mrow><mfrac><mi>a</mi><msqrt><mi>b</mi></msqrt></mfrac></mrow><annotation encoding="application/x-tex">a/b</annotation></semantics></math><svg viewBox="0 0 400 200"><path d="M0,0 L10,10" stroke-width="2" stroke-linejoin="round" marker-end="url(#arrow)"/><script>bad()</script></svg>',
  );
  assert.match(html, /<mfrac>/);
  assert.match(html, /<msqrt>/);
  assert.match(html, /marker-end="url\(#arrow\)"/);
  assert.match(html, /stroke-width="2"/);
  assert.doesNotMatch(html, /script|onload|bad\(\)/);
});
it("PDF exports contain notes, not transcript warnings or exam disclaimers", () => {
  const clean = sanitizeNotebookHtml(
    '<article class="study-notebook"><h1>Sets</h1><p>A set ignores repeated entries; its cardinality counts distinct elements.</p></article><section class="notebook-limitations"><h2>Keep in mind</h2><ul><li>The transcript treats repeated entries as invalid.</li></ul></section><p class="notebook-disclaimer">Claims about past examination questions and guaranteed future questions</p><details class="source-review"><summary>Garbled symbols</summary><p>Source correction</p></details>',
  );
  assert.match(clean, /cardinality counts distinct elements/);
  assert.doesNotMatch(clean, /Keep in mind|transcript|guaranteed future|Source correction|Garbled/);
});
it("PDF rendering strips executable markup, remote resources and user styles while preserving notebook diagrams", () => {
  const clean = sanitizeNotebookHtml(
    '<section class="material-section"><h1>Notebook</h1><script>fetch("https://attacker.test")</script><img src="http://127.0.0.1:4000"><iframe src="file:///etc/passwd"></iframe><style>body{display:none}</style><p onclick="alert(1)" style="background:url(https://attacker.test)">Atomicity</p><svg viewBox="0 0 400 200" onload="alert(1)"><line x1="1" y1="2" x2="3" y2="4" marker-end="url(#arrow)"/><text x="10" y="20">Commit</text><foreignObject><iframe src="https://attacker.test"></iframe></foreignObject></svg><details><summary>Question</summary><p>Answer</p></details></section>',
  );
  assert.match(clean, /Atomicity/);
  assert.match(clean, /viewBox="0 0 400 200"/);
  assert.match(clean, /marker-end="url\(#arrow\)"/);
  assert.match(clean, /Answer/);
  assert.doesNotMatch(clean, /script|iframe|foreignObject|attacker|src=|onload|onclick|style=/);
});
