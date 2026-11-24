import katex from "katex";

export function formulaMarkup(value: string): string | null {
  let text = value.trim();
  for (const [open, close] of [
    ["$$", "$$"],
    ["$", "$"],
    ["\\(", "\\)"],
    ["\\[", "\\]"],
  ] as const) {
    if (text.startsWith(open) && text.endsWith(close)) {
      text = text.slice(open.length, -close.length).trim();
      break;
    }
  }
  // Preserve ordinary explanatory formulas verbatim instead of italicizing every word.
  if (/\\(?:href|url|includegraphics|html[A-Za-z]*)\b/.test(text)) return null;
  if (
    !/[\\^_{}]|^[\d\sA-Za-z+−*/=().<>≤≥-]+$/.test(text) ||
    (!/[\\^_{}]/.test(text) && /[A-Za-z]{3,}/.test(text))
  )
    return null;
  try {
    return katex.renderToString(text, {
      output: "mathml",
      displayMode: true,
      throwOnError: true,
      trust: false,
      strict: "error",
      maxExpand: 200,
      maxSize: 10,
    });
  } catch {
    return null;
  }
}
