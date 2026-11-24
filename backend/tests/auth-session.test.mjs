import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { it } from "node:test";
it("mocked Supabase auth coalesces refreshes and sets bounded HTTPS HTTP-only cookies without leaking upstream errors", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    let calls=0, rejected=false;
    const user={id:'11111111-1111-4111-8111-111111111111',aud:'authenticated',role:'authenticated',email:'fixture@example.test',created_at:new Date().toISOString(),app_metadata:{},user_metadata:{}};
    const jwt='eyJhbGciOiJIUzI1NiJ9.'+Buffer.from(JSON.stringify({sub:user.id,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.fixture';
    globalThis.fetch=async(input,init)=>{
      assert.equal(new URL(String(input)).hostname,'synthetic.supabase.test');
      assert.ok(init.signal); calls++;
      if(rejected) return Response.json({msg:'SECRET_UPSTREAM_DETAIL'},{status:400});
      return Response.json({access_token:jwt,refresh_token:'synthetic_rotated_refresh_token',expires_in:3600,token_type:'bearer',user});
    };
    const {authenticate,refreshSession}=await import('./dist/services/auth.service.js');
    const session=await authenticate('login',{email:user.email,password:'synthetic-password'});
    assert.equal(session.user.id,user.id);
    const before=calls, first=refreshSession('synthetic_original_refresh');
    const second=refreshSession('synthetic_original_refresh');
    assert.equal(first,second); assert.equal((await first).user.id,user.id); assert.equal(calls,before+1);
    const {writeAuthSession,clearSession}=await import('./dist/services/study-session.js');
    const cookies=[],res={cookie:(name,value,options)=>cookies.push({name,options}),clearCookie:(name,options)=>cookies.push({name,options})};
    writeAuthSession(res,session);
    assert.equal(cookies[0].options.maxAge,3600000);assert.equal(cookies[1].options.maxAge,30*86400000);
    for(const cookie of cookies){assert.equal(cookie.options.secure,true);assert.equal(cookie.options.httpOnly,true);assert.equal(cookie.options.sameSite,'none');}
    clearSession(res);assert.equal(cookies.length,4);
    rejected=true;
    await assert.rejects(()=>authenticate('login',{email:user.email,password:'synthetic-password'}),e=>e.code==='AUTH_FAILED'&&!e.message.includes('SECRET_UPSTREAM_DETAIL'));
  `,
    ],
    {
      cwd: process.cwd(),
      timeout: 20000,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "production",
        LOG_LEVEL: "silent",
        LIBRARY_STORE: "supabase",
        SESSION_SAME_SITE: "none",
        SUPABASE_URL: "https://synthetic.supabase.test",
        SUPABASE_SECRET_KEY: "sb_secret_synthetic_fixture_only",
        GEMINI_API_KEY: "",
        GEMINI_MODEL: "",
        FREEGG_API_KEY: "",
        TRANSCRIPTFETCH_API_KEY: "",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
});
