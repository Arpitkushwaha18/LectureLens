import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import type { GenerateContentParameters, GenerateContentResponse } from "@google/genai";
import { notebookSchema } from "@lecturelens/contracts";
import { z } from "zod";
import { NotesGenerationError } from "./gemini-notes.js";
import { providerFailure } from "./provider-errors.js";
import type { AiProvider } from "./provider-types.js";
import { strictProviderSchema, restoreOptionalFields } from "./structured-schema.js";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/**
 * OpenRouter exposes an OpenAI-compatible Chat Completions API. It is called
 * directly so retries, timeouts and error classification remain owned by the
 * existing provider manager. Only the server-side bearer key and the selected
 * model are sent outside this process; no student data is persisted.
 */
export function openRouterProvider(
  options: {
    key: string;
    model: string;
    contextTokens: number;
    outputTokens: number;
    timeoutMs: number;
  },
  request: typeof fetch = globalThis.fetch,
): AiProvider {
  return {
    id: "openrouter",
    model: options.model,
    supportsPdf: false,
    async generateContent(input: GenerateContentParameters): Promise<GenerateContentResponse> {
      const contents = input.contents as { parts?: { text?: string; inlineData?: unknown }[] }[];
      const parts = contents.flatMap((item) => item.parts ?? []);
      if (parts.some((part) => part.inlineData))
        throw new NotesGenerationError(
          "AI_REQUEST_INVALID",
          "The selected OpenRouter model cannot accept original PDFs.",
          false,
          422,
        );
      const system = `${input.config?.systemInstruction ?? ""}\nReturn only JSON matching this schema, without code fences:\n${JSON.stringify(input.config?.responseJsonSchema)}`;
      const user = parts.map((part) => part.text ?? "").join("\n");
      const output = Math.min(input.config?.maxOutputTokens ?? 8192, options.outputTokens);
      const schema = input.config?.responseJsonSchema as Record<string, unknown> | undefined;
      // Do not reuse Gemini's deliberately stripped length/array bounds for strict decoding.
      const version = (schema?.properties as Record<string, { enum?: unknown[] }> | undefined)
        ?.schemaVersion;
      const wireSchema = version?.enum?.includes(2) ? z.toJSONSchema(notebookSchema) : schema;
      const strict = Boolean(wireSchema?.properties);
      // o200k is an estimator, not every OpenRouter model's exact tokenizer. Reserve 20% plus overhead.
      const estimatedTokens = Math.ceil((countTokens(system) + countTokens(user)) * 1.2) + output;
      if (estimatedTokens + 1024 > options.contextTokens)
        throw new NotesGenerationError(
          "AI_REQUEST_INVALID",
          "The source exceeds the configured OpenRouter context limit. Reduce chunk size or select a larger context model.",
          false,
          422,
        );
      const timeout = AbortSignal.timeout(options.timeoutMs);
      const signal = input.config?.abortSignal
        ? AbortSignal.any([input.config.abortSignal, timeout])
        : timeout;
      try {
        const response = await request(ENDPOINT, {
          method: "POST",
          redirect: "error",
          headers: {
            authorization: `Bearer ${options.key}`,
            "content-type": "application/json",
            "x-title": "LectureLens",
          },
          body: JSON.stringify({
            model: options.model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            temperature: input.config?.temperature ?? 0.2,
            max_tokens: output,
            response_format: strict
              ? {
                  type: "json_schema",
                  json_schema: {
                    name: "lecture_material",
                    strict: true,
                    schema: strictProviderSchema(wireSchema!),
                  },
                }
              : { type: "json_object" },
            // Route only to endpoints that advertise every requested capability.
            provider: { require_parameters: true },
            stream: false,
          }),
          signal,
        });
        if (!response.ok) {
          const headers = new Headers(response.headers);
          const reset = headers.get("x-ratelimit-reset");
          if (!headers.get("retry-after") && reset && /^\d+$/.test(reset))
            headers.set(
              "retry-after",
              String(Math.max(0, Math.ceil((Number(reset) - Date.now()) / 1000))),
            );
          throw Object.assign(new Error("OpenRouter request failed"), {
            status: response.status,
            headers,
          });
        }
        const result = (await response.json()) as {
          id?: string;
          choices?: {
            finish_reason?: string;
            message?: { content?: string | null };
          }[];
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
          };
        };
        const choice = result.choices?.[0];
        if (
          choice?.finish_reason !== "stop" ||
          !choice.message?.content?.trim() ||
          choice.message.content.length > 300000
        )
          throw new NotesGenerationError(
            "AI_INVALID_OUTPUT",
            "OpenRouter returned incomplete or empty material. No partial result was published.",
            false,
            502,
          );
        let text = choice.message.content;
        if (strict) {
          try {
            text = JSON.stringify(restoreOptionalFields(JSON.parse(text), schema!));
          } catch {
            throw new NotesGenerationError(
              "AI_INVALID_OUTPUT",
              "OpenRouter returned malformed structured material. No partial output was published.",
              false,
              502,
            );
          }
        }
        return {
          text,
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
        if (error instanceof NotesGenerationError) throw error;
        if (input.config?.abortSignal?.aborted) throw input.config.abortSignal.reason;
        if (timeout.aborted) throw providerFailure({ name: "TimeoutError" });
        if (error instanceof Error && error.name === "TimeoutError")
          throw providerFailure({ name: "TimeoutError" });
        throw providerFailure(error);
      }
    },
  };
}
