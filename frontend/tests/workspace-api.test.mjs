import assert from "node:assert/strict";
import { it, afterEach } from "node:test";
import { processSource } from "../.cache/workspace-tests/features/workspace/workspace-api.js";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const stage = { event: "stage", stage: "extracting", message: "Reading UTF-8 café source" };
const result = {
  event: "result",
  result: { status: "pending", message: "Please wait", retryAfterSeconds: 3 },
};
function stream(lines, chunkSize = 7) {
  const bytes = new TextEncoder().encode(lines),
    body = new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += chunkSize)
          controller.enqueue(bytes.slice(i, i + chunkSize));
        controller.close();
      },
    });
  globalThis.fetch = async () =>
    new Response(body, { headers: { "Content-Type": "application/x-ndjson" } });
}
const run = (events) =>
  processSource(
    "http://fixture.invalid",
    { sourceType: "pdf", outputTypes: ["detailed_notes"] },
    null,
    new AbortController().signal,
    (event) => events.push(event),
  );
it("stream reader handles split UTF-8/JSON lines and final lines without newline", async () => {
  stream(JSON.stringify(stage) + "\n" + JSON.stringify(result));
  const events = [];
  await run(events);
  assert.deepEqual(events, [stage, result]);
});
it("stream reader rejects invalid, oversized and incomplete responses", async () => {
  for (const input of [
    JSON.stringify(stage) + "\n",
    '{"event":"result","result":{"status":"fake"}}',
    "x".repeat(2000001),
  ]) {
    stream(input, 100000);
    await assert.rejects(run([]));
  }
});
it("stream errors preserve explicit safe failure and do not automatically retry", async () => {
  const error = {
    event: "error",
    code: "GEMINI_UNCERTAIN",
    message: "Operator review required",
    retryable: false,
  };
  stream(JSON.stringify(error));
  const events = [];
  await run(events);
  assert.deepEqual(events, [error]);
});
it("HTTP failures and non-stream responses produce useful errors", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "Wait before retrying." } }), { status: 429 });
  const events = [];
  await run(events);
  assert.deepEqual(events, [
    {
      event: "error",
      code: "WORKSPACE_REQUEST_REJECTED",
      message: "Wait before retrying.",
      retryable: true,
      retryAfterSeconds: 60,
    },
  ]);
  globalThis.fetch = async () =>
    new Response("{}", { headers: { "Content-Type": "application/json" } });
  await assert.rejects(run([]), /processing stream/);
});
