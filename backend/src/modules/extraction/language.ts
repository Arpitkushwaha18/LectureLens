import { detect } from "tinyld";
export function detectSourceLanguage(text: string): string {
  return text.trim().length < 20 ? "und" : detect(text.slice(0, 20000)) || "und";
}
