import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import {
  notebookSchema,
  notebookToResource,
  transcriptTextSchema,
  flashcardCountSchema,
  quizCountSchema,
  type Notebook,
  type GenerationOutputTypeV2,
} from "@lecturelens/contracts";
import { createHash } from "node:crypto";
import type { createGeminiStudyGenerator } from "./gemini-study.js";
import { NotesGenerationError } from "./gemini-notes.js";

export function chunkSource(
  text: string,
  tokenLimit: number,
  overlapTokens: number,
  maxChunks = 128,
) {
  if (
    !Number.isInteger(tokenLimit) ||
    tokenLimit < 10 ||
    !Number.isInteger(overlapTokens) ||
    overlapTokens < 0 ||
    overlapTokens >= tokenLimit ||
    maxChunks < 1
  )
    throw new NotesGenerationError(
      "AI_CONFIGURATION",
      "Invalid transcript chunk configuration.",
      false,
      503,
    );
  const chunks: { text: string; start: number; end: number; coreStart: number; tokens: number }[] =
    [];
  let coreStart = 0;
  while (coreStart < text.length) {
    if (chunks.length >= maxChunks)
      throw new NotesGenerationError(
        "AI_SOURCE_LIMIT",
        "This source exceeds the configured chunk limit. No transcript content was silently dropped.",
        false,
        422,
      );
    const previous = chunks.at(-1);
    let start = coreStart;
    if (previous && overlapTokens) {
      let low = previous.start,
        high = coreStart;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (countTokens(text.slice(mid, coreStart)) > overlapTokens) low = mid + 1;
        else high = mid;
      }
      start = low;
      if (/[\uDC00-\uDFFF]/.test(text[start] ?? "")) start++;
    }
    let low = coreStart + 1,
      high = Math.min(text.length, start + tokenLimit * 8);
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (Math.ceil(countTokens(text.slice(start, mid)) * 1.2) <= tokenLimit) low = mid;
      else high = mid - 1;
    }
    let end = low;
    if (end < text.length) {
      const boundary = text.lastIndexOf("\n", end);
      if (boundary > coreStart + (end - coreStart) * 0.7) end = boundary + 1;
      if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--;
    }
    if (end <= coreStart)
      throw new NotesGenerationError(
        "AI_SOURCE_LIMIT",
        "Chunk configuration cannot fit this source.",
        false,
        422,
      );
    chunks.push({
      text: text.slice(start, end),
      start,
      end,
      coreStart,
      tokens: Math.ceil(countTokens(text.slice(start, end)) * 1.2),
    });
    coreStart = end;
  }
  return chunks;
}

export function mergeNotebooks(
  notebooks: Notebook[],
  output: GenerationOutputTypeV2,
  itemCount?: number,
): Notebook {
  const blocks: Notebook["blocks"] = [],
    seen = new Set<string>();
  for (const notebook of notebooks)
    for (const original of notebook.title === notebooks[0]?.title
      ? notebook.blocks
      : [{ type: "section" as const, text: notebook.title }, ...notebook.blocks]) {
      // Chunk-local titles become topic headings; do not discard unique educational labels.
      const block: Notebook["blocks"][number] =
        original.type === "title" ? { type: "section", text: original.text } : original;
      const key = JSON.stringify(block);
      if (seen.has(key)) continue;
      seen.add(key);
      const previous = blocks.at(-1);
      if (
        previous?.type === "paragraph" &&
        block.type === "paragraph" &&
        previous.text.length + block.text.length + 2 <= 5000
      )
        previous.text += `\n\n${block.text}`;
      else blocks.push(structuredClone(block));
    }
  let selected = blocks;
  if (itemCount) {
    const type = output === "flashcards" ? "flashcard" : "quiz";
    const items = blocks.filter((block) => block.type === type);
    // Spread a bounded practice set across the source, never publish fewer than requested.
    if (items.length < itemCount)
      throw new NotesGenerationError(
        "AI_INVALID_OUTPUT",
        "The source did not yield enough distinct practice items. No duplicated questions were published.",
        false,
        502,
      );
    selected = Array.from(
      { length: itemCount },
      (_, index) => items[Math.floor((index * items.length) / itemCount)]!,
    ).filter(Boolean);
    if (selected.length !== itemCount)
      throw new NotesGenerationError(
        "AI_INVALID_OUTPUT",
        "The source did not yield the requested practice set.",
        false,
        502,
      );
  }
  const result = notebookSchema.safeParse({
    schemaVersion: 2,
    title: notebooks[0]?.title,
    blocks: selected,
    limitations: [...new Set(notebooks.flatMap((n) => n.limitations))],
  });
  if (!result.success)
    throw new NotesGenerationError(
      "AI_OUTPUT_LIMIT",
      "The complete material exceeds the current notebook format limits. Try a smaller source; no incomplete notes were published.",
      false,
      422,
    );
  notebookToResource(result.data, output);
  return result.data;
}

type Generator = ReturnType<typeof createGeminiStudyGenerator>;
export function createLongSourceGenerator(
  generate: Generator,
  options: { chunkTokens: number; overlapTokens: number; maxChunks: number; timeoutMs: number },
): Generator {
  return async (text, output, counts = {}) => {
    text = transcriptTextSchema.parse(text);
    const signal = counts.signal
      ? AbortSignal.any([counts.signal, AbortSignal.timeout(options.timeoutMs)])
      : AbortSignal.timeout(options.timeoutMs);
    // Original PDFs must remain complete file inputs; never OCR or substitute their text preview.
    if (counts.pdf) return generate(text, output, { ...counts, signal });
    const chunks = chunkSource(text, options.chunkTokens, options.overlapTokens, options.maxChunks);
    const results: Notebook[] = [];
    const completed = new Map<string, Notebook>(); // request-local only; released on return/error
    const total =
      output === "flashcards"
        ? flashcardCountSchema.parse(counts.flashcardCount)
        : output === "mcq_quiz"
          ? quizCountSchema.parse(counts.quizCount)
          : undefined;
    for (let index = 0; index < chunks.length; index++) {
      signal.throwIfAborted();
      counts.onChunkProgress?.(index, chunks.length);
      const chunk = chunks[index]!;
      const requested = total
        ? Math.max(1, Math.floor(total / chunks.length) + (index < total % chunks.length ? 1 : 0))
        : undefined;
      const key = createHash("sha256").update(chunk.text).update(String(requested)).digest("hex");
      let notebook = completed.get(key);
      if (!notebook) {
        notebook = notebookSchema.parse(
          await generate(chunk.text, output, {
            ...counts,
            signal,
            chunkItemCount: requested,
            chunkPosition: { index: index + 1, total: chunks.length },
          }),
        );
        completed.set(key, notebook);
      }
      results.push(notebook);
      counts.onChunkProgress?.(index + 1, chunks.length);
    }
    signal.throwIfAborted();
    if (chunks.length === 1) return results[0]!;
    return mergeNotebooks(results, output, total);
  };
}
