import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { envSchema, isValidGeminiKeyFormat } from "../dist/config/env-schema.js";
import { fixtureNotes } from "./helpers/database.mjs";

// Synthetic values only. Never load local credential files in these child tests.
const aq = `AQ.${"synthetic_fixture_".repeat(4)}`;
const validModel = "gemini-3.8-flash";
const configured = (key, model = validModel) =>
  envSchema.safeParse({ GEMINI_API_KEY: key, GEMINI_MODEL: model });

describe("Gemini key and model format validation", () => {
  it("accepts synthetic AQ keys including payload/total-length boundaries", () => {
    for (const key of [aq, `AQ.${"x".repeat(16)}`, `AQ.${"x".repeat(4093)}`]) {
      assert.equal(isValidGeminiKeyFormat(key), true);
      assert.equal(configured(key).success, true);
    }
  });
  it("preserves valid standard keys with a bounded maximum length", () => {
    for (const key of [
      "not_a_real_api_key_fixture",
      `AIza${"x".repeat(35)}`,
      "x".repeat(16),
      "x".repeat(4096),
    ]) {
      assert.equal(configured(key).success, true);
    }
  });
  it("rejects empty, short or malformed AQ values and arbitrary dotted strings", () => {
    for (const key of [
      "",
      "AQ.",
      `AQ.${"x".repeat(15)}`,
      `aq.${"x".repeat(20)}`,
      `Aq.${"x".repeat(20)}`,
      `A.Q.${"x".repeat(20)}`,
      `AQ..${"x".repeat(20)}`,
      `${aq}.`,
      `other.${"x".repeat(20)}`,
      `${aq}=`,
      "x".repeat(15),
    ]) {
      assert.equal(isValidGeminiKeyFormat(key), false);
      assert.equal(configured(key).success, false);
    }
    // Both unset intentionally remains health/preview-only mode.
    assert.equal(envSchema.safeParse({ GEMINI_API_KEY: "", GEMINI_MODEL: "" }).success, true);
  });
  it("rejects whitespace/control characters anywhere in either format", () => {
    for (const character of [
      " ",
      "\t",
      "\n",
      "\r",
      "\u0000",
      "\u001f",
      "\u007f",
      "\u0085",
      "\u00a0",
    ]) {
      for (const key of [aq, "not_a_real_api_key_fixture"]) {
        for (const invalid of [
          character + key,
          key + character,
          key.slice(0, 8) + character + key.slice(8),
        ]) {
          assert.equal(configured(invalid).success, false);
        }
      }
    }
  });
  it("rejects overlong AQ and standard keys", () => {
    for (const key of [`AQ.${"x".repeat(4094)}`, "x".repeat(4097)]) {
      assert.equal(configured(key).success, false);
    }
  });
  it("accepts gemini-3.8-flash but rejects invalid model identifiers", () => {
    assert.equal(configured(aq).success, true);
    for (const model of [
      "",
      "gemini-",
      "Gemini-3.8-flash",
      "models/gemini-3.8-flash",
      "gemini-flash-latest",
      "gemini-3.8-flash ",
      "gemini-3.8-flash\n",
      "other-model",
      `gemini-${"x".repeat(101)}`,
    ]) {
      assert.equal(configured(aq, model).success, false);
    }
  });
});

describe("Developer API pinning with mocked SDK HTTP; no live requests", () => {
  for (const target of ["generator", "model-list script"]) {
    it(`${target} ignores Vertex/Enterprise and base-URL overrides`, () => {
      const preload = `
        import assert from 'node:assert/strict';
        const model = { name: 'models/${validModel}', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 200000, outputTokenLimit: 16384 };
        let calls = 0;
        globalThis.fetch = async (input, init) => {
          calls++;
          const request = input instanceof Request ? input : new Request(input, init);
          const url = new URL(request.url);
          assert.equal(url.origin, 'https://generativelanguage.googleapis.com');
          assert.equal(request.headers.get('x-goog-api-key'), process.env.GEMINI_API_KEY);
          assert.equal(request.headers.has('authorization'), false);
          assert.equal(url.searchParams.has('key'), false);
          const data = request.method === 'POST'
            ? { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: ${JSON.stringify(JSON.stringify(fixtureNotes))} }] } }] }
            : url.pathname.endsWith('/models') ? { models: [model] } : model;
          return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
        };
        process.on('beforeExit', () => assert.equal(calls, ${target === "generator" ? 2 : 1}));
      `;
      const args = ["--import", `data:text/javascript,${encodeURIComponent(preload)}`];
      if (target === "generator") {
        args.push(
          "--input-type=module",
          "-e",
          `
          const { getConfiguredGemini } = await import('./dist/modules/ai/gemini-notes.js');
          await getConfiguredGemini().generate('Synthetic transcript only.');
        `,
        );
      } else {
        args.push("scripts/gemini-models.mjs");
      }
      const child = spawnSync(process.execPath, args, {
        cwd: new URL("..", import.meta.url),
        env: {
          ...process.env,
          DOTENV_CONFIG_PATH: new URL("./nonexistent-fixture.env", import.meta.url).pathname,
          NODE_ENV: "test",
          LOG_LEVEL: "silent",
          SUPABASE_URL: "",
          SUPABASE_SECRET_KEY: "",
          GEMINI_API_KEY: aq,
          GOOGLE_API_KEY: "",
          GEMINI_MODEL: validModel,
          AI_PROVIDER: "gemini",
          GOOGLE_GENAI_USE_VERTEXAI: "true",
          GOOGLE_GENAI_USE_ENTERPRISE: "true",
          GOOGLE_VERTEX_BASE_URL: "https://wrong-vertex.invalid/",
          GOOGLE_GEMINI_BASE_URL: "https://wrong-developer.invalid/",
          GOOGLE_GENAI_API_VERSION: "v1",
        },
        encoding: "utf8",
        timeout: 15000,
      });
      assert.equal(child.status, 0, "Mocked client process must succeed without external requests");
      assert.equal(`${child.stdout}${child.stderr}`.includes(aq), false);
      if (target === "model-list script") assert.ok(child.stdout.includes(validModel));
    });
  }
});
