// Local-only controlled test. Captures one authorized caption response privately;
// subsequent runs replay it, never making another TranscriptFetch request.
import { config } from "dotenv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseYouTubeUrl } from "@lecturelens/contracts";
import { createTranscriptFetchProvider } from "../dist/modules/extraction/transcriptfetch-transcript.js";
config({ quiet: true });
const source = parseYouTubeUrl(process.argv[2]);
const directory = resolve(".cache", `lecture-test-${source.videoId}`);
await mkdir(directory, { recursive: true, mode: 0o700 });
const responsePath = resolve(directory, "provider-response.json");
let recorded;
try {
  recorded = JSON.parse(await readFile(responsePath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (!recorded && !process.argv.includes("--live"))
  throw new Error("No saved response. Explicit --live is required for one provider request.");
const provider = createTranscriptFetchProvider(
  { apiKey: process.env.TRANSCRIPTFETCH_API_KEY },
  {
    maxRetries: 0,
    timeoutMs: 120000,
    fetch: async (url, init) => {
      if (!recorded) {
        await writeFile(
          resolve(directory, "dispatch.json"),
          JSON.stringify({
            videoId: source.videoId,
            idempotencyKey: init.headers["Idempotency-Key"],
            at: new Date().toISOString(),
          }),
          { flag: "wx", mode: 0o600 },
        );
        const response = await fetch(url, init);
        recorded = { status: response.status, body: await response.text() };
        await writeFile(responsePath, JSON.stringify(recorded), { flag: "wx", mode: 0o600 });
      }
      return new Response(recorded.body, {
        status: recorded.status,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
);
try {
  const outcome = await provider.acquire(source, "auto");
  if (outcome.status !== "available") {
    console.log(JSON.stringify({ status: outcome.status }));
    process.exitCode = 1;
  } else {
    await writeFile(resolve(directory, "transcript.json"), JSON.stringify(outcome.transcript), {
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        status: "available",
        characters: outcome.transcript.text.length,
        segments: outcome.transcript.segments.length,
        duration: outcome.transcript.metadata.sourceMetadata.duration,
        language: outcome.transcript.metadata.language,
        replay: !process.argv.includes("--live"),
      }),
    );
  }
} catch (error) {
  let data;
  try {
    data = JSON.parse(recorded?.body)?.data;
  } catch {
    /* Never print provider content. */
  }
  console.log(
    JSON.stringify({
      status: "failed",
      code: error.code,
      httpStatus: recorded?.status,
      fields: data ? Object.keys(data) : [],
      segments: data?.segments?.length,
      characters: data?.segments?.reduce(
        (n, s) => n + (typeof s.text === "string" ? s.text.length + 1 : 0),
        0,
      ),
      duration: data?.duration,
      lastCueEnd: data?.segments?.at(-1)?.start + data?.segments?.at(-1)?.duration,
    }),
  );
  process.exitCode = 1;
}
