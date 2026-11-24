import { useState } from "react";
import { Formula } from "./Formula";
import { NotebookGraph } from "./NotebookGraph";
import {
  notebookBlockSchema,
  type Notebook as NotebookData,
  type NotebookBlock,
} from "@lecturelens/contracts";

function Quiz({ block }: { block: Extract<NotebookBlock, { type: "quiz" }> }) {
  const [choice, setChoice] = useState<number | null>(null);
  return (
    <section className="notebook-quiz">
      <p className="font-semibold">{block.question}</p>
      <ol>
        {block.options.map((option, i) => (
          <li key={i}>
            <button
              type="button"
              aria-pressed={choice === i}
              onClick={() => setChoice(i)}
              className={choice === i ? "quiz-choice selected" : "quiz-choice"}
            >
              {String.fromCharCode(65 + i)}. {option}
            </button>
          </li>
        ))}
      </ol>
      {choice !== null ? (
        <p role="status">
          {choice === block.answerIndex ? "Correct." : "Not quite."} {block.explanation}
        </p>
      ) : null}
      <p className="print-answer">
        Answer: {String.fromCharCode(65 + block.answerIndex)}. {block.options[block.answerIndex]}.{" "}
        {block.explanation}
      </p>
    </section>
  );
}
export function NotebookBlockView({ value }: { value: unknown }) {
  const parsed = notebookBlockSchema.safeParse(value);
  if (!parsed.success)
    return (
      <p className="notebook-unsupported" role="note">
        This block could not be displayed safely. The rest of your notes are available.
      </p>
    );
  const block = parsed.data;
  switch (block.type) {
    case "title":
      return <h2 className="notebook-chapter">{block.text}</h2>;
    case "section":
      return <h2 className="notebook-section">{block.text}</h2>;
    case "paragraph":
      return <p>{block.text}</p>;
    case "bullet_list":
      return (
        <ul>
          {block.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      );
    case "numbered_list":
      return (
        <ol>
          {block.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ol>
      );
    case "definition":
      return (
        <aside className="notebook-sticky">
          <h3>{block.term}</h3>
          <p>{block.text}</p>
        </aside>
      );
    case "formula":
      return <Formula text={block.text} />;
    case "important":
    case "exam_tip":
    case "example":
    case "summary":
      return (
        <aside className={`notebook-callout notebook-${block.type}`}>
          <h3>
            {
              {
                important: "Remember",
                exam_tip: "Exam tip",
                example: "Worked example",
                summary: "In a nutshell",
              }[block.type]
            }
          </h3>
          <p>{block.text}</p>
        </aside>
      );
    case "table":
      return (
        <figure className="notebook-table">
          <figcaption>{block.caption}</figcaption>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {block.headers.map((header, i) => (
                    <th key={i}>{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </figure>
      );
    case "diagram":
    case "mindmap":
      return <NotebookGraph block={block} />;
    case "flashcard":
      return (
        <div className="notebook-flashcard">
          <details>
            <summary>{block.question}</summary>
            <p>{block.answer}</p>
          </details>
          <p className="print-answer">{block.answer}</p>
        </div>
      );
    case "quiz":
      return <Quiz block={block} />;
    default:
      return <p>Unsupported notebook block.</p>;
  }
}
export function Notebook({
  notebook,
  sourceName,
  notesOnly = false,
}: {
  notebook: NotebookData;
  sourceName?: string;
  notesOnly?: boolean;
}) {
  const blocks = notebook.blocks.filter((block) => {
    if ("text" in block) return Boolean(block.text.replace(/[\s\u200B\u2060\uFEFF]/g, ""));
    return true;
  });
  return (
    <>
      <article className="study-notebook" aria-label={notebook.title}>
        <header className="notebook-heading">
          <p className="notebook-kicker">LectureLens · study notebook</p>
          <h1>{notebook.title}</h1>
          {sourceName ? <p className="notebook-source">Based on: {sourceName}</p> : null}
        </header>
        <div className="notebook-content">
          {blocks.map((block, i) => (
            <div key={i} className="notebook-block" data-block-type={block.type}>
              <NotebookBlockView value={block} />
            </div>
          ))}
        </div>
      </article>
      {!notesOnly && notebook.limitations.length ? (
        <details className="notebook-limitations">
          <summary>Source checks · not included in your PDF</summary>
          <ul>
            {notebook.limitations.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}
