import { useId, useState } from "react";
import {
  notebookBlockSchema,
  type Notebook as NotebookData,
  type NotebookBlock,
} from "@lecturelens/contracts";

function Graph({ block }: { block: Extract<NotebookBlock, { type: "diagram" | "mindmap" }> }) {
  const id = useId().replaceAll(":", "");
  const cols = block.nodes.length > 6 ? 3 : 2;
  const positions = block.nodes.map((node, i) => ({
    ...node,
    x: 40 + (i % cols) * (720 / cols),
    y: 25 + Math.floor(i / cols) * 135,
  }));
  const height = Math.ceil(block.nodes.length / cols) * 135 + 25;
  const wrap = (text: string) => text.match(/.{1,25}(?:\s|$)|.{1,25}/g)?.slice(0, 5) ?? [text];
  return (
    <figure className="notebook-graph">
      <figcaption>{block.title}</figcaption>
      <svg role="img" aria-label={block.title} viewBox={`0 0 800 ${height}`}>
        <defs>
          <marker
            id={`arrow-${id}`}
            markerWidth="8"
            markerHeight="8"
            refX="7"
            refY="3"
            orient="auto"
          >
            <path d="M0,0 L0,6 L8,3 z" fill="#58748f" />
          </marker>
        </defs>
        {block.edges.map((edge, i) => {
          const from = positions.find((node) => node.id === edge.from),
            to = positions.find((node) => node.id === edge.to);
          if (!from || !to) return null;
          const x1 = from.x + 105,
            y1 = from.y + 50,
            x2 = to.x + 105,
            y2 = to.y + 50;
          return (
            <g key={i}>
              <line
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="#58748f"
                strokeWidth="2"
                markerEnd={`url(#arrow-${id})`}
              />
              {edge.label ? (
                <text
                  x={(x1 + x2) / 2}
                  y={(y1 + y2) / 2 - 8}
                  textAnchor="middle"
                  fontSize="13"
                  paintOrder="stroke"
                  stroke="#fff9e9"
                  strokeWidth="5"
                  fill="#2b4a6f"
                >
                  {edge.label}
                </text>
              ) : null}
            </g>
          );
        })}
        {positions.map((node) => (
          <g key={node.id}>
            <rect
              x={node.x}
              y={node.y}
              width="210"
              height="100"
              rx="5"
              fill="#fff6c8"
              stroke="#b9aa6e"
            />
            <text x={node.x + 105} y={node.y + 22} textAnchor="middle" fontSize="17" fill="#1c2733">
              {wrap(node.label).map((line, i) => (
                <tspan key={i} x={node.x + 105} dy={i ? 17 : 0}>
                  {line.trim()}
                </tspan>
              ))}
            </text>
          </g>
        ))}
      </svg>
    </figure>
  );
}
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
      return (
        <p className="notebook-formula">
          <span>Formula</span>
          {block.text}
        </p>
      );
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
      return <Graph block={block} />;
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
}: {
  notebook: NotebookData;
  sourceName?: string;
}) {
  const blocks = notebook.blocks.filter((block) => {
    if ("text" in block) return Boolean(block.text.replace(/[\s\u200B\u2060\uFEFF]/g, ""));
    return true;
  });
  return (
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
      {notebook.limitations.length ? (
        <section className="notebook-limitations">
          <h2>Keep in mind</h2>
          <ul>
            {notebook.limitations.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <p className="notebook-disclaimer">
        AI learning assistance · verify important facts against your source. Not actual
        previous-year questions.
      </p>
    </article>
  );
}
