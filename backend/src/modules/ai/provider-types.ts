import type { GenerateContentParameters, GenerateContentResponse } from "@google/genai";

// Compatibility adapter at the existing generation boundary; no SDK leaks into application services.
export type ProviderId = "groq" | "freegg";
export type AiProvider = {
  id: ProviderId;
  model: string;
  supportsPdf: boolean;
  generateContent(input: GenerateContentParameters): Promise<GenerateContentResponse>;
};
