import type { GenerateContentParameters, GenerateContentResponse } from "@google/genai";
import { NotesGenerationError, classifyGeminiError } from "./gemini-notes.js";
import { recordGenerationEvidence } from "./generation-evidence.js";

const ENDPOINT = "https://freegg.app/v1/responses";
const MAX_RESPONSE_BYTES = 2_000_000;

/** OpenAI-compatible transport. No Gemini requests, guessed model limits or automatic retries. */
export function freeggTransport(key: string, request: typeof fetch = globalThis.fetch) {
  return {
    async generateContent(input: GenerateContentParameters): Promise<GenerateContentResponse> {
      const contents = input.contents as { parts?: { text?: string }[] }[];
      const config = input.config;
      const messages = [
        {
          role: "system",
          content: `${config?.systemInstruction}\nReturn only a JSON object matching this schema, with no code fences:\n${JSON.stringify(config?.responseJsonSchema)}`,
        },
        {
          role: "user",
          content: contents
            .flatMap((item) => item.parts ?? [])
            .map((part) => part.text ?? "")
            .join("\n"),
        },
      ];
      const signal = config?.abortSignal ?? AbortSignal.timeout(300000);
      signal.throwIfAborted();
      await recordGenerationEvidence({ kind: "dispatch" });
      let response: Response;
      try {
        response = await request(ENDPOINT, {
          method: "POST",
          redirect: "error",
          signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: input.model,
            input: messages,
            max_output_tokens: config?.maxOutputTokens ?? 8192,
            text: { format: { type: "json_object" } },
            store: false,
            stream: false,
          }),
        });
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
      } as GenerateContentResponse;
    },
  };
}
