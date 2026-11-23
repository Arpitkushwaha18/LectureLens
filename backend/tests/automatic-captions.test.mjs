import assert from "node:assert/strict";
import { it } from "node:test";
import { readFile } from "node:fs/promises";
import { createDatabase, embeddedRepository } from "./helpers/database.mjs";
import { parseYouTubeUrl } from "@lecturelens/contracts";
import { createTranscriptFetchProvider } from "../dist/modules/extraction/transcriptfetch-transcript.js";
import { createFencedTranscriptProvider } from "../dist/services/transcript-extraction.service.js";
it("automatic captions preserve arbitrary provider languages without translation, audio or SDK retries", async () => {
  for (const language of ["es", "fr", "ja", "zh-Hant", "ar", "de", "hi"]) {
    let calls = 0;
    const provider = createTranscriptFetchProvider(
      { apiKey: "tf_live_synthetic_test_only" },
      {
        fetch: async (url, init) => {
          calls++;
          assert.equal(JSON.parse(init.body).mode, "captions");
          return new Response(
            JSON.stringify({
              ok: true,
              data: {
                kind: "transcript",
                video_id: "AbCdEf12_-3",
                segments: [
                  { start: 0, duration: 3, text: "Este es un ejemplo educativo para la clase." },
                ],
                source: "captions",
                language,
              },
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        },
      },
    );
    const result = await provider.acquire(parseYouTubeUrl("https://youtu.be/AbCdEf12_-3"), "auto");
    assert.equal(result.status, "available");
    assert.equal(result.transcript.metadata.language, language);
    assert.equal(result.transcript.metadata.translationStatus, "not_requested");
    assert.equal(result.transcript.metadata.captionSelection, "provider_default");
    assert.equal(calls, 1);
  }
});
it("automatic extraction migration retains legacy uncertainty and persists the real language atomically", async () => {
  const db = await createDatabase(7);
  try {
    await db.exec(
      await readFile(
        new URL("../../supabase/migrations/20261122000900_automatic_captions.sql", import.meta.url),
        "utf8",
      ),
    );
    const repo = embeddedRepository(db),
      source = await repo.ensureSource("AbCdEf12_-3");
    const scalar = async (sql, args) => (await db.query(sql, args)).rows[0].value;
    const jobs = {
      reserve: async (id) =>
        (await db.query("select * from public.reserve_automatic_captions($1)", [id])).rows[0],
      recordRun: async () => false,
      finish: (id, _lang, token, text, metadata) =>
        scalar("select public.finish_automatic_captions($1,$2,$3,$4::jsonb) as value", [
          id,
          token,
          text,
          JSON.stringify(metadata),
        ]),
      fail: (id, _lang, token, code) =>
        scalar("select public.fail_automatic_captions($1,$2,$3) as value", [id, token, code]),
    };
    let calls = 0;
    const text = "Un ejemplo educativo de biología.";
    const provider = createFencedTranscriptProvider(
      {
        acquire: async () => {
          calls++;
          return {
            schemaVersion: 1,
            status: "available",
            transcript: {
              text,
              segments: [{ start: 0, duration: 4, text }],
              metadata: {
                schemaVersion: 1,
                videoId: "AbCdEf12_-3",
                language: "es",
                returnedLanguage: "es",
                captionSelection: "provider_default",
                translationStatus: "not_requested",
                provenance: "licensed_provider",
                provider: { id: "transcriptfetch", version: "test-v1" },
                characterCount: text.length,
                obtainedAt: new Date().toISOString(),
              },
            },
          };
        },
      },
      repo,
      jobs,
    );
    const result = await provider.acquire(parseYouTubeUrl("https://youtu.be/AbCdEf12_-3"), "auto");
    assert.equal(result.status, "available");
    assert.equal(calls, 1);
    const saved = await repo.findTranscript(source, "es");
    assert.equal(saved.metadata.translationStatus, "not_requested");
    assert.equal(saved.text_content, text);
    assert.equal((await jobs.reserve(source)).disposition, "cached");
    const second = await repo.ensureSource("IELMSD2kdmk");
    await db.query("select * from public.reserve_transcript_extraction($1,$2)", [second, "hi"]);
    assert.equal((await jobs.reserve(second)).disposition, "failed");
    await assert.rejects(() =>
      db.transaction(async (tx) => {
        await tx.exec("set local role anon");
        await tx.query("select * from public.reserve_automatic_captions($1)", [source]);
      }),
    );
  } finally {
    await db.close();
  }
});
