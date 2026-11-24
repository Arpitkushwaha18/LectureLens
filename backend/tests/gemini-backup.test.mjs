import assert from "node:assert/strict";
import { it } from "node:test";
import { spawnSync } from "node:child_process";
import { createGeminiTutorFailover } from "../dist/modules/ai/gemini-tutor.js";
import { NotesGenerationError } from "../dist/modules/ai/gemini-notes.js";
import { envSchema } from "../dist/config/env-schema.js";
const answer = {
  schemaVersion: 2,
  title: "Recursion",
  blocks: [{ type: "paragraph", text: "Recursion stops at a base case." }],
  limitations: [],
};

it("optional backup key is accepted only as backend configuration", () => {
  assert.equal(envSchema.parse({ GEMINI_BACKUP_API_KEY: "" }).GEMINI_BACKUP_API_KEY, undefined);
  assert.equal(
    envSchema.parse({ GEMINI_BACKUP_API_KEY: "synthetic-backup-secret" }).GEMINI_BACKUP_API_KEY,
    "synthetic-backup-secret",
  );
  for (const key of ["short", "synthetic backup secret", "x".repeat(4097)])
    assert.equal(envSchema.safeParse({ GEMINI_BACKUP_API_KEY: key }).success, false);
});
it("successful primary does not dispatch a backup", async () => {
  const calls = [];
  const generate = createGeminiTutorFailover(
    async () => {
      calls.push("primary");
      return answer;
    },
    async () => {
      calls.push("backup");
      return answer;
    },
  );
  assert.equal(await generate("what is recursion"), answer);
  assert.deepEqual(calls, ["primary"]);
});
it("explicit primary rejections use one backup; primary-key cooldown skips repeated rejection", async () => {
  for (const code of [
    "GEMINI_TEMPORARY",
    "GEMINI_QUOTA",
    "GEMINI_CREDENTIALS",
    "GEMINI_MODEL_NOT_FOUND",
  ]) {
    const calls = [];
    const generate = createGeminiTutorFailover(
      async () => {
        calls.push("primary");
        throw new NotesGenerationError(code, "synthetic", true, 503, 60);
      },
      async () => {
        calls.push("backup");
        return answer;
      },
    );
    assert.equal(await generate("question one"), answer);
    assert.equal(await generate("question two"), answer);
    assert.deepEqual(calls, ["primary", "backup", "backup"]);
  }
});
it("backup failure stops; uncertain network/timeouts never cause duplicate dispatch", async () => {
  for (const code of [
    "GEMINI_TIMEOUT",
    "GEMINI_CONNECTION",
    "GEMINI_UNCERTAIN",
    "GEMINI_REQUEST_INVALID",
  ]) {
    let backupCalls = 0;
    const generate = createGeminiTutorFailover(
      async () => {
        throw new NotesGenerationError(code, "synthetic");
      },
      async () => {
        backupCalls++;
        return answer;
      },
    );
    await assert.rejects(() => generate("what is recursion"));
    assert.equal(backupCalls, 0);
  }
  let calls = 0;
  const generate = createGeminiTutorFailover(
    async () => {
      calls++;
      throw new NotesGenerationError("GEMINI_TEMPORARY", "synthetic");
    },
    async () => {
      calls++;
      throw new NotesGenerationError("GEMINI_TEMPORARY", "synthetic");
    },
  );
  await assert.rejects(() => generate("what is recursion"));
  assert.equal(calls, 2);
});
function isolated(code, primary = "synthetic-primary-secret", backup = "synthetic-backup-secret") {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      LOG_LEVEL: "warn",
      AI_PROVIDER: "freegg",
      GEMINI_API_KEY: primary,
      GEMINI_BACKUP_API_KEY: backup,
      GEMINI_MODEL: "",
      GEMINI_TUTOR_MODEL: "gemini-3.5-flash-lite",
    },
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr.toString() + result.stdout.toString());
  const output = result.stderr.toString() + result.stdout.toString();
  assert.ok(!output.includes("PRIVATE_QUESTION"));
  for (const secret of [primary, backup].filter(Boolean)) assert.ok(!output.includes(secret));
}
it("configured failover sends independent keys in headers only, no same-key retry or prompt logs", () => {
  isolated(`
    import assert from 'node:assert/strict'; const keys=[];
    globalThis.fetch=async(input,init)=>{
      const request=new Request(input,init); const key=request.headers.get('x-goog-api-key'); keys.push(key);
      assert.equal(new URL(request.url).origin,'https://generativelanguage.googleapis.com');
      const body=await request.json();assert.equal(body.generationConfig.maxOutputTokens,1024);assert.ok(!JSON.stringify(body).includes(key));
      if(keys.length===1)return new Response(JSON.stringify({error:{message:'synthetic-primary-secret PRIVATE_QUESTION'}}),{status:503});
      return new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"title":"Recursion","paragraphs":["A base case stops recursion."]}'}]}}]}));
    };
    const {askTemporaryTutor}=await import('./dist/services/temporary-workspace.service.js');
    const r=await askTemporaryTutor({prompt:'PRIVATE_QUESTION what is recursion'});assert.equal(r.provider,'Gemini');assert.deepEqual(keys,['synthetic-primary-secret','synthetic-backup-secret']);
  `);
});
it("same-key configuration does not add a second fallback; backup alone can run Quick Ask", () => {
  const script = `
    import assert from 'node:assert/strict';let calls=0;globalThis.fetch=async(input,init)=>{calls++;return new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"title":"Recursion","paragraphs":["A base case stops recursion."]}'}]}}]}));};
    const {askTemporaryTutor}=await import('./dist/services/temporary-workspace.service.js');assert.equal((await askTemporaryTutor({prompt:'what is recursion'})).provider,'Gemini');assert.equal(calls,1);
  `;
  isolated(script, "synthetic-primary-secret", "synthetic-primary-secret");
  isolated(script, "", "synthetic-backup-secret");
});
