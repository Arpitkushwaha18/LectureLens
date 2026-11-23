// Local-only end-to-end control using a saved real provider response and real Gemini.
// Persistent isolated jobs retain paid-request evidence; no app history is modified.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { config } from "dotenv";
import { parseYouTubeUrl, workspaceEventSchema } from "@lecturelens/contracts";
import { createDatabase, embeddedRepository } from "../tests/helpers/database.mjs";
config({ quiet: true });
const { createTranscriptFetchProvider } =
  await import("../dist/modules/extraction/transcriptfetch-transcript.js");
const { createFencedTranscriptProvider } =
  await import("../dist/services/transcript-extraction.service.js");
const { createWorkspaceService } = await import("../dist/services/workspace.service.js");
const { getConfiguredStudyGemini } = await import("../dist/modules/ai/gemini-study.js");
const { WorkspaceCache } = await import("../dist/repositories/workspace-cache.js");
const { createVideoVerifier } = await import("../dist/services/video-verification.js");
const source = parseYouTubeUrl(process.argv[2]);
if (!process.argv.includes("--generate"))
  throw new Error("Explicit --generate is required for real Gemini generation.");
const directory = resolve(".cache", `lecture-test-${source.videoId}`);
const recorded = JSON.parse(await readFile(resolve(directory, "provider-response.json"), "utf8"));
await mkdir(resolve(directory, "workflow"), { recursive: true, mode: 0o700 });
const db = new PGlite(resolve(directory, "workflow", "postgres"));
const cache = new WorkspaceCache(resolve(directory, "workflow", "cache"));
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await originalFetch(...args);
  const target = args[0] instanceof Request ? args[0].url : String(args[0]);
  if (target.includes(":generateContent") && !response.ok)
    await writeFile(
      resolve(directory, `gemini-error-${Date.now()}.json`),
      await response.clone().text(),
      { mode: 0o600 },
    );
  return response;
};
try {
  if (
    !(
      await db.query(
        "select to_regprocedure('public.finish_automatic_captions(uuid,uuid,text,jsonb)') as value",
      )
    ).rows[0].value
  ) {
    await createDatabase(7, db);
    for (const name of [
      "20261122000900_automatic_captions.sql",
      "20261122001100_final_youtube_workflow.sql",
      "20261122001200_caption_retry_safety.sql",
      "20261122001300_long_lecture_transcripts.sql",
    ])
      await db.exec(
        await readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), "utf8"),
      );
  }
  const scalar = async (sql, params = []) => (await db.query(sql, params)).rows[0]?.value;
  const resources = {
    ...embeddedRepository(db),
    findBestTranscript: async (id) =>
      (
        await db.query(
          "select id,text_content,content_hash,provenance,metadata,language from public.transcripts where source_id=$1 order by version desc limit 1",
          [id],
        )
      ).rows[0] ?? null,
  };
  const jobs = {
    reserve: async (id) =>
      (await db.query("select * from public.reserve_automatic_captions($1)", [id])).rows[0],
    recordRun: (id, _language, token, run) =>
      scalar("select public.record_automatic_caption_run($1,$2,$3) as value", [id, token, run]),
    finish: (id, _language, token, text, metadata) =>
      scalar("select public.finish_automatic_captions($1,$2,$3,$4::jsonb) as value", [
        id,
        token,
        text,
        JSON.stringify(metadata),
      ]),
    fail: (id, _language, token, code) =>
      scalar("select public.fail_automatic_captions($1,$2,$3) as value", [id, token, code]),
  };
  const notesStore = {
    claim: (v, t, o, m, p, c) =>
      scalar("select public.claim_youtube_notebook($1,$2,$3,$4,$5,2,$6) as value", [
        v,
        t,
        o,
        m,
        p,
        c,
      ]),
    evidence: async (i, t, e, n) =>
      assert.equal(
        await scalar(
          "select public.youtube_notebook_evidence($1,$2,$3::jsonb,$4::jsonb) as value",
          [i, t, JSON.stringify(e), n ? JSON.stringify(n) : null],
        ),
        true,
      ),
    finish: async (i, t, n) =>
      assert.equal(
        await scalar("select public.finish_youtube_notebook($1,$2,$3::jsonb) as value", [
          i,
          t,
          JSON.stringify(n),
        ]),
        true,
      ),
    fail: async (i, t, c, s) =>
      assert.equal(
        await scalar("select public.fail_youtube_notebook($1,$2,$3,$4) as value", [i, t, c, s]),
        true,
      ),
  };
  const raw = createTranscriptFetchProvider(
    { apiKey: process.env.TRANSCRIPTFETCH_API_KEY },
    { maxRetries: 0, fetch: async () => new Response(recorded.body, { status: recorded.status }) },
  );
  const verifier = createVideoVerifier();
  const verified = await verifier.verify(source.canonicalUrl);
  const workflow = createWorkspaceService({
    resources,
    notesStore,
    provider: createFencedTranscriptProvider(raw, resources, jobs),
    cache: () => cache,
    gemini: getConfiguredStudyGemini,
    verify: verifier.assert,
  });
  const outputs = process.argv.includes("--quiz-only")
    ? ["mcq_quiz"]
    : ["detailed_notes", "mcq_quiz"];
  const events = [];
  const result = await workflow(
    {
      sourceType: "youtube",
      url: source.canonicalUrl,
      verificationToken: verified.verificationToken,
      outputTypes: outputs,
      quizCount: 10,
    },
    undefined,
    (event) => {
      workspaceEventSchema.parse(event);
      events.push(event);
      if (event.event === "stage")
        console.log(
          JSON.stringify({
            stage: event.stage,
            output: event.outputType,
            status: event.outputStatus,
          }),
        );
    },
  );
  await writeFile(resolve(directory, "workflow-result.json"), JSON.stringify(result), {
    mode: 0o600,
  });
  assert.equal(result.status, "ready");
  for (const material of result.materials) {
    assert.equal(material.language, "en");
    assert.doesNotMatch(JSON.stringify(material.notebook), /[\u0900-\u097f]/u);
  }
  assert.equal(
    result.materials
      .find((m) => m.outputType === "mcq_quiz")
      .notebook.blocks.filter((b) => b.type === "quiz").length,
    10,
  );
  assert.equal(
    events.some((e) => e.event === "progress" && e.percent === 100),
    true,
  );
  console.log(
    JSON.stringify({
      status: result.status,
      characters: (await resources.findBestTranscript(await resources.ensureSource(source.videoId)))
        .text_content.length,
      materials: result.materials.map((m) => ({
        output: m.outputType,
        language: m.language,
        cached: m.cached,
        blocks: m.notebook.blocks.length,
      })),
      transcriptRequests: 0,
      realGemini: true,
    }),
  );
} finally {
  globalThis.fetch = originalFetch;
  cache.close();
  await db.close();
}
