import assert from "node:assert/strict";
import { it } from "node:test";
import { spawnSync } from "node:child_process";
import { envSchema } from "../dist/config/env-schema.js";
import { tutorAnswerMode, tutorInputSchema } from "../dist/services/temporary-workspace.service.js";
it("Auto selects quick answers unless detail is requested; explicit selection wins", () => {
  assert.equal(tutorAnswerMode("what is recursion", "auto"), "quick");
  assert.equal(tutorAnswerMode("Explain recursion in detail", "auto"), "detailed");
  assert.equal(tutorAnswerMode("a comprehensive explanation", "quick"), "quick");
  assert.equal(tutorAnswerMode("what is recursion", "detailed"), "detailed");
  assert.equal(tutorInputSchema.parse({ prompt: "what is recursion" }).answerMode, "auto");
  assert.equal(
    tutorInputSchema.safeParse({ prompt: "question", answerMode: "invalid" }).success,
    false,
  );
});
it("FreeGG study mode accepts a tutor-only Gemini key and validates the separate model", () => {
  const parsed = envSchema.parse({
    AI_PROVIDER: "freegg",
    GEMINI_API_KEY: "synthetic_key_12345678",
  });
  assert.equal(parsed.GEMINI_TUTOR_MODEL, "gemini-3.5-flash-lite");
  assert.equal(parsed.GEMINI_MODEL, undefined);
  assert.equal(envSchema.safeParse({ GEMINI_TUTOR_MODEL: "gemini-flash-latest" }).success, false);
  assert.equal(
    envSchema.safeParse({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "synthetic_key_12345678" })
      .success,
    false,
  );
});
it("Ask doubts selects Gemini Flash-Lite independently of FreeGG and uses a fast budget", () => {
  const code = `
    import assert from 'node:assert/strict';
    let calls=0;
    globalThis.fetch=async(input,init)=>{
      calls++;
      const request=input instanceof Request ? input : new Request(input,init);
      assert.equal(new URL(request.url).origin,'https://generativelanguage.googleapis.com');
      assert.ok(request.url.includes('gemini-3.5-flash-lite'));
      if(request.method==='POST') {
        const body=await request.json();
         assert.equal(body.generationConfig.maxOutputTokens,1024);
        assert.equal(body.generationConfig.thinkingConfig.thinkingLevel,'MINIMAL');
         assert.ok(JSON.stringify(body.generationConfig.responseJsonSchema).length<1000);
         return new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"title":"Tutor","paragraphs":["Mocked Gemini answer."]}'}]}}]}));
      }
      return new Response(JSON.stringify({name:'models/gemini-3.5-flash-lite',supportedGenerationMethods:['generateContent'],inputTokenLimit:32000,outputTokenLimit:4096}));
    };
    const {getConfiguredTutorGemini,getConfiguredStudyGemini}=await import('./dist/modules/ai/gemini-study.js');
    assert.equal(getConfiguredStudyGemini().model,'freegg:gpt-6.1-sol');
    const tutor=getConfiguredTutorGemini();
    assert.equal(tutor.model,'gemini-3.5-flash-lite');
    await tutor.generate('Explain recursion.','detailed_notes',{task:'tutor'});
     assert.equal(calls,1);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      AI_PROVIDER: "freegg",
      AI_PRIMARY_PROVIDER: "freegg",
      AI_FALLBACK_PROVIDER: "none",
      OPENROUTER_API_KEY: "",
      GEMINI_API_KEY: "synthetic_key_12345678",
      GEMINI_BACKUP_API_KEY: "",
      GEMINI_MODEL: "",
      GEMINI_TUTOR_MODEL: "gemini-3.5-flash-lite",
      FREEGG_API_KEY: "fixture-secret",
      FREEGG_MODEL: "gpt-6.1-sol",
    },
  });
  assert.equal(result.status, 0, result.stderr.toString());
});
it("missing Gemini tutor key fails without contacting FreeGG", () => {
  const code = `globalThis.fetch=()=>{throw new Error('NETWORK_NOT_ALLOWED')};const {getConfiguredTutorGemini}=await import('./dist/modules/ai/gemini-study.js');try{getConfiguredTutorGemini();process.exit(1)}catch(error){if(error.code!=='GEMINI_NOT_CONFIGURED')throw error}`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      AI_PROVIDER: "freegg",
      AI_PRIMARY_PROVIDER: "freegg",
      AI_FALLBACK_PROVIDER: "none",
      OPENROUTER_API_KEY: "",
      GEMINI_API_KEY: "",
      GEMINI_BACKUP_API_KEY: "",
      GEMINI_MODEL: "",
      FREEGG_API_KEY: "fixture-secret",
    },
  });
  assert.equal(result.status, 0, result.stderr.toString());
});
function isolated(code) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      AI_PROVIDER: "freegg",
      AI_PRIMARY_PROVIDER: "freegg",
      AI_FALLBACK_PROVIDER: "none",
      OPENROUTER_API_KEY: "",
      GEMINI_API_KEY: "synthetic_key_12345678",
      GEMINI_BACKUP_API_KEY: "",
      GEMINI_MODEL: "",
      GEMINI_TUTOR_MODEL: "gemini-3.5-flash-lite",
      FREEGG_API_KEY: "fixture-secret",
      FREEGG_MODEL: "gpt-6.1-sol",
    },
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr.toString() + result.stdout.toString());
}
it("Detailed Ask in explicitly selected FreeGG mode respects its independent output ceiling and store:false", () => {
  isolated(`
    import assert from 'node:assert/strict';
    let calls=0;
    globalThis.fetch=async(url,init)=>{
      calls++; assert.equal(String(url),'https://freegg.app/v1/responses');
      const body=JSON.parse(init.body); assert.equal(body.model,'gpt-6.1-sol'); assert.equal(body.store,false); assert.equal(body.max_output_tokens,8192);
      return new Response(JSON.stringify({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({schemaVersion:2,title:'Recursion',blocks:[{type:'paragraph',text:'A recursive function calls itself until its base case.'}],limitations:[]})}]}]}));
    };
    const {askTemporaryTutor}=await import('./dist/services/temporary-workspace.service.js');
    const r=await askTemporaryTutor({prompt:'Explain recursion in detail'}); assert.equal(r.provider,'FreeGG'); assert.equal(r.answerMode,'detailed'); assert.equal(calls,1);
  `);
});
it("Quick Ask retries a temporary 503 once and converts its small JSON answer", () => {
  isolated(`
    import assert from 'node:assert/strict'; let calls=0;
    globalThis.fetch=async()=>{calls++;return calls===1 ? new Response(JSON.stringify({error:{status:'UNAVAILABLE'}}),{status:503}) : new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({title:'Recursion',paragraphs:['Recursion stops at its base case.']})}]}}]}));};
    const {askTemporaryTutor}=await import('./dist/services/temporary-workspace.service.js'); const r=await askTemporaryTutor({prompt:'what is recursion'}); assert.equal(calls,2); assert.equal(r.provider,'Gemini'); assert.equal(r.notebook.blocks[0].type,'paragraph');
  `);
});
it("Quick Ask does not retry quota, Retry-After or uncertain network failures", () => {
  isolated(`
    import assert from 'node:assert/strict';
    const {askTemporaryTutor}=await import('./dist/services/temporary-workspace.service.js');
    for (const [status,headers] of [[429,{}],[503,{'retry-after':'60'}]]) {
      let calls=0;globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({error:{status:'UNAVAILABLE'}}),{status,headers});};
      await assert.rejects(()=>askTemporaryTutor({prompt:'what is recursion'})); assert.equal(calls,1);
    }
    let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('unknown network failure');};
    await assert.rejects(()=>askTemporaryTutor({prompt:'what is recursion'})); assert.equal(calls,1);
  `);
});
it("Busy Gemini stops after two attempts with a safe useful error", () => {
  isolated(`
    import assert from 'node:assert/strict';let calls=0;globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({error:{status:'UNAVAILABLE',message:'SECRET_INPUT'}}),{status:503});};
    const {askTemporaryTutor}=await import('./dist/services/temporary-workspace.service.js');
    await assert.rejects(()=>askTemporaryTutor({prompt:'what is recursion'}),e=>e.code==='GEMINI_TEMPORARY'&&/Gemini is busy/.test(e.message)&&!e.message.includes('SECRET_INPUT'));assert.equal(calls,2);
  `);
});
