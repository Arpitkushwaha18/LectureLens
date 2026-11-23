import { transcriptTextSchema } from "@lecturelens/contracts";
// Split on paragraph/line boundaries without dropping, summarizing or duplicating
// source content. All segments go in ONE request when they fit the model context:
// no fragile multi-call map/reduce billing or lost chunk-completion checkpoints.
export function prepareGenerationSource(text: string) {
  const source = transcriptTextSchema.parse(text).replace(/\r\n?/g, "\n");
  const segments: string[] = [];
  let start = 0;
  while (start < source.length) {
    let end = Math.min(source.length, start + 12000);
    if (end < source.length) {
      const boundary = source.lastIndexOf("\n", end);
      if (boundary > start + 6000) end = boundary + 1;
      else {
        // Do not split a UTF-16 surrogate pair, including symbols in source tables.
        const code = source.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) end--;
      }
    }
    segments.push(source.slice(start, end));
    start = end;
  }
  return { source, segments };
}
export function generationBudget(length: number, detailed: boolean) {
  return {
    maxOutputTokens: detailed && length > 40000 ? 32768 : length > 12000 ? 16384 : 8192,
    timeoutMs: length > 200000 ? 300000 : length > 12000 ? 180000 : 60000,
  };
}
export const SOURCE_PREPARATION_VERSION = "lossless-segments-v1";
