import { formulaMarkup } from "./math-format";

export function Formula({ text }: { text: string }) {
  const markup = formulaMarkup(text);
  return (
    <div className="notebook-formula">
      <span className="formula-label">Formula</span>
      {markup ? (
        <div className="formula-math" dangerouslySetInnerHTML={{ __html: markup }} />
      ) : (
        <p className="formula-text">{text}</p>
      )}
    </div>
  );
}
