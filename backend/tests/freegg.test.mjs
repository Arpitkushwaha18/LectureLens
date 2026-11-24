import assert from "node:assert/strict";
import { it } from "node:test";
import { spawnSync } from "node:child_process";
process.env.NODE_ENV = "test";
const { freeggTransport } = await import("../dist/modules/ai/freegg-client.js");
const { createGeminiStudyGenerator } = await import("../dist/modules/ai/gemini-study.js");
const { envSchema } = await import("../dist/config/env-schema.js");
const notebook = {
  schemaVersion: 2,
  title: "Computer organization",
  blocks: [{ type: "paragraph", text: "Instructions specify computer operations." }],
  limitations: [],
};
const completion = (content, status = "completed") =>
  new Response(
    JSON.stringify({
      id: "fixture",
      status,
      output: [
        { type: "reasoning", summary: [] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: content }] },
      ],
    }),
  );
it("FreeGG serializes PDF bytes as Responses input_file, not a text placeholder", async () => {
  const data = Buffer.from("%PDF-1.7 synthetic fixture").toString("base64");
  let calls = 0;
  const generate = createGeminiStudyGenerator(
    "gpt-6.1-sol",
    freeggTransport("fixture-secret", async (url, options) => {
      calls++;
      assert.equal(url, "https://freegg.app/v1/responses");
      const body = JSON.parse(options.body);
      const content = body.input[1].content;
      assert.equal(content[0].type, "input_text");
      assert.match(content[0].text, /attached complete PDF/);
      assert.deepEqual(content[1], {
        type: "input_file",
        filename: "scan.pdf",
        file_data: `data:application/pdf;base64,${data}`,
      });
      assert.equal(body.store, false);
      return completion(JSON.stringify(notebook));
    }),
  );
  assert.deepEqual(
    await generate("PDF preview.", "detailed_notes", { pdf: { data, name: "scan.pdf" } }),
    notebook,
  );
  assert.equal(calls, 1);
});
it("a rejected PDF causes one request only, without a text-only/provider fallback", async () => {
  let calls = 0;
  const generate = createGeminiStudyGenerator(
    "gpt-6.1-sol",
    freeggTransport("fixture-secret", async () => {
      calls++;
      return new Response("private upstream message", { status: 400 });
    }),
  );
  await assert.rejects(
    () => generate("PDF preview.", "detailed_notes", { pdf: { data: "cGRm", name: "scan.pdf" } }),
    (error) => error.code === "GEMINI_REQUEST_INVALID",
  );
  assert.equal(calls, 1);
});
it("FreeGG sends the full lecture with English/schema instructions to the selected endpoint, without Gemini metadata or retries", async () => {
  let calls = 0;
  const text = "कंप्यूटर संगठन में निर्देश महत्वपूर्ण हैं। ".repeat(7000);
  const generate = createGeminiStudyGenerator(
    "gpt-6.1-sol",
    freeggTransport("fixture-secret", async (url, options) => {
      calls++;
      assert.equal(url, "https://freegg.app/v1/responses");
      assert.equal(options.headers.Authorization, "Bearer fixture-secret");
      assert.equal(options.redirect, "error");
      assert.ok(options.signal);
      const body = JSON.parse(options.body);
      assert.equal(body.model, "gpt-6.1-sol");
      assert.equal(body.stream, false);
      assert.equal(body.store, false);
      assert.equal("messages" in body, false);
      assert.equal("max_tokens" in body, false);
      assert.deepEqual(body.text.format, { type: "json_object" });
      assert.match(body.input[0].content, /in English/);
      assert.match(body.input[0].content, /schemaVersion/);
      const source = JSON.parse(body.input[1].content);
      assert.equal(source.sourceSegments.join(""), text);
      return completion(JSON.stringify(notebook));
    }),
  );
  assert.deepEqual(await generate(text, "detailed_notes", { sourceLanguage: "hi" }), notebook);
  assert.equal(calls, 1);
});
it("FreeGG failures never expose provider bodies or retry a dispatched request automatically", async () => {
  for (const [status, code] of [
    [401, "GEMINI_CREDENTIALS"],
    [410, "GENERATION_ENDPOINT_RETIRED"],
    [429, "GEMINI_QUOTA"],
    [503, "GEMINI_TEMPORARY"],
  ]) {
    let calls = 0;
    const generate = createGeminiStudyGenerator(
      "gpt-6.1-sol",
      freeggTransport("fixture-secret", async () => {
        calls++;
        return new Response("SECRET_PROVIDER_DETAIL", {
          status,
          headers: { "retry-after": "120" },
        });
      }),
    );
    await assert.rejects(
      () => generate("Computer organization lecture.", "detailed_notes"),
      (e) => e.code === code && !e.message.includes("SECRET_PROVIDER_DETAIL"),
    );
    assert.equal(calls, 1);
  }
});
it("FreeGG refuses truncated, malformed and contract-invalid output", async () => {
  for (const response of [
    completion(JSON.stringify(notebook), "incomplete"),
    new Response(
      JSON.stringify({
        status: "completed",
        output: [
          { type: "message", role: "assistant", content: [{ type: "refusal", refusal: "No" }] },
        ],
      }),
    ),
    completion("not JSON"),
    completion('{"title":"Broken"}'),
    new Response("not JSON"),
    new Response("x".repeat(2000001)),
  ]) {
    const generate = createGeminiStudyGenerator(
      "gpt-6.1-sol",
      freeggTransport("fixture-secret", async () => response),
    );
    await assert.rejects(
      () => generate("Computer organization lecture.", "detailed_notes"),
      (e) => e.code === "GEMINI_INVALID_OUTPUT",
    );
  }
});
it("FreeGG key settings accept bearer-key characters but reject whitespace, and missing keys make no network calls", () => {
  assert.equal(
    envSchema.safeParse({
      AI_PROVIDER: "freegg",
      FREEGG_API_KEY: "sk-example.key",
      FREEGG_MODEL: "gpt-6.1-sol",
    }).success,
    true,
  );
  assert.equal(envSchema.safeParse({ FREEGG_API_KEY: "Bearer secret" }).success, false);
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `globalThis.fetch=()=>{throw new Error('NETWORK_NOT_ALLOWED')};const {getConfiguredStudyGemini}=await import('./dist/modules/ai/gemini-study.js');try{getConfiguredStudyGemini();process.exit(1)}catch(e){if(e.code!=='GEMINI_NOT_CONFIGURED')throw e}`,
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: "test",
        AI_PROVIDER: "freegg",
        FREEGG_API_KEY: "",
        GEMINI_API_KEY: "",
        GEMINI_MODEL: "",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr.toString());
});
it("configured generation selects FreeGG even when Gemini settings are retained", () => {
  const code = `import assert from 'node:assert/strict';let calls=0;globalThis.fetch=async(url,options)=>{calls++;assert.equal(url,'https://freegg.app/v1/responses');assert.equal(JSON.parse(options.body).model,'gpt-6.1-sol');return new Response(JSON.stringify({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:${JSON.stringify(JSON.stringify(notebook))}}]}]}))};const {getConfiguredStudyGemini}=await import('./dist/modules/ai/gemini-study.js');const configured=getConfiguredStudyGemini();assert.equal(configured.model,'freegg:gpt-6.1-sol');await configured.generate('Computer organization lecture.','detailed_notes');assert.equal(calls,1)`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      AI_PROVIDER: "freegg",
      FREEGG_API_KEY: "fixture-secret",
      FREEGG_MODEL: "gpt-6.1-sol",
      GEMINI_API_KEY: "a".repeat(24),
      GEMINI_MODEL: "gemini-2.5-flash",
    },
  });
  assert.equal(result.status, 0, result.stderr.toString());
});
