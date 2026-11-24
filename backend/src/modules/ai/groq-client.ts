import Groq from "groq-sdk";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import type { GenerateContentParameters, GenerateContentResponse } from "@google/genai";
import { NotesGenerationError } from "./gemini-notes.js";
import { providerFailure } from "./provider-errors.js";
import type { AiProvider } from "./provider-types.js";

export function groqProvider(
  options: {
    key: string;
    model: string;
    contextTokens: number;
    outputTokens: number;
    timeoutMs: number;
  },
  request?: typeof fetch,
): AiProvider {
  const client = new Groq({
    apiKey: options.key,
    maxRetries: 0,
    timeout: options.timeoutMs,
    ...(request ? { fetch: request } : {}),
  });
  return {
    id: "groq",
    model: options.model,
    supportsPdf: false,
    async generateContent(input: GenerateContentParameters): Promise<GenerateContentResponse> {
      const contents = input.contents as { parts?: { text?: string; inlineData?: unknown }[] }[];
      const parts = contents.flatMap((item) => item.parts ?? []);
      if (parts.some((part) => part.inlineData))
        throw new NotesGenerationError(
          "AI_REQUEST_INVALID",
          "The selected Groq model cannot accept original PDFs.",
          false,
          422,
        );
      const system = `${input.config?.systemInstruction ?? ""}\nReturn only JSON matching this schema, without code fences:\n${JSON.stringify(input.config?.responseJsonSchema)}`;
      const user = parts.map((part) => part.text ?? "").join("\n");
      const output = Math.min(input.config?.maxOutputTokens ?? 8192, options.outputTokens);
      // o200k is the GPT-family estimator, not an exact GPT-OSS tokenizer. Reserve 20% plus message overhead.
      if (
        Math.ceil((countTokens(system) + countTokens(user)) * 1.2) + output + 1024 >
        options.contextTokens
      )
        throw new NotesGenerationError(
          "AI_REQUEST_INVALID",
          "The source exceeds the configured Groq context limit. Reduce chunk size or select a larger context model.",
          false,
          422,
        );
      try {
        const result = await client.chat.completions.create(
          {
            model: options.model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            temperature: input.config?.temperature ?? 0.2,
            max_completion_tokens: output,
            response_format: { type: "json_object" },
            stream: false,
          },
          { signal: input.config?.abortSignal, timeout: options.timeoutMs, maxRetries: 0 },
        );
        const choice = result.choices[0];
        if (
          choice?.finish_reason !== "stop" ||
          !choice.message.content?.trim() ||
          choice.message.content.length > 300000
        )
          throw new NotesGenerationError(
            "AI_INVALID_OUTPUT",
            "Groq returned incomplete or empty material. No partial result was published.",
            false,
            502,
          );
        return {
          text: choice.message.content,
          responseId: result.id,
          candidates: [{ finishReason: "STOP" }],
          usageMetadata: result.usage
            ? {
                promptTokenCount: result.usage.prompt_tokens,
                candidatesTokenCount: result.usage.completion_tokens,
                totalTokenCount: result.usage.total_tokens,
              }
            : undefined,
        } as GenerateContentResponse;
      } catch (error) {
        if (error instanceof Groq.APIConnectionTimeoutError || input.config?.abortSignal?.aborted)
          throw providerFailure({ name: "TimeoutError" });
        if (error instanceof Groq.APIConnectionError)
          throw providerFailure({ name: "APIConnectionError" });
        throw providerFailure(error);
      }
    },
  };
}
