import { z } from "zod";
/** Gemini's grammar is not full JSON Schema. Keep structural types, not Zod's
 * deeply multiplied array bounds. Local Zod validation remains authoritative. */
export function geminiResponseSchema(schema: z.ZodType): Record<string, unknown> {
  function convert(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(convert);
    if (!value || typeof value !== "object") return value;
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (
        [
          "$schema",
          "minLength",
          "maxLength",
          "minItems",
          "maxItems",
          "minimum",
          "maximum",
          "exclusiveMinimum",
          "exclusiveMaximum",
          "pattern",
        ].includes(key)
      )
        continue;
      if (key === "const") output.enum = [item];
      else output[key === "oneOf" ? "anyOf" : key] = convert(item);
    }
    return output;
  }
  return convert(z.toJSONSchema(schema)) as Record<string, unknown>;
}
