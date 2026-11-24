import type { GenerateContentParameters, GenerateContentResponse } from "@google/genai";
import { NotesGenerationError, classifyGeminiError } from "./gemini-notes.js";
import { recordGenerationEvidence } from "./generation-evidence.js";

const ENDPOINT = "https://freegg.app/v1/responses";
const MAX_RESPONSE_BYTES = 2_000_000;

/** OpenAI-compatible transport. No Gemini requests, guessed model limits or automatic retries. */
export function freeggTransport(
  key: string,
  request: typeof fetch = globalThis.fetch,
  baseUrl = "https://freegg.app/v1",
) {
  return {
    async generateContent(input: GenerateContentParameters): Promise<GenerateContentResponse> {
      const contents = input.contents as {
        parts?: {
          text?: string;
          inlineData?: { mimeType?: string; data?: string; displayName?: string };
        }[];
      }[];
      const parts = contents.flatMap((item) => item.parts ?? []);
      const files = parts.filter((part) => part.inlineData);
      if (
        files.some(
          (part) => part.inlineData?.mimeType !== "application/pdf" || !part.inlineData.data,
        )
      )
        throw new NotesGenerationError(
          "GEMINI_REQUEST_INVALID",
          "Only PDF file inputs are supported.",
          false,
          400,
        );
      const config = input.config;
      const messages = [
        {
          role: "system",
          content: `${config?.systemInstruction}\nReturn only a JSON object matching this schema, with no code fences:\n${JSON.stringify(config?.responseJsonSchema)}`,
        },
        {
          role: "user",
          content: files.length
            ? parts.map((part) =>
                part.inlineData
                  ? {
                      type: "input_file",
                      filename: part.inlineData.displayName ?? "document.pdf",
                      file_data: `data:application/pdf;base64,${part.inlineData.data}`,
                    }
                  : { type: "input_text", text: part.text ?? "" },
              )
            : parts.map((part) => part.text ?? "").join("\n"),
        },
      ];
      const signal = config?.abortSignal ?? AbortSignal.timeout(300000);
      signal.throwIfAborted();
      await recordGenerationEvidence({ kind: "dispatch" });
      let response: Response;
      try {
        response = await request(
          baseUrl === "https://freegg.app/v1"
            ? ENDPOINT
            : `${baseUrl.replace(/\/$/, "")}/responses`,
          {
            method: "POST",
            redirect: "error",
            signal,
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
            body: JSON.stringify({
              model: input.model,
              input: messages,
              max_output_tokens: config?.maxOutputTokens ?? 8192,
              // FreeGG's configured GPT reasoning model rejects temperature.
              // Omit optional sampling controls instead of discovering capabilities by retrying.
              text: { format: { type: "json_object" } },
              store: false,
              stream: false,
            }),
          },
        );
      } catch (error) {
        const code = (error as { cause?: { code?: string } })?.cause?.code;
        if (["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(code ?? "")) {
          await recordGenerationEvidence({
            kind: "not_sent",
            classification: "GENERATION_NOT_SENT",
          });
          throw new NotesGenerationError(
            "GENERATION_NOT_SENT",
            "Generation could not be started.",
            true,
            503,
          );
        }
        throw classifyGeminiError(error);
      }
      const failure = !response.ok
        ? classifyGeminiError({ status: response.status, headers: response.headers })
        : undefined;
      await recordGenerationEvidence({
        kind: "response",
        httpStatus: response.status,
        requestId: response.headers.get("x-request-id") ?? undefined,
        ...(failure?.retryable ? { retryAfterSeconds: failure.retryAfterSeconds } : {}),
      });
      if (failure) {
        // Never read/log an upstream error body, which may echo private inputs or credentials.
        await response.body?.cancel();
        throw failure;
      }
      const reader = response.body?.getReader();
      if (!reader)
        throw new NotesGenerationError(
          "GEMINI_INVALID_OUTPUT",
          "The provider returned no study material.",
        );
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new NotesGenerationError(
              "GEMINI_INVALID_OUTPUT",
              "The provider response was too large.",
            );
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      let body: {
        id?: string;
        status?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
        output?: { type?: string; role?: string; content?: { type?: string; text?: string }[] }[];
      };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new NotesGenerationError(
          "GEMINI_INVALID_OUTPUT",
          "The provider returned invalid JSON.",
        );
      }
      const output = body?.output;
      if (body?.status !== "completed" || !Array.isArray(output))
        throw new NotesGenerationError(
          "GEMINI_INVALID_OUTPUT",
          "The provider returned incomplete study material.",
        );
      const text = output
        .filter((item) => item?.type === "message" && item.role === "assistant")
        .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
        .filter((part) => part?.type === "output_text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("");
      if (!text)
        throw new NotesGenerationError(
          "GEMINI_INVALID_OUTPUT",
          "The provider returned no study material.",
        );
      return {
        text,
        responseId: typeof body.id === "string" ? body.id : undefined,
        candidates: [{ finishReason: "STOP" }],
        usageMetadata: body.usage
          ? {
              promptTokenCount: body.usage.input_tokens ?? body.usage.prompt_tokens,
              candidatesTokenCount: body.usage.output_tokens ?? body.usage.completion_tokens,
              totalTokenCount: body.usage.total_tokens,
            }
          : undefined,
      } as GenerateContentResponse;
    },
  };
}
