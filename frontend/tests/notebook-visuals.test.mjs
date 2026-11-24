import assert from "node:assert/strict";
import { it } from "node:test";
import { formulaMarkup } from "../.cache/workspace-tests/features/notebook/math-format.js";
import {
  layoutNotebookGraph,
  wrapGraphLabel,
} from "../.cache/workspace-tests/features/notebook/graph-layout.js";

it("typesets fractions, roots, indices and sums as accessible native MathML", () => {
  for (const text of [
    String.raw`\frac{x^2}{\sqrt{y}}`,
    String.raw`$$\sum_{i=1}^{n} i$$`,
    "x_i = 2",
    "x = 2",
  ]) {
    const html = formulaMarkup(text);
    assert.match(html, /<math/);
    assert.doesNotMatch(html, /<script|style=|href=/);
  }
  assert.match(formulaMarkup(String.raw`\frac{a}{b}`), /<mfrac>/);
});
it("invalid or malicious LaTeX and ordinary prose fall back to escaped React text", () => {
  for (const text of [
    "Balance after transfer = balance before transfer − amount",
    String.raw`\badcommand{a}`,
    String.raw`\href{https://attacker.test}{x}`,
    String.raw`\htmlClass{evil}{x}`,
    "<img src=x onerror=alert(1)>",
  ])
    assert.equal(formulaMarkup(text), null);
});
it("graph layout routes relationships to node borders and preserves long labels", () => {
  const label =
    "A deliberately lengthy source concept label that must remain complete without truncation";
  assert.equal(wrapGraphLabel(label).join(" "), label);
  const graph = layoutNotebookGraph({
    type: "diagram",
    title: "Transactions",
    nodes: [
      { id: "a", label },
      { id: "b", label: "Commit" },
      { id: "c", label: "Rollback" },
    ],
    edges: [
      { from: "a", to: "b", label: "Success" },
      { from: "a", to: "c", label: "Failure" },
    ],
  });
  assert.ok(graph.width > 0 && graph.height > 0);
  assert.ok(graph.nodes[0].y < graph.nodes[1].y);
  for (const edge of graph.edges)
    for (const point of edge.points)
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
});
it("cycles, self-links, disconnected nodes and duplicate edges have finite layouts", () => {
  const graph = layoutNotebookGraph({
    type: "mindmap",
    title: "Cycle",
    nodes: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "Disconnected" },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "a" },
      { from: "a", to: "a" },
      { from: "a", to: "b", label: "Second relationship" },
    ],
  });
  for (const edge of graph.edges)
    for (const point of edge.points)
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
  assert.equal(graph.edges.length, 4);
});
