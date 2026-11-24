import assert from "node:assert/strict";
import { it } from "node:test";
import { spawnSync } from "node:child_process";
import {
  createProviderManager,
  withProviderSelection,
} from "../dist/modules/ai/provider-manager.js";
import { openRouterProvider } from "../dist/modules/ai/openrouter-client.js";
import { freeggTransport } from "../dist/modules/ai/freegg-client.js";
import { envSchema } from "../dist/config/env-schema.js";
import { notebookSchema } from "@lecturelens/contracts";
import { geminiResponseSchema } from "../dist/modules/ai/gemini-schema.js";
import {
  strictProviderSchema,
  restoreOptionalFields,
} from "../dist/modules/ai/structured-schema.js";

const notebook = {
  schemaVersion: 2,
  title: "Recursion",
  blocks: [{ type: "paragraph", text: "A base case terminates recursion." }],
  limitations: [],
};
const input = {
  model: "unused",
  contents: [{ role: "user", parts: [{ text: "An educational question quoted as data." }] }],
  config: {
    systemInstruction: "Return educational JSON.",
    responseJsonSchema: { type: "object" },
    maxOutputTokens: 1024,
    temperature: 0.2,
  },
};
const output = {
  text: JSON.stringify(notebook),
  candidates: [{ finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 21 },
};
const provider = (id, run = async () => output) => ({
  id,
  model: `${id}-fixture`,
  supportsPdf: id === "freegg",
  generateContent: run,
});
const options = (providers, extra = {}) => ({
  primary: "openrouter",
  fallback: "freegg",
  providers,
  concurrency: 1,
  maxQueue: 2,
  intervalMs: 0,
  timeoutMs: 1000,
  retries: 1,
  maxRetryWaitMs: 5000,
  maxOutputTokens: 4096,
  temperature: 0.2,
  ...extra,
});
const noWait = { wait: async () => {}, random: () => 0 };
const openrouter = (fetch) =>
  openRouterProvider(
    {
      key: "synthetic-openrouter-key",
      model: "nvidia/nemotron-3.5-super-vl:free",
      contextTokens: 1000000,
      outputTokens: 65536,
      timeoutMs: 1000,
    },
    fetch,
  );
function success() {
  return new Response(
    JSON.stringify({
      id: "synthetic-response",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: JSON.stringify(notebook) },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 42, completion_tokens: 21, total_tokens: 63 },
    }),
    { headers: { "content-type": "application/json" } },
  );
}
it("OpenRouter sends server-side system/user messages, model, JSON format and bounded output without SDK retries", async () => {
  let calls = 0;
  const primary = openrouter(async (url, init) => {
    calls++;
    assert.equal(String(url), "https://openrouter.ai/api/v1/chat/completions");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), "Bearer synthetic-openrouter-key");
    assert.equal(headers.get("x-title"), "LectureLens");
    const body = JSON.parse(init.body);
    assert.equal(body.model, "nvidia/nemotron-3.5-super-vl:free");
    assert.deepEqual(
      body.messages.map((m) => m.role),
      ["system", "user"],
    );
    assert.equal(body.max_tokens, 1024);
    assert.equal(body.temperature, 0.2);
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.deepEqual(body.provider, { require_parameters: true });
    assert.equal(body.stream, false);
    return success();
  });
  const manager = createProviderManager(
    options({
      openrouter: primary,
      freegg: provider("freegg", () => {
        throw new Error("must not fallback");
      }),
    }),
    noWait,
  );
  const selected = await withProviderSelection(() => manager.generateContent(input));
  assert.equal(selected.value.text, output.text);
  assert.equal(selected.provider, "openrouter");
  assert.equal(calls, 1);
  assert.equal(manager.snapshot().providers.openrouter.inputTokens, 42);
});
it("OpenRouter uses strict schema decoding and restores only nullable optional graph labels", async () => {
  const schema = geminiResponseSchema(notebookSchema);
  const material = {
    ...notebook,
    blocks: [
      {
        type: "diagram",
        title: "Flow",
        nodes: [
          { id: "a", label: "Begin" },
          { id: "b", label: "End" },
        ],
        edges: [{ from: "a", to: "b", label: null }],
      },
    ],
  };
  const primary = openrouter(async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.response_format.type, "json_schema");
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.response_format.json_schema.schema.properties.title.minLength, 1);
    assert.equal(body.response_format.json_schema.schema.properties.title.maxLength, 180);
    assert.equal(body.response_format.json_schema.schema.properties.blocks.maxItems, 160);
    function check(value) {
      if (!value || typeof value !== "object") return;
      if (value.type === "object") {
        assert.equal(value.additionalProperties, false);
        assert.deepEqual(value.required, Object.keys(value.properties));
      }
      for (const child of Object.values(value))
        if (Array.isArray(child)) child.forEach(check);
        else check(child);
    }
    check(body.response_format.json_schema.schema);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(material) }, finish_reason: "stop" }],
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  const response = await primary.generateContent({
    ...input,
    config: { ...input.config, responseJsonSchema: schema },
  });
  const restored = JSON.parse(response.text);
  assert.equal("label" in restored.blocks[0].edges[0], false);
  assert.ok(notebookSchema.safeParse(restored).success);
  assert.deepEqual(strictProviderSchema(schema), strictProviderSchema(schema));
  assert.equal(
    schema.properties.blocks.items.anyOf
      .find((b) => b.properties.type.enum.includes("diagram"))
      .properties.edges.items.required.includes("label"),
    false,
  );
  const invalid = {
    ...material,
    title: null,
    unknown: "never silently removed",
    blocks: [{ type: "diagram", title: "Flow", nodes: [{ id: "a", label: null }], edges: [] }],
  };
  const kept = restoreOptionalFields(invalid, schema);
  assert.equal(kept.title, null);
  assert.equal(kept.unknown, "never silently removed");
  assert.equal(kept.blocks[0].nodes[0].label, null);
  assert.equal(notebookSchema.safeParse(kept).success, false);
  const hostile = restoreOptionalFields(JSON.parse('{"__proto__":{"polluted":true}}'), schema);
  assert.ok(Object.hasOwn(hostile, "__proto__"));
  assert.equal({}.polluted, undefined);
});
it("requests exceeding the configured OpenRouter context never dispatch or fall back", async () => {
  let calls = 0;
  const primary = openRouterProvider(
    {
      key: "synthetic-key",
      model: "nvidia/nemotron-3.5-super-vl:free",
      contextTokens: 1024,
      outputTokens: 65536,
      timeoutMs: 1000,
    },
    async () => {
      calls++;
      throw new Error("must not send oversized request");
    },
  );
  const manager = createProviderManager(
    options({ openrouter: primary, freegg: provider("freegg") }),
    noWait,
  );
  await assert.rejects(
    manager.generateContent(input),
    (e) => e.code === "AI_REQUEST_INVALID" && e.retryable === false,
  );
  assert.equal(calls, 0);
});
it("the final provider can honor one minute Retry-After within the configured bounded wait", async () => {
  let time = 0,
    primaryCalls = 0,
    fallbackCalls = 0;
  const waits = [];
  const manager = createProviderManager(
    options(
      {
        openrouter: provider("openrouter", async () => {
          primaryCalls++;
          throw { status: 429, headers: new Headers({ "retry-after": "120" }) };
        }),
        freegg: provider("freegg", async () => {
          fallbackCalls++;
          if (fallbackCalls === 1)
            throw { status: 429, headers: new Headers({ "retry-after": "60" }) };
          return output;
        }),
      },
      { maxRetryWaitMs: 60000 },
    ),
    {
      now: () => time,
      random: () => 0,
      wait: async (ms) => {
        waits.push(ms);
        time += ms;
      },
    },
  );
  await manager.generateContent(input);
  assert.equal(primaryCalls, 1);
  assert.equal(fallbackCalls, 2);
  assert.ok(waits.includes(60000));
});
it("providers keep independent requested output ceilings", async () => {
  const limits = [];
  const manager = createProviderManager(
    options(
      {
        openrouter: provider("openrouter", async (input) => {
          limits.push(["openrouter", input.config.maxOutputTokens]);
          throw { status: 429 };
        }),
        freegg: provider("freegg", async (input) => {
          limits.push(["freegg", input.config.maxOutputTokens]);
          return output;
        }),
      },
      { openrouterOutputTokens: 8192, freeggOutputTokens: 16384 },
    ),
    noWait,
  );
  await manager.generateContent({ ...input, config: { ...input.config, maxOutputTokens: 16384 } });
  assert.deepEqual(limits, [
    ["openrouter", 8192],
    ["freegg", 16384],
  ]);
});
it("FreeGG uses its documented Responses contract and configured HTTPS base, including usage", async () => {
  const transport = freeggTransport(
    "synthetic-freegg-key",
    async (url, init) => {
      assert.equal(url, "https://freegg.app/v1/responses");
      const body = JSON.parse(init.body);
      assert.equal(body.store, false);
      assert.equal(body.stream, false);
      assert.equal("temperature" in body, false, "GPT reasoning models reject sampling controls");
      return new Response(
        JSON.stringify({
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: output.text }],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 20 },
        }),
      );
    },
    "https://freegg.app/v1/",
  );
  const manager = createProviderManager(
    options(
      { freegg: { ...provider("freegg"), ...transport } },
      { primary: "freegg", fallback: "none" },
    ),
    noWait,
  );
  assert.equal((await manager.generateContent(input)).text, output.text);
  assert.equal(manager.snapshot().providers.freegg.outputTokens, 20);
});
for (const status of [429, 500, 503])
  it(`OpenRouter HTTP ${status} falls back to FreeGG once; raw errors and secrets never enter logs`, async () => {
    let calls = 0,
      fallback = 0;
    const logs = [];
    const primary = openrouter(async () => {
      calls++;
      return new Response(
        JSON.stringify({ error: { message: "PRIVATE_TRANSCRIPT synthetic-openrouter-key" } }),
        { status, headers: { "retry-after": "120" } },
      );
    });
    const manager = createProviderManager(
      options({
        openrouter: primary,
        freegg: provider("freegg", async () => {
          fallback++;
          return output;
        }),
      }),
      { ...noWait, log: (event) => logs.push(event) },
    );
    const result = await withProviderSelection(() => manager.generateContent(input));
    assert.equal(result.provider, "freegg");
    assert.equal(result.value.text, output.text);
    assert.equal(calls, 1);
    assert.equal(fallback, 1);
    assert.doesNotMatch(
      JSON.stringify(logs),
      /PRIVATE_TRANSCRIPT|synthetic-openrouter-key|educational question/,
    );
    await manager.generateContent(input);
    assert.equal(calls, 1);
    assert.equal(fallback, 2); // primary cooldown respects Retry-After
  });
for (const [name, failure] of [
  ["TimeoutError", Object.assign(new Error("timed out"), { name: "TimeoutError" })],
  ["TypeError", new TypeError("fetch failed")],
])
  it(`OpenRouter ${name} has one bounded FreeGG fallback, not a same-key replay`, async () => {
    let calls = 0;
    const primary = openrouter(async () => {
      calls++;
      throw failure;
    });
    const manager = createProviderManager(
      options({ openrouter: primary, freegg: provider("freegg") }),
      noWait,
    );
    assert.equal((await manager.generateContent(input)).text, output.text);
    assert.equal(calls, 1);
  });
it("both providers exhausted return a controlled error with no uncontrolled loop", async () => {
  let calls = 0;
  const run = async () => {
    calls++;
    throw { status: 429, headers: new Headers({ "retry-after": "120" }), message: "SECRET" };
  };
  const manager = createProviderManager(
    options({ openrouter: provider("openrouter", run), freegg: provider("freegg", run) }),
    noWait,
  );
  await assert.rejects(
    manager.generateContent(input),
    (e) =>
      e.code === "AI_UNAVAILABLE" && e.retryAfterSeconds === 120 && !e.message.includes("SECRET"),
  );
  assert.equal(calls, 2);
});
for (const status of [400, 401, 403, 404, 422])
  it(`OpenRouter HTTP ${status} never triggers fallback or retries`, async () => {
    let fallback = 0;
    const manager = createProviderManager(
      options({
        openrouter: openrouter(
          async () => new Response('{"error":{"message":"SECRET"}}', { status }),
        ),
        freegg: provider("freegg", async () => {
          fallback++;
          return output;
        }),
      }),
      noWait,
    );
    await assert.rejects(
      manager.generateContent(input),
      (e) => !e.retryable && !e.message.includes("SECRET"),
    );
    assert.equal(fallback, 0);
  });
it("OpenRouter incomplete and empty completions never return successful partial notes", async () => {
  for (const [finish, content] of [
    ["length", "partial"],
    ["stop", ""],
  ]) {
    const manager = createProviderManager(
      options({
        openrouter: openrouter(
          async () =>
            new Response(
              JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }] }),
              { headers: { "content-type": "application/json" } },
            ),
        ),
        freegg: provider("freegg", () => {
          throw new Error("unexpected fallback");
        }),
      }),
      noWait,
    );
    await assert.rejects(manager.generateContent(input), (e) => e.code === "AI_INVALID_OUTPUT");
  }
});
it("missing secondary key does not prevent primary success; missing primary fails closed", async () => {
  const manager = createProviderManager(options({ openrouter: provider("openrouter") }), noWait);
  assert.equal((await manager.generateContent(input)).text, output.text);
  await assert.rejects(
    createProviderManager(options({ freegg: provider("freegg") }), noWait).generateContent(input),
    (e) => e.code === "AI_CONFIGURATION",
  );
});
it("original PDFs route directly to FreeGG, never to text-only OpenRouter", async () => {
  let primary = 0,
    fallback = 0;
  const manager = createProviderManager(
    options({
      openrouter: provider("openrouter", async () => {
        primary++;
        return output;
      }),
      freegg: provider("freegg", async (request) => {
        fallback++;
        assert.equal(request.contents[0].parts[0].inlineData.data, "cGRm");
        return output;
      }),
    }),
    noWait,
  );
  await manager.generateContent({
    ...input,
    contents: [{ parts: [{ inlineData: { mimeType: "application/pdf", data: "cGRm" } }] }],
  });
  assert.equal(primary, 0);
  assert.equal(fallback, 1);
});
it("bounded backoff respects Retry-After and retries only the failed request", async () => {
  let calls = 0,
    clock = 0;
  const waits = [];
  const manager = createProviderManager(
    options(
      {
        openrouter: provider("openrouter", async () => {
          if (++calls === 1) throw { status: 503, headers: new Headers({ "retry-after": "2" }) };
          return output;
        }),
      },
      { fallback: "none" },
    ),
    {
      now: () => clock,
      random: () => 0,
      wait: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    },
  );
  await manager.generateContent(input);
  assert.equal(calls, 2);
  assert.ok(waits.includes(2000));
});
it("queue bounds, waiting cancellation and client disconnect prevent extra dispatch", async () => {
  let finish,
    calls = 0;
  const manager = createProviderManager(
    options(
      {
        openrouter: provider("openrouter", () => {
          calls++;
          return new Promise((resolve) => {
            finish = resolve;
          });
        }),
      },
      { maxQueue: 1 },
    ),
    noWait,
  );
  const first = manager.generateContent(input);
  await new Promise((resolve) => setImmediate(resolve));
  const controller = new AbortController();
  const queued = manager.generateContent({
    ...input,
    config: { ...input.config, abortSignal: controller.signal },
  });
  await assert.rejects(manager.generateContent(input), (e) => e.code === "AI_BUSY");
  controller.abort();
  await assert.rejects(queued);
  finish(output);
  await first;
  assert.equal(calls, 1);
  assert.equal(manager.snapshot().active, 0);
  assert.equal(manager.snapshot().queued, 0);
});
it("environment validates booleans/providers/models/URL and does not require secondary credentials", () => {
  const parsed = envSchema.parse({ OPENROUTER_API_KEY: "synthetic-key" });
  assert.equal(parsed.AI_PROVIDER, "openrouter");
  assert.equal(parsed.OPENROUTER_MODEL, "nvidia/nemotron-3.5-super-vl:free");
  assert.equal(parsed.FREEGG_API_KEY, undefined);
  assert.equal(
    envSchema.parse({ AI_PROVIDER: "gemini", AI_PRIMARY_PROVIDER: "" }).AI_PRIMARY_PROVIDER,
    undefined,
  );
  assert.equal(
    envSchema.safeParse({
      AI_PROVIDER: "gemini",
      AI_PRIMARY_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "synthetic-key",
      GEMINI_API_KEY: "synthetic_key_12345678",
    }).success,
    true,
  );
  assert.equal(
    envSchema.parse({
      OPENROUTER_API_KEY: "synthetic-key",
      FREEGG_API_KEY: "",
      FREEGG_BASE_URL: "",
      FREEGG_MODEL: "",
    }).FREEGG_BASE_URL,
    "https://freegg.app/v1",
  );
  assert.equal(
    envSchema.parse({ AI_PRIMARY_PROVIDER: "groq" }).AI_PRIMARY_PROVIDER,
    "openrouter",
    "legacy groq selection maps to the replacement route",
  );
  for (const value of [
    { AI_PRIMARY_PROVIDER: "invalid" },
    { AI_FALLBACK_PROVIDER: "gemini" },
    { OPENROUTER_ENABLED: "yes" },
    { OPENROUTER_API_KEY: "Bearer secret" },
    { OPENROUTER_MODEL: "not a model" },
    { FREEGG_BASE_URL: "http://freegg.app/v1" },
    { FREEGG_BASE_URL: "https://key:secret@freegg.app/v1" },
    { FREEGG_BASE_URL: "https://127.0.0.1/v1" },
    { FREEGG_BASE_URL: "https://freegg.app/v1?key=secret" },
    { AI_MAX_CONCURRENCY: 100 },
    { AI_CHUNK_OVERLAP_TOKENS: 1000, AI_CHUNK_TOKENS: 1000 },
  ])
    assert.equal(envSchema.safeParse(value).success, false);
});
it("concurrent waiting dispatch rechecks a new provider cooldown before sending", async () => {
  let rejectPrimary,
    releaseWait,
    calls = 0,
    held = false;
  const manager = createProviderManager(
    options(
      {
        openrouter: provider("openrouter", () => {
          calls++;
          return new Promise((_, reject) => {
            rejectPrimary = reject;
          });
        }),
        freegg: provider("freegg"),
      },
      { concurrency: 2, intervalMs: 1000 },
    ),
    {
      now: () => 0,
      random: () => 0,
      wait: async (ms) => {
        if (ms > 0 && !held) {
          held = true;
          await new Promise((resolve) => {
            releaseWait = resolve;
          });
        }
      },
    },
  );
  const first = manager.generateContent(input),
    second = manager.generateContent(input);
  await new Promise((resolve) => setImmediate(resolve));
  rejectPrimary({ status: 429, headers: new Headers({ "retry-after": "120" }) });
  await first;
  releaseWait();
  await second;
  assert.equal(calls, 1);
});
it("non-numeric upstream usage cannot expose echoed secrets through metrics logs", async () => {
  const logs = [];
  const manager = createProviderManager(
    options({
      openrouter: provider("openrouter", async () => ({
        ...output,
        usageMetadata: { promptTokenCount: "SECRET", candidatesTokenCount: -1 },
      })),
    }),
    { ...noWait, log: (event) => logs.push(event) },
  );
  await manager.generateContent(input);
  assert.equal(manager.snapshot().providers.openrouter.inputTokens, 0);
  assert.equal(manager.snapshot().providers.openrouter.outputTokens, 0);
  assert.doesNotMatch(JSON.stringify(logs), /SECRET/);
});
it("configured default missing OpenRouter key returns configuration error without touching Gemini or networking", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import assert from 'node:assert/strict';globalThis.fetch=()=>{throw new Error('NETWORK_NOT_ALLOWED')};const {getConfiguredStudyGemini,getConfiguredTutorGemini}=await import('./dist/modules/ai/gemini-study.js');assert.throws(()=>getConfiguredStudyGemini(),e=>e.code==='AI_CONFIGURATION');assert.equal(getConfiguredTutorGemini().model,'gemini-3.5-flash-lite');`,
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: "test",
        AI_PROVIDER: "openrouter",
        AI_PRIMARY_PROVIDER: "openrouter",
        OPENROUTER_API_KEY: "",
        FREEGG_API_KEY: "",
        GEMINI_API_KEY: "synthetic_key_12345678",
        GEMINI_BACKUP_API_KEY: "",
        GEMINI_MODEL: "",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr.toString());
});
