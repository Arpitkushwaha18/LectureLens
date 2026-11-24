import { useState, useRef } from "react";
import { Button } from "@/components/ui/Button";
import { Notebook, NotebookBlockView } from "@/features/notebook/Notebook";
import { MindMapView } from "./MindMapView";
import { type ResourceContent } from "@lecturelens/contracts";
function FlashcardDeck({ content }: { content: Extract<ResourceContent, { type: "flashcards" }> }) {
  const [order, setOrder] = useState(() => content.cards.map((_, i) => i)),
    [index, setIndex] = useState(0),
    [flipped, setFlipped] = useState(false),
    [marks, setMarks] = useState<Record<string, "known" | "revision">>({}),
    touch = useRef<number | null>(null);
  const card = content.cards[order[index]!]!;
  function move(delta: number) {
    setIndex((i) => Math.max(0, Math.min(order.length - 1, i + delta)));
    setFlipped(false);
  }
  function shuffle() {
    const next = [...order];
    for (let i = next.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [next[i], next[j]] = [next[j]!, next[i]!];
    }
    setOrder(next);
    setIndex(0);
    setFlipped(false);
  }
  return (
    <section className="flashcard-deck" aria-label="Flashcard deck">
      <header className="experience-heading">
        <p className="label-caps">A little recall goes a long way</p>
        <h2>{content.title}</h2>
        <p>
          Card {index + 1} of {order.length} ·{" "}
          {Object.values(marks).filter((v) => v === "known").length} known
        </p>
      </header>
      <button
        type="button"
        className={`study-flashcard ${flipped ? "flipped" : ""}`}
        onClick={() => setFlipped(!flipped)}
        aria-label={flipped ? "Flip card to question" : "Flip card to answer"}
        onTouchStart={(e) => (touch.current = e.touches[0]?.clientX ?? null)}
        onTouchEnd={(e) => {
          if (touch.current !== null) {
            const distance = (e.changedTouches[0]?.clientX ?? touch.current) - touch.current;
            if (Math.abs(distance) > 60) move(distance < 0 ? 1 : -1);
            touch.current = null;
          }
        }}
      >
        <span className="flashcard-corner" aria-hidden="true">
          ✦
        </span>
        <span className="label-caps">{flipped ? "The answer" : "Think about it…"}</span>
        <span className="flashcard-copy">{flipped ? card.answer : card.question}</span>
        <span className="text-xs">Tap to {flipped ? "see the question" : "reveal the answer"}</span>
      </button>
      <div className="activity-controls">
        <Button variant="secondary" onClick={() => move(-1)} disabled={index === 0}>
          Previous card
        </Button>
        <Button variant="ghost" onClick={shuffle}>
          Shuffle
        </Button>
        <Button variant="secondary" onClick={() => move(1)} disabled={index === order.length - 1}>
          Next card
        </Button>
      </div>
      <div className="activity-controls">
        <Button
          variant="ghost"
          aria-pressed={marks[card.id] === "revision"}
          onClick={() => setMarks((v) => ({ ...v, [card.id]: "revision" }))}
        >
          Needs revision
        </Button>
        <Button
          aria-pressed={marks[card.id] === "known"}
          onClick={() => setMarks((v) => ({ ...v, [card.id]: "known" }))}
        >
          I know this
        </Button>
      </div>
      <p className="text-xs text-ink-muted">
        Swipe left/right on mobile. Your review marks stay in this tab.
      </p>
    </section>
  );
}
function QuizActivity({
  content,
}: {
  content: Extract<ResourceContent, { type: "mcq_quiz" }>;
  resourceId?: string;
}) {
  const [index, setIndex] = useState(0),
    [answers, setAnswers] = useState<(number | null)[]>(() => content.questions.map(() => null)),
    [submitted, setSubmitted] = useState(false);
  const question = content.questions[index]!,
    total = content.questions.reduce((sum, q) => sum + q.marks, 0),
    score = content.questions.reduce(
      (sum, q, i) => sum + (answers[i] === q.answerIndex ? q.marks : 0),
      0,
    );
  function submit() {
    setSubmitted(true);
  }
  function retry() {
    setAnswers(content.questions.map(() => null));
    setIndex(0);
    setSubmitted(false);
  }
  return (
    <section className="quiz-activity" aria-label="Interactive quiz">
      <header className="experience-heading">
        <p className="label-caps">A small challenge. A stronger memory.</p>
        <h2>{content.title}</h2>
        <p>
          {submitted ? "Your quiz results" : `Question ${index + 1} of ${content.questions.length}`}{" "}
          · {total} marks
        </p>
      </header>
      <nav className="question-navigation" aria-label="Quiz questions">
        {content.questions.map((q, i) => (
          <button
            type="button"
            key={q.id}
            aria-label={`Question ${i + 1}`}
            aria-current={index === i ? "step" : undefined}
            className={answers[i] !== null ? "answered" : ""}
            onClick={() => setIndex(i)}
          >
            {i + 1}
          </button>
        ))}
      </nav>
      {submitted ? (
        <div className="quiz-result" role="status">
          <h3>
            {score} / {total} marks · {Math.round((100 * score) / total)}%
          </h3>
          <p>
            {score === total
              ? "Wonderful work — every answer is correct!"
              : "Every question is a chance to learn. Review your answers below."}
          </p>
          <Button onClick={retry}>Retry quiz</Button>
        </div>
      ) : null}
      <fieldset className="quiz-question" disabled={submitted}>
        <legend>
          {index + 1}. {question.question}{" "}
          <small>
            ({question.marks} mark{question.marks === 1 ? "" : "s"})
          </small>
        </legend>
        {question.options.map((option, i) => (
          <label
            key={i}
            className={`quiz-option ${answers[index] === i ? "selected" : ""} ${submitted && question.answerIndex === i ? "correct" : ""} ${submitted && answers[index] === i && i !== question.answerIndex ? "incorrect" : ""}`}
          >
            <input
              type="radio"
              name={`quiz-${question.id}`}
              checked={answers[index] === i}
              onChange={() => setAnswers((v) => v.map((a, j) => (j === index ? i : a)))}
            />
            <span className="option-letter">{String.fromCharCode(65 + i)}</span>
            <span>{option}</span>
          </label>
        ))}
      </fieldset>
      {submitted ? (
        <div className="answer-explanation">
          <strong>
            {answers[index] === question.answerIndex ? "Correct answer" : "Let’s revise this one"}
          </strong>
          <p>Correct: {question.options[question.answerIndex]}</p>
          <p>{question.explanation}</p>
        </div>
      ) : null}
      <div className="activity-controls">
        <Button variant="secondary" disabled={index === 0} onClick={() => setIndex((i) => i - 1)}>
          Previous question
        </Button>
        <span>{answers.filter((a) => a !== null).length} answered</span>
        <Button
          variant="secondary"
          disabled={index === content.questions.length - 1}
          onClick={() => setIndex((i) => i + 1)}
        >
          Next question
        </Button>
      </div>
      {!submitted ? <Button onClick={submit}>Submit quiz</Button> : null}
      <p className="text-xs text-ink-muted">
        Your answers and marks stay on this page only. Retry any time to practise again.
      </p>
    </section>
  );
}
function SamplePaper({
  content,
}: {
  content: Extract<ResourceContent, { type: "sample_question_paper" }>;
}) {
  const [showAnswers, setShowAnswers] = useState(false);
  return (
    <article className="sample-paper">
      <header className="paper-heading">
        <p className="label-caps">LectureLens · AI-generated practice</p>
        <h2>{content.title}</h2>
        <p>
          Suggested time: {content.timeMinutes} minutes · Suggested marks:{" "}
          {content.sections.reduce((n, s) => n + s.questions.reduce((m, q) => m + q.marks, 0), 0)}
        </p>
        <strong>Sample paper — not verified PYQs or an official examination pattern.</strong>
      </header>
      <section>
        <h3>Instructions</h3>
        <ol>
          {content.instructions.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ol>
      </section>
      {content.sections.map((section, i) => (
        <section key={i}>
          <h3>{section.title}</h3>
          <ol>
            {section.questions.map((q, j) => (
              <li key={q.id}>
                <div className="paper-question">
                  <span>
                    {j + 1}. {q.text}
                  </span>
                  <strong>[{q.marks}]</strong>
                </div>
                <label className="sr-only" htmlFor={q.id}>
                  Your answer to {q.id}
                </label>
                <textarea id={q.id} rows={3} placeholder="Try your answer here…" />
              </li>
            ))}
          </ol>
        </section>
      ))}
      <p className="text-xs">
        Your written answers stay in this tab. They are not published or automatically graded.
      </p>
      <Button
        variant="secondary"
        aria-expanded={showAnswers}
        onClick={() => setShowAnswers(!showAnswers)}
      >
        {showAnswers ? "Hide answer guide" : "View answer guide"}
      </Button>
      {showAnswers ? (
        <section className="paper-answers">
          <h3>Answer guide</h3>
          {content.answers.map((block, i) => (
            <NotebookBlockView key={i} value={block} />
          ))}
        </section>
      ) : null}
    </article>
  );
}
export function ResourceExperience({
  content,
  sourceName,
  resourceId,
}: {
  content: ResourceContent;
  sourceName?: string;
  resourceId?: string;
}) {
  return (
    <div className={`resource-experience resource-${content.type}`}>
      {content.type === "detailed_notes" ? (
        <Notebook notebook={content.notebook} sourceName={sourceName} />
      ) : content.type === "short_notes" ? (
        <article className="revision-sheet">
          <header className="experience-heading">
            <p className="label-caps">The before-exam edition</p>
            <h2>{content.title}</h2>
            <p>Small points. Big connections. A quick revision companion.</p>
          </header>
          <div className="revision-points">
            {content.points.map((block, i) => (
              <section key={i} className={`revision-point revision-${block.type}`}>
                <NotebookBlockView value={block} />
              </section>
            ))}
          </div>
        </article>
      ) : content.type === "flashcards" ? (
        <FlashcardDeck key={JSON.stringify(content.cards)} content={content} />
      ) : content.type === "mcq_quiz" ? (
        <QuizActivity
          key={JSON.stringify(content.questions)}
          content={content}
          resourceId={resourceId}
        />
      ) : content.type === "mindmap" ? (
        <section className="mind-map-collection">
          <header className="experience-heading">
            <p className="label-caps">Connect the dots</p>
            <h2>{content.title}</h2>
          </header>
          {content.maps.map((map, i) => (
            <MindMapView key={i} map={map} />
          ))}
        </section>
      ) : (
        <SamplePaper content={content} />
      )}
      {content.type !== "detailed_notes" && content.limitations.length ? (
        <details className="mt-5 border-t border-rule pt-4 text-xs text-ink-soft">
          <summary>Source limitations and things to verify</summary>
          <ul className="mt-3 list-disc pl-5">
            {content.limitations.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
