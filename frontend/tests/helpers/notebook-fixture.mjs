// TEST ONLY. Never imported by production source or gallery.
export const notebookFixture = {
  schemaVersion: 2,
  title: "TEST FIXTURE — Database study notebook",
  limitations: ["Isolated mocked-provider browser test, not real generated lecture notes."],
  blocks: [
    { type: "title", text: "Database transactions" },
    { type: "section", text: "Core principles" },
    { type: "paragraph", text: "Atomicity means all changes succeed together or roll back." },
    { type: "bullet_list", items: ["Validate constraints", "Preserve committed data"] },
    {
      type: "numbered_list",
      items: ["Begin a transaction", "Write changes", "Commit or roll back"],
    },
    { type: "definition", term: "Atomicity", text: "A transaction is all or nothing." },
    { type: "example", text: "If a transfer fails, neither account is partially updated." },
    { type: "formula", text: "Balance after transfer = balance before transfer − amount" },
    { type: "important", text: "Never publish partial writes." },
    { type: "exam_tip", text: "Distinguish atomicity from isolation." },
    {
      type: "table",
      caption: "Comparison",
      headers: ["Property", "Meaning"],
      rows: [
        ["Atomicity", "All or nothing"],
        ["Consistency", "Valid constraints"],
      ],
    },
    {
      type: "diagram",
      title: "Transaction flow",
      nodes: [
        { id: "start", label: "Begin transaction" },
        { id: "end", label: "Commit changes" },
      ],
      edges: [{ from: "start", to: "end", label: "success" }],
    },
    {
      type: "mindmap",
      title: "ACID map",
      nodes: [
        { id: "acid", label: "ACID" },
        { id: "atomicity", label: "Atomicity" },
        { id: "consistency", label: "Consistency" },
      ],
      edges: [
        { from: "acid", to: "atomicity" },
        { from: "acid", to: "consistency" },
      ],
    },
    {
      type: "flashcard",
      question: "What does atomicity guarantee?",
      answer: "All changes happen or none do.",
    },
    {
      type: "quiz",
      question: "Which property guarantees all or nothing?",
      options: ["Atomicity", "Isolation"],
      answerIndex: 0,
      explanation: "Atomicity prevents partial commits.",
    },
    ...Array.from({ length: 18 }, (_, i) => ({
      type: "paragraph",
      text:
        `Extended section ${i + 1}. ` +
        "Transactions protect related database writes. Preserve constraints and verify committed results. ".repeat(
          4,
        ),
    })),
    {
      type: "summary",
      text: "FINAL SECTION: Atomicity, consistency, isolation and durability work together.",
    },
  ],
};
