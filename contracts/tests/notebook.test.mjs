import assert from "node:assert/strict";
import { it } from "node:test";
import { notebookSchema, workspaceEventSchema, legacyNotesToNotebook } from "../dist/index.js";
const notebook = {
  schemaVersion: 2,
  title: "Notebook contract fixture",
  blocks: [{ type: "paragraph", text: "Atomicity is all or nothing." }],
  limitations: [],
};
it("notebooks reject unknown blocks, extra fields, invalid graph/table/quiz references", () => {
  assert.deepEqual(notebookSchema.parse(notebook), notebook);
  for (const block of [
    { type: "html", text: "<script>" },
    { type: "paragraph", text: "Valid", html: "not allowed" },
    { type: "table", caption: "Table", headers: ["A", "B"], rows: [["A"]] },
    { type: "quiz", question: "Q", options: ["A", "B"], answerIndex: 2, explanation: "E" },
    {
      type: "mindmap",
      title: "M",
      nodes: [
        { id: "a", label: "A" },
        { id: "a", label: "B" },
      ],
      edges: [],
    },
  ])
    assert.equal(notebookSchema.safeParse({ ...notebook, blocks: [block] }).success, false);
});
it("workspace events reject fake percentages and invalid results", () => {
  assert.equal(
    workspaceEventSchema.safeParse({ event: "stage", stage: "generating", message: "Generating" })
      .success,
    true,
  );
  assert.equal(
    workspaceEventSchema.safeParse({
      event: "stage",
      stage: "generating",
      message: "Generating",
      percentage: 99,
    }).success,
    false,
  );
  assert.equal(
    workspaceEventSchema.safeParse({
      event: "result",
      result: {
        status: "ready",
        source: { kind: "pdf", name: "file.pdf", text: "Text", warnings: [] },
        materials: [{ outputType: "flashcards", cached: true, notebook }],
      },
    }).success,
    true,
  );
});
it("legacy conversion preserves actual text and limitations without fabricating graph content", () => {
  const value = legacyNotesToNotebook({
    schemaVersion: 1,
    title: "Actual title",
    overview: "Actual overview",
    sections: [{ heading: "Heading", explanation: "Explanation", keyPoints: ["Point"] }],
    takeaways: ["Takeaway"],
    limitations: ["Actual limitation"],
  });
  assert.ok(notebookSchema.safeParse(value).success);
  for (const text of ["Actual overview", "Heading", "Explanation", "Point", "Takeaway"])
    assert.ok(JSON.stringify(value).includes(text));
  assert.deepEqual(value.limitations, ["Actual limitation"]);
  assert.ok(value.blocks.every((block) => !["diagram", "mindmap", "quiz"].includes(block.type)));
});
