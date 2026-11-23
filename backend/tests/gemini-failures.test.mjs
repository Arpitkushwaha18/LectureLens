import assert from "node:assert/strict";
import { it, afterEach } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.NODE_ENV = "test";
process.env.GEMINI_API_KEY = "a".repeat(24);
process.env.GEMINI_MODEL = "gemini-2.5-flash";
const { classifyGeminiError } = await import("../dist/modules/ai/gemini-notes.js");
const { geminiClient, validateGeminiStartup } = await import("../dist/modules/ai/gemini-client.js");
const { geminiResponseSchema } = await import("../dist/modules/ai/gemini-schema.js");
const { WorkspaceCache } = await import("../dist/repositories/workspace-cache.js");
const { notebookSchema, detailedNotesSchema, MAX_SOURCE_CHARACTERS, manualNotesTranscriptSchema } =
  await import("@lecturelens/contracts");
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
it("Gemini failures separate credentials, model, request/schema, quota, provider and uncertain network outcomes", () => {
  for (const [status, code, retryable] of [
    [401, "GEMINI_CREDENTIALS", false],
    [403, "GEMINI_CREDENTIALS", false],
    [404, "GEMINI_MODEL_NOT_FOUND", false],
    [400, "GEMINI_REQUEST_INVALID", false],
    [429, "GEMINI_QUOTA", true],
    [500, "GEMINI_TEMPORARY", true],
    [503, "GEMINI_TEMPORARY", true],
  ]) {
    const error = classifyGeminiError({ status, message: "secret upstream input" });
    assert.equal(error.code, code);
    assert.equal(error.retryable, retryable);
    assert.ok(!error.message.includes("secret upstream"));
  }
  assert.equal(classifyGeminiError({ name: "TimeoutError" }).code, "GEMINI_TIMEOUT");
  assert.equal(classifyGeminiError({ cause: { code: "ECONNRESET" } }).code, "GEMINI_CONNECTION");
  assert.equal(classifyGeminiError(new Error("secret")).retryable, false);
});
it("official SDK fetch adapter preserves Retry-After and never repeats a paid call", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ error: { message: "private", code: 429 } }), {
      status: 429,
      headers: { "Retry-After": "180" },
    });
  };
  await assert.rejects(
    geminiClient("a".repeat(24)).models.generateContent({
      model: "gemini-2.5-flash",
      contents: "Test fixture only",
    }),
    (error) => error.code === "GEMINI_QUOTA" && error.retryAfterSeconds === 180,
  );
  assert.equal(calls, 1);
  assert.ok(
    classifyGeminiError({
      status: 503,
      headers: new Headers({ "retry-after": new Date(Date.now() + 240000).toUTCString() }),
    }).retryAfterSeconds >= 239,
  );
});
it("Google RetryInfo cooldowns are honored without revealing provider messages or replaying a paid request", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(
      JSON.stringify({
        error: {
          message: "SECRET_PROVIDER_DETAIL",
          details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "122.4s" }],
        },
      }),
      { status: 429 },
    );
  };
  await assert.rejects(
    () =>
      geminiClient("a".repeat(24)).models.generateContent({
        model: "gemini-2.5-flash",
        contents: "Fixture only",
      }),
    (e) =>
      e.code === "GEMINI_QUOTA" &&
      e.retryAfterSeconds === 123 &&
      !e.message.includes("SECRET_PROVIDER_DETAIL"),
  );
  assert.equal(calls, 1);
});
it("startup uses only model metadata GET and invalid-key detail is sanitized as authentication", async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ error: { code: 400, details: [{ reason: "API_KEY_INVALID" }] } }),
      { status: 400 },
    );
  await assert.rejects(
    geminiClient("a".repeat(24)).models.get({ model: "gemini-2.5-flash" }),
    (error) => error.code === "GEMINI_CREDENTIALS",
  );
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.match(
      String(url),
      /^https:\/\/generativelanguage.googleapis.com\/v1beta\/models\/gemini-2.5-flash$/,
    );
    assert.equal(options.method, "GET");
    return new Response(
      JSON.stringify({
        name: "models/gemini-2.5-flash",
        supportedGenerationMethods: ["generateContent"],
        inputTokenLimit: 1048576,
        outputTokenLimit: 65536,
      }),
    );
  };
  const model = await validateGeminiStartup();
  assert.equal(model.name, "models/gemini-2.5-flash");
  assert.equal(calls, 1);
});
it("listed model can still deny generation for the account: 404 is definitive and never triggers automatic model fallback", async () => {
  let paid = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes(":generateContent")) {
      paid++;
      return new Response(
        JSON.stringify({
          error: {
            code: 404,
            status: "NOT_FOUND",
            message:
              "This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash.",
          },
        }),
        { status: 404 },
      );
    }
    return new Response(
      JSON.stringify({
        name: "models/gemini-2.5-flash",
        supportedGenerationMethods: ["generateContent"],
        inputTokenLimit: 1048576,
        outputTokenLimit: 65536,
      }),
    );
  };
  await validateGeminiStartup();
  await assert.rejects(
    geminiClient("a".repeat(24)).models.generateContent({
      model: "gemini-2.5-flash",
      contents: "Small fixture",
    }),
    (error) =>
      error.code === "GEMINI_MODEL_NOT_FOUND" &&
      !error.retryable &&
      !error.message.includes("new users"),
  );
  assert.equal(paid, 1);
});
it("provider schema excludes the grammar-exploding bounds and unsupported oneOf, while local validation stays strict", () => {
  for (const schema of [notebookSchema, detailedNotesSchema]) {
    const serialized = JSON.stringify(geminiResponseSchema(schema));
    assert.ok(serialized.includes('"anyOf"'));
    for (const key of [
      "oneOf",
      "const",
      "maxItems",
      "minItems",
      "maxLength",
      "minLength",
      "$schema",
    ])
      assert.ok(!serialized.includes(`"${key}"`));
  }
  assert.equal(
    notebookSchema.safeParse({
      schemaVersion: 2,
      title: "T",
      blocks: [{ type: "unknown", text: "bad" }],
      limitations: [],
    }).success,
    false,
  );
});
it("environment loading works from root and missing/quoted keys fail safely without network", () => {
  for (const key of ["", '"' + "a".repeat(24) + '"']) {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {validateGeminiStartup} from './backend/dist/modules/ai/gemini-client.js';try{await validateGeminiStartup()}catch(e){console.log(e.code);process.exitCode=2}`,
      ],
      {
        cwd: new URL("../../", import.meta.url),
        env: {
          ...process.env,
          GEMINI_API_KEY: key,
          GEMINI_MODEL: key ? "gemini-2.5-flash" : "",
          NODE_ENV: "test",
          SUPABASE_URL: "",
          SUPABASE_SECRET_KEY: "",
        },
        encoding: "utf8",
      },
    );
    assert.notEqual(result.status, 0);
    assert.ok(!result.stdout.includes("a".repeat(24)));
    assert.ok(!result.stderr.includes("a".repeat(24)));
  }
});
it("100,000-character English and Hindi sources are accepted without silent truncation", () => {
  for (const char of ["x", "न"]) {
    const text = char.repeat(MAX_SOURCE_CHARACTERS);
    assert.equal(manualNotesTranscriptSchema.parse(text), text);
    assert.equal(manualNotesTranscriptSchema.safeParse(text + char).success, false);
  }
});
it("SQLite retains uncertain fences across model changes, respects exponential cooldown/Retry-After and reuses completed results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ll-gemini-fence-")),
    cache = new WorkspaceCache(directory);
  const originalNow = Date.now;
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const token = cache.claim("old-model", "source-output");
    assert.ok(token);
    assert.throws(
      () => cache.claim("new-model", "source-output"),
      (error) => error.code === "JOB_RECOVERY_REQUIRED",
    );
    cache.fail("old-model", token, "GEMINI_TIMEOUT", false);
    assert.throws(
      () => cache.claim("new-model", "source-output"),
      (error) => error.code === "JOB_RECOVERY_REQUIRED",
    );
    const quota = cache.claim("quota", "other-source");
    cache.fail("quota", quota, "GEMINI_QUOTA", true, 180);
    assert.equal(cache.claim("quota", "other-source"), null);
    let now = originalNow() + 180001;
    Date.now = () => now;
    const second = cache.claim("quota", "other-source");
    assert.ok(second);
    cache.fail("quota", second, "GEMINI_TEMPORARY", true, 1);
    now += 119999;
    assert.equal(cache.claim("quota", "other-source"), null);
    now += 1;
    const third = cache.claim("quota", "other-source");
    assert.ok(third);
    cache.fail("quota", third, "GEMINI_TEMPORARY", true, 1);
    now += 1000000;
    assert.ok(cache.claim("quota", "other-source"));
    Date.now = originalNow;
    Math.random = originalRandom;
    const ready = cache.claim("ready", "ready-source"),
      notebook = {
        schemaVersion: 2,
        title: "Fixture",
        blocks: [{ type: "paragraph", text: "Only source text." }],
        limitations: [],
      };
    cache.finish("ready", ready, notebook);
    assert.deepEqual(cache.material("ready"), notebook);
    assert.equal(cache.claim("ready", "ready-source"), null);
  } finally {
    Date.now = originalNow;
    Math.random = originalRandom;
    cache.close();
    await rm(directory, { recursive: true, force: true });
  }
});
