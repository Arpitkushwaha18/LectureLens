import assert from "node:assert/strict";
import { describe, it } from "node:test";

/** Synthetic fixtures only; these do not assert a video exists or create application records. */
export function runContractTests(contracts) {
  const {
    parseYouTubeUrl,
    youtubeUrlSchema,
    youtubeUrlInputSchema,
    youtubeVideoIdSchema,
    canonicalVideoSourceSchema,
    transcriptMetadataSchema,
    transcriptProviderOutcomeSchema,
    generationOutputTypeSchema,
    createApiSuccessSchema,
    apiErrorSchema,
    MAX_YOUTUBE_URL_LENGTH,
    MAX_TRANSCRIPT_CHARACTERS,
  } = contracts;
  const videoId = "AbCdEf12_-3";
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const expectedSource = { schemaVersion: 1, kind: "youtube", videoId, canonicalUrl };

  const validUrls = [
    ["standard watch", canonicalUrl],
    ["shortened", `https://youtu.be/${videoId}`],
    ["shorts", `https://www.youtube.com/shorts/${videoId}`],
    ["embed", `https://www.youtube.com/embed/${videoId}`],
    ["watch timestamp", `${canonicalUrl}&t=120s`],
    ["shortened timestamp", `https://youtu.be/${videoId}?t=120`],
    ["embed start/end", `https://www.youtube.com/embed/${videoId}?start=30&end=60`],
    ["playlist and tracking", `${canonicalUrl}&list=example&index=2&si=example`],
    ["timestamp fragment", `${canonicalUrl}#t=1m30s`],
    ["bare YouTube host", `https://youtube.com/watch?v=${videoId}`],
    ["mobile YouTube host", `https://m.youtube.com/watch?v=${videoId}`],
    ["mixed-case scheme/host", `HTTPS://WWW.YouTube.COM/watch?v=${videoId}`],
    ["outer whitespace", `  ${canonicalUrl}\n`],
    ["trailing path slash", `https://youtu.be/${videoId}/`],
    ["reordered parameters", `https://www.youtube.com/watch?t=30&v=${videoId}`],
    ["encoded additional parameter", `${canonicalUrl}&feature=a%20b`],
  ];

  describe("YouTube URL parsing and normalization", () => {
    for (const [label, url] of validUrls) {
      it(`accepts ${label} and returns canonical identity`, () => {
        assert.deepEqual(parseYouTubeUrl(url), expectedSource);
        assert.equal(youtubeUrlSchema.safeParse(url).success, true);
        assert.equal(canonicalVideoSourceSchema.safeParse(parseYouTubeUrl(url)).success, true);
      });
    }

    const invalidUrls = [
      ["empty", ""],
      ["whitespace only", "  \n\t"],
      ["random text", "not a URL"],
      ["short video ID", "https://youtu.be/abc"],
      ["long video ID", `https://youtu.be/${videoId}a`],
      ["invalid ID character", "https://youtu.be/AbCdEf12_!3"],
      ["Unicode ID", "https://youtu.be/AbCdEf12_é3"],
      ["missing ID", "https://www.youtube.com/watch"],
      ["empty v", "https://www.youtube.com/watch?v="],
      ["lookalike suffix", `${canonicalUrl.replace("youtube.com", "youtube.com.evil.test")}`],
      ["lookalike spelling", `${canonicalUrl.replace("youtube.com", "youtubee.com")}`],
      ["short-host suffix", `https://youtu.be.evil.test/${videoId}`],
      ["Unicode host", `https://www.yоutube.com/watch?v=${videoId}`],
      ["encoded host", `https://www.%79outube.com/watch?v=${videoId}`],
      ["unrelated website", `https://example.com/watch?v=${videoId}`],
      ["malformed scheme", `https:/www.youtube.com/watch?v=${videoId}`],
      ["missing scheme", `www.youtube.com/watch?v=${videoId}`],
      ["protocol relative", `//www.youtube.com/watch?v=${videoId}`],
      ["extra authority slash", `https:///www.youtube.com/watch?v=${videoId}`],
      ["HTTP", `http://www.youtube.com/watch?v=${videoId}`],
      ["FTP", `ftp://www.youtube.com/watch?v=${videoId}`],
      ["credentials", `https://user:password@www.youtube.com/watch?v=${videoId}`],
      ["trusted name as username", `https://www.youtube.com@evil.test/watch?v=${videoId}`],
      ["default port", `https://www.youtube.com:443/watch?v=${videoId}`],
      ["nonstandard port", `https://www.youtube.com:8443/watch?v=${videoId}`],
      ["trailing hostname dot", `https://www.youtube.com./watch?v=${videoId}`],
      ["unapproved subdomain", `https://music.youtube.com/watch?v=${videoId}`],
      ["unsupported channel path", "https://www.youtube.com/channel/example"],
      ["unsupported playlist path", "https://www.youtube.com/playlist?list=example"],
      ["unsupported attribution redirect", `https://www.youtube.com/attribution_link?u=${videoId}`],
      ["nested path", `https://youtu.be/${videoId}/extra`],
      ["wrong path casing", `https://www.youtube.com/Watch?v=${videoId}`],
      ["duplicate video IDs", `${canonicalUrl}&v=${videoId}`],
      ["path/query ambiguity", `https://youtu.be/${videoId}?v=OtherId12_3`],
      ["backslash repair", `https://www.youtube.com\\watch?v=${videoId}`],
      ["dot-segment repair", `https://www.youtube.com/a/../watch?v=${videoId}`],
      ["encoded dot-segment repair", `https://www.youtube.com/%2e/watch?v=${videoId}`],
      ["encoded path separator", `https://www.youtube.com/shorts%2f${videoId}`],
      ["interior newline repair", `https://www.you\ntube.com/watch?v=${videoId}`],
      ["interior tab repair", `https://www.youtube.com/wa\ttch?v=${videoId}`],
      ["literal space", `${canonicalUrl}&feature=a b`],
      ["malformed percent escape", `${canonicalUrl}&feature=%ZZ`],
      ["NUL character", `${canonicalUrl}\u0000`],
    ];

    for (const [label, url] of invalidUrls) {
      it(`rejects ${label}`, () => {
        assert.equal(youtubeUrlSchema.safeParse(url).success, false);
        assert.throws(() => parseYouTubeUrl(url));
      });
    }

    it("rejects non-string values without coercion", () => {
      for (const value of [null, undefined, 123, {}, [], new URL(canonicalUrl)]) {
        assert.equal(youtubeUrlSchema.safeParse(value).success, false);
        assert.throws(() => parseYouTubeUrl(value));
      }
    });

    it("accepts exactly the maximum URL length and rejects one over", () => {
      const url = `${canonicalUrl}#${"x".repeat(MAX_YOUTUBE_URL_LENGTH - canonicalUrl.length - 1)}`;
      assert.equal(url.length, MAX_YOUTUBE_URL_LENGTH);
      assert.deepEqual(parseYouTubeUrl(url), expectedSource);
      assert.equal(youtubeUrlSchema.safeParse(`${url}x`).success, false);
      assert.equal(youtubeUrlSchema.safeParse(` ${url}`).success, false);
    });

    it("accepts every allowed ID character, but only at length 11", () => {
      for (const id of [
        "___________",
        "-----------",
        "01234567890",
        "ABCDEFGHIJK",
        "abcdefghijk",
      ]) {
        assert.equal(youtubeVideoIdSchema.safeParse(id).success, true);
        assert.equal(parseYouTubeUrl(`https://youtu.be/${id}`).videoId, id);
      }
      for (const id of ["", "a".repeat(10), "a".repeat(12)]) {
        assert.equal(youtubeVideoIdSchema.safeParse(id).success, false);
      }
    });

    it("normalization is idempotent and preserves video-ID case", () => {
      assert.deepEqual(
        parseYouTubeUrl(parseYouTubeUrl(validUrls[1][1]).canonicalUrl),
        expectedSource,
      );
    });

    it("never calls fetch, even with an additional redirect-looking parameter", () => {
      const originalFetch = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = () => {
        calls += 1;
        throw new Error("Network access is forbidden in URL parsing tests");
      };
      try {
        assert.deepEqual(
          parseYouTubeUrl(`${canonicalUrl}&next=https%3A%2F%2Fevil.test`),
          expectedSource,
        );
        assert.throws(() => parseYouTubeUrl("https://evil.test"));
        assert.equal(calls, 0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("Versioned input and canonical-source contracts", () => {
    it("defaults the input contract version and trims outer whitespace", () => {
      assert.deepEqual(youtubeUrlInputSchema.parse({ url: ` ${canonicalUrl} ` }), {
        schemaVersion: 1,
        url: canonicalUrl,
      });
    });

    it("rejects missing input, unknown fields and unsupported versions", () => {
      for (const input of [
        {},
        { url: canonicalUrl, ownerId: "untrusted" },
        { schemaVersion: 2, url: canonicalUrl },
      ]) {
        assert.equal(youtubeUrlInputSchema.safeParse(input).success, false);
      }
    });

    it("rejects noncanonical, mismatched and unversioned sources", () => {
      for (const source of [
        { ...expectedSource, canonicalUrl: `https://youtu.be/${videoId}` },
        { ...expectedSource, canonicalUrl: `${canonicalUrl}&t=30` },
        { ...expectedSource, videoId: "OtherId12_3" },
        { ...expectedSource, kind: "pdf" },
        { ...expectedSource, schemaVersion: 2 },
        { kind: "youtube", videoId, canonicalUrl },
        { ...expectedSource, ownerId: "untrusted" },
      ]) {
        assert.equal(canonicalVideoSourceSchema.safeParse(source).success, false);
      }
    });
  });

  describe("Generation type contracts", () => {
    for (const type of ["detailed_notes", "short_notes", "flashcards", "mcq_quiz"]) {
      it(`accepts ${type}`, () => assert.equal(generationOutputTypeSchema.parse(type), type));
    }
    for (const type of ["quiz", "notes", "pyq", "MCQ_QUIZ", "", null, 1]) {
      it(`rejects invalid generation type ${String(type)}`, () => {
        assert.equal(generationOutputTypeSchema.safeParse(type).success, false);
      });
    }
  });

  describe("Opt-in generation selection v2", () => {
    const { generationOutputTypeV2Schema, generationSelectionV2Schema } = contracts;

    it("preserves all four original generation types in v2", () => {
      for (const type of generationOutputTypeSchema.options) {
        assert.equal(generationOutputTypeV2Schema.parse(type), type);
      }
    });

    it("adds mindmap and AI sample papers without changing the v1 enum", () => {
      for (const type of ["mindmap", "sample_question_paper"]) {
        assert.equal(generationOutputTypeV2Schema.safeParse(type).success, true);
        assert.equal(generationOutputTypeSchema.safeParse(type).success, false);
      }
      assert.deepEqual(generationOutputTypeSchema.options, [
        "detailed_notes",
        "short_notes",
        "flashcards",
        "mcq_quiz",
      ]);
    });

    it("accepts one or all six unique selections with an explicit v2 version", () => {
      for (const outputTypes of [["mindmap"], generationOutputTypeV2Schema.options]) {
        assert.equal(
          generationSelectionV2Schema.safeParse({ schemaVersion: 2, outputTypes }).success,
          true,
        );
      }
    });

    it("rejects duplicates, empty selections, unknown types, PYQs and oversized arrays", () => {
      for (const outputTypes of [
        [],
        ["mindmap", "mindmap"],
        ["actual_pyq"],
        ["sample_paper"],
        ["notes"],
        Array(7).fill("flashcards"),
      ]) {
        assert.equal(
          generationSelectionV2Schema.safeParse({ schemaVersion: 2, outputTypes }).success,
          false,
        );
      }
    });

    it("does not silently accept a missing, old or unknown version", () => {
      for (const schemaVersion of [undefined, 1, 3, "2"]) {
        assert.equal(
          generationSelectionV2Schema.safeParse({ schemaVersion, outputTypes: ["mindmap"] })
            .success,
          false,
        );
      }
    });

    it("rejects unexpected fields and leaves source contract version 1 unchanged", () => {
      assert.equal(
        generationSelectionV2Schema.safeParse({
          schemaVersion: 2,
          outputTypes: ["mindmap"],
          ownerId: "untrusted",
        }).success,
        false,
      );
      assert.equal(canonicalVideoSourceSchema.parse(expectedSource).schemaVersion, 1);
    });
  });

  const metadata = {
    schemaVersion: 1,
    videoId,
    language: "en",
    provenance: "manual",
    provider: { id: "manual", version: "1" },
    characterCount: 1,
    obtainedAt: "2026-01-01T00:00:00Z",
  };

  describe("Transcript metadata and provider outcomes", () => {
    it("rejects trailing line terminators in IDs, language tags, hashes and provider IDs", () => {
      for (const ending of ["\n", "\r", "\u2028", "\u2029"]) {
        assert.equal(youtubeVideoIdSchema.safeParse(`${videoId}${ending}`).success, false);
        for (const changes of [
          { language: `en${ending}` },
          { contentHash: `${"a".repeat(64)}${ending}` },
          { provider: { id: `manual${ending}`, version: "1" } },
        ]) {
          assert.equal(
            transcriptMetadataSchema.safeParse({ ...metadata, ...changes }).success,
            false,
          );
        }
      }
    });

    it("accepts bounded metadata with optional hash and later expiry", () => {
      assert.equal(
        transcriptMetadataSchema.safeParse({
          ...metadata,
          contentHash: "a".repeat(64),
          expiresAt: "2026-01-02T00:00:00Z",
        }).success,
        true,
      );
    });

    it("validates character-count boundaries and rejects fractional counts", () => {
      for (const count of [1, MAX_TRANSCRIPT_CHARACTERS]) {
        assert.equal(
          transcriptMetadataSchema.safeParse({ ...metadata, characterCount: count }).success,
          true,
        );
      }
      for (const count of [0, -1, 1.5, MAX_TRANSCRIPT_CHARACTERS + 1]) {
        assert.equal(
          transcriptMetadataSchema.safeParse({ ...metadata, characterCount: count }).success,
          false,
        );
      }
    });

    it("accepts common language tags and rejects malformed tags", () => {
      for (const language of ["en", "hi", "en-US", "zh-Hant", "und"]) {
        assert.equal(transcriptMetadataSchema.safeParse({ ...metadata, language }).success, true);
      }
      for (const language of ["", "e", "english", "en_US", "en-", "en-" + "x".repeat(40)]) {
        assert.equal(transcriptMetadataSchema.safeParse({ ...metadata, language }).success, false);
      }
    });

    it("rejects invalid provenance, hashes, dates, providers and versions", () => {
      for (const changes of [
        { provenance: "scraped" },
        { contentHash: "invalid" },
        { obtainedAt: "yesterday" },
        { expiresAt: metadata.obtainedAt },
        { expiresAt: "2025-01-01T00:00:00Z" },
        { provider: { id: "https://evil.test", version: "1" } },
        { provider: { id: "manual", version: "" } },
        { schemaVersion: 2 },
        { extra: "unexpected" },
      ]) {
        assert.equal(
          transcriptMetadataSchema.safeParse({ ...metadata, ...changes }).success,
          false,
        );
      }
    });

    it("accepts each explicit provider outcome", () => {
      for (const outcome of [
        { status: "available", transcript: { metadata, text: "x" } },
        {
          status: "unavailable",
          reason: "provider_not_configured",
          message: "Paste an authorized transcript.",
        },
        { status: "authorization_required", message: "Creator authorization is required." },
        { status: "temporarily_failed", message: "Try again later.", retryAfterSeconds: 60 },
      ]) {
        assert.equal(
          transcriptProviderOutcomeSchema.safeParse({ schemaVersion: 1, ...outcome }).success,
          true,
        );
      }
    });

    it("rejects unknown statuses, missing results and mixed outcome fields", () => {
      for (const outcome of [
        { status: "success" },
        { status: "available" },
        { status: "unavailable", reason: "invented", message: "Unavailable" },
        { status: "authorization_required", message: "" },
        { status: "temporarily_failed", message: "Retry", transcript: { metadata, text: "x" } },
      ]) {
        assert.equal(
          transcriptProviderOutcomeSchema.safeParse({ schemaVersion: 1, ...outcome }).success,
          false,
        );
      }
    });

    it("rejects whitespace-only and mismatched transcript text", () => {
      for (const text of ["", " ", "xx"]) {
        assert.equal(
          transcriptProviderOutcomeSchema.safeParse({
            schemaVersion: 1,
            status: "available",
            transcript: { metadata, text },
          }).success,
          false,
        );
      }
    });

    it("accepts transcript maximum and rejects one character over", () => {
      for (const count of [MAX_TRANSCRIPT_CHARACTERS, MAX_TRANSCRIPT_CHARACTERS + 1]) {
        assert.equal(
          transcriptProviderOutcomeSchema.safeParse({
            schemaVersion: 1,
            status: "available",
            transcript: {
              metadata: { ...metadata, characterCount: count },
              text: "x".repeat(count),
            },
          }).success,
          count === MAX_TRANSCRIPT_CHARACTERS,
        );
      }
    });

    it("bounds retry delays to positive whole seconds", () => {
      for (const seconds of [1, 86_400, 0, -1, 1.5, 86_401]) {
        assert.equal(
          transcriptProviderOutcomeSchema.safeParse({
            schemaVersion: 1,
            status: "temporarily_failed",
            message: "Retry",
            retryAfterSeconds: seconds,
          }).success,
          seconds === 1 || seconds === 86_400,
        );
      }
    });
  });

  describe("Existing API envelope compatibility", () => {
    const successSchema = createApiSuccessSchema(canonicalVideoSourceSchema);

    it("validates typed data and optional metadata without adding a wire version", () => {
      assert.deepEqual(successSchema.parse({ data: expectedSource }), { data: expectedSource });
      assert.equal(
        successSchema.safeParse({ data: expectedSource, meta: { cursor: null } }).success,
        true,
      );
    });

    it("rejects missing/invalid data and mixed success/error envelopes", () => {
      for (const body of [
        {},
        { data: null },
        { data: expectedSource, error: { code: "FAIL", message: "Failure" } },
      ]) {
        assert.equal(successSchema.safeParse(body).success, false);
      }
    });

    it("accepts existing errors, with or without details", () => {
      for (const body of [
        { error: { code: "NOT_FOUND", message: "Resource not found" } },
        {
          error: { code: "VALIDATION_ERROR", message: "Invalid input", details: { field: "url" } },
        },
      ]) {
        assert.deepEqual(apiErrorSchema.parse(body), body);
      }
    });

    it("rejects missing/empty error fields and unexpected envelope fields", () => {
      for (const body of [
        {},
        { error: {} },
        { error: { code: "", message: "Invalid" } },
        { error: { code: "INVALID", message: " " } },
        { error: { code: "INVALID", message: "Invalid" }, data: expectedSource },
        { error: { code: "INVALID", message: "Invalid", stack: "private" } },
      ]) {
        assert.equal(apiErrorSchema.safeParse(body).success, false);
      }
    });
  });
}
