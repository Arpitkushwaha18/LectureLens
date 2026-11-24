import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { readSupabaseBrowserConfig } from "../.cache/workspace-tests/lib/supabase-env.js";

const configured = {
  VITE_SUPABASE_URL: "https://fixture.supabase.co",
  VITE_SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${"x".repeat(24)}`,
};
describe("B2 browser environment validation", () => {
  it("unprefixed backend OpenRouter/FreeGG keys never enter a real frontend production bundle", async () => {
    const openrouter = "synthetic_openrouter_backend_only_never_public",
      freegg = "synthetic_freegg_backend_only_never_public";
    const result = spawnSync(
      process.execPath,
      ["node_modules/vite/bin/vite.js", "build", "--outDir", ".cache/provider-secret-build"],
      {
        cwd: new URL("..", import.meta.url),
        env: { ...process.env, OPENROUTER_API_KEY: openrouter, FREEGG_API_KEY: freegg },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const directory = new URL("../.cache/provider-secret-build/assets/", import.meta.url);
    for (const file of await readdir(directory)) {
      if (!/\.(js|css)$/.test(file)) continue;
      const content = await readFile(new URL(file, directory), "utf8");
      assert.ok(!content.includes(openrouter));
      assert.ok(!content.includes(freegg));
    }
    assert.ok(!`${result.stdout}${result.stderr}`.includes(openrouter));
    assert.ok(!`${result.stdout}${result.stderr}`.includes(freegg));
  });
  for (const name of ["VITE_OPENROUTER_API_KEY", "VITE_FREEGG_API_KEY"]) {
    it(`blocks ${name} before production bundling without exposing its value`, () => {
      const fixture = "synthetic_server_only_key_never_bundle";
      const result = spawnSync(process.execPath, ["node_modules/vite/bin/vite.js", "build"], {
        cwd: new URL("..", import.meta.url),
        env: { ...process.env, [name]: fixture },
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes("Invalid public Supabase configuration"));
      assert.ok(!`${result.stdout}${result.stderr}`.includes(fixture));
      assert.equal(readSupabaseBrowserConfig({ [name]: fixture }).status, "invalid");
    });
  }
  it("rejects a VITE TranscriptFetch key before bundling without exposing it", () => {
    const fixture = "tf_live_synthetic_never_bundle";
    const result = spawnSync(process.execPath, ["node_modules/vite/bin/vite.js", "build"], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, VITE_TRANSCRIPTFETCH_API_KEY: fixture },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes("Invalid public Supabase configuration"));
    assert.ok(!`${result.stdout}${result.stderr}`.includes(fixture));
  });
  it("blocks a VITE secret before production bundling without printing its value", () => {
    const fixture = `sb_secret_${"not_a_real_key_".repeat(3)}`;
    const result = spawnSync(process.execPath, ["node_modules/vite/bin/vite.js", "build"], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, VITE_SUPABASE_SECRET_KEY: fixture },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes("Invalid public Supabase configuration"));
    assert.ok(!`${result.stdout}${result.stderr}`.includes(fixture));
  });
  it("keeps the workspace functional without public project configuration", () => {
    assert.deepEqual(readSupabaseBrowserConfig({}), { status: "disabled" });
    assert.deepEqual(
      readSupabaseBrowserConfig({ VITE_SUPABASE_URL: "", VITE_SUPABASE_PUBLISHABLE_KEY: "" }),
      { status: "disabled" },
    );
  });
  it("accepts public keys and HTTPS project URLs", () =>
    assert.equal(readSupabaseBrowserConfig(configured).status, "configured"));
  it("supports local Supabase without allowing public HTTP endpoints", () => {
    assert.equal(
      readSupabaseBrowserConfig({ ...configured, VITE_SUPABASE_URL: "http://127.0.0.1:54321" })
        .status,
      "configured",
    );
    assert.equal(
      readSupabaseBrowserConfig({ ...configured, VITE_SUPABASE_URL: "http://fixture.supabase.co" })
        .status,
      "invalid",
    );
  });
  it("rejects partial configuration and server keys", () => {
    assert.equal(
      readSupabaseBrowserConfig({ VITE_APIFY_API_TOKEN: "never-bundle" }).status,
      "invalid",
    );
    assert.equal(
      readSupabaseBrowserConfig({ VITE_TRANSCRIPTFETCH_API_KEY: "never-bundle" }).status,
      "invalid",
    );
    assert.equal(
      readSupabaseBrowserConfig({ VITE_GEMINI_API_KEY: "never-bundle" }).status,
      "invalid",
    );
    assert.equal(
      readSupabaseBrowserConfig({ VITE_SUPABASE_URL: configured.VITE_SUPABASE_URL }).status,
      "invalid",
    );
    assert.equal(
      readSupabaseBrowserConfig({
        ...configured,
        VITE_SUPABASE_PUBLISHABLE_KEY: `sb_secret_${"x".repeat(24)}`,
      }).status,
      "invalid",
    );
    assert.equal(
      readSupabaseBrowserConfig({ ...configured, VITE_SUPABASE_SECRET_KEY: "do-not-bundle" })
        .status,
      "invalid",
    );
    assert.equal(
      readSupabaseBrowserConfig({ VITE_SUPABASE_SERVICE_ROLE_KEY: "do-not-bundle" }).status,
      "invalid",
    );
    assert.equal(
      readSupabaseBrowserConfig({ ...configured, VITE_OTHER_KEY: `sb_secret_${"x".repeat(24)}` })
        .status,
      "invalid",
    );
  });
  it("rejects credentials, paths and tokens embedded in the URL without echoing them", () => {
    for (const url of [
      "https://user:password@fixture.supabase.co",
      "https://fixture.supabase.co/auth",
      "https://fixture.supabase.co?secret=fixture",
      "not-a-url",
    ]) {
      assert.deepEqual(readSupabaseBrowserConfig({ ...configured, VITE_SUPABASE_URL: url }), {
        status: "invalid",
      });
    }
  });
});
