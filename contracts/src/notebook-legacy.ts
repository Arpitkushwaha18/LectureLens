import type { DetailedNotes } from "./notes.js";
import { notebookSchema, type NotebookBlock } from "./notebook.js";

/** Render existing validated notes without inventing any new AI content. */
export function legacyNotesToNotebook(notes: DetailedNotes) {
  const blocks: NotebookBlock[] = notes.blocks ?? [
    { type: "paragraph", text: notes.overview },
    ...notes.sections.flatMap((section) => [
      { type: "section" as const, text: section.heading },
      { type: "paragraph" as const, text: section.explanation },
      { type: "bullet_list" as const, items: section.keyPoints },
    ]),
    { type: "section", text: "Key takeaways" },
    { type: "bullet_list", items: notes.takeaways },
  ];
  return notebookSchema.parse({
    schemaVersion: 2,
    title: notes.title,
    blocks,
    limitations: notes.limitations,
  });
}
