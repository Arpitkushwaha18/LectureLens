# LectureLens contracts — B1

This local package is the single runtime source of truth for both independently installable
applications. It is not a root workspace and contains no routes, database clients or providers.
All schemas use Zod; the browser-safe parser uses only `URL` and performs no network access.

## Setup and checks

Install this package first (`npm install` in `contracts/`), then install each application in its
own directory. The local `file:../contracts` dependencies resolve the same compiled ESM package.
Application `predev`, `prebuild`, `pretypecheck` and `pretest` scripts compile contracts before use.
When editing contracts during development, rebuild them and restart the app dev process.

Run `npm test` in each app to exercise the same suite against that app's installed package.
Run `npm run typecheck`, `npm run lint` and `npm run build` in each app as usual. Shared sources
and test fixtures can be linted from this directory using the already installed backend tool:

```sh
../backend/node_modules/.bin/eslint --config ../backend/eslint.config.js src tests
```

No additional test framework is needed: tests use Node's built-in runner. Test fixtures are
synthetic and never create academic records or claim a video exists.

## URL policy

- HTTPS only; allowed hosts: `youtube.com`, `www.youtube.com`, `m.youtube.com`, `youtu.be`.
- Long hosts: `/watch?v=ID`, `/shorts/ID`, `/embed/ID`.
- Short host: `/ID`. Path-based formats may have one trailing slash.
- IDs: exactly 11 ASCII letters, digits, underscores or hyphens. Case is preserved.
- Additional query parameters and fragments are accepted but dropped from canonical identity.
- Normalized identity: `https://www.youtube.com/watch?v=ID`.
- Outer whitespace is trimmed; maximum raw input length is 2,048 UTF-16 code units.
- Reject credentials, explicit ports (including 443), unapproved subdomains, lookalikes,
  encoded paths/hosts, dot segments, backslashes, internal whitespace/control characters,
  malformed percent escapes and ambiguous duplicate video IDs.
- Unsupported: channels, playlists without a supported video URL, `/live/`, redirect wrappers,
  protocol-relative URLs and URLs without an explicit HTTPS scheme.

`parseYouTubeUrl(unknown)` returns a canonical source or throws a Zod validation error.
`youtubeUrlSchema` validates/trims input without normalizing it; `youtubeUrlInputSchema` validates
the request object. Validation proves syntax and identity only, not existence, accessibility,
ownership, captions availability or permission to process the video. Future server adapters
must accept the validated ID, not fetch arbitrary submitted URLs.

## Versioning and contracts

Package major version and `schemaVersion: 1` identify the first contracts. URL input defaults its
missing version to 1; canonical sources, transcript metadata and provider outcomes require it.
Breaking wire changes require a new schema version and explicit migration/compatibility policy.
Existing API envelopes remain unchanged and do not gain a required version field.

Transcript metadata describes language, provenance, provider/version, bounded character count,
optional lowercase SHA-256 hash, acquisition time and optional later expiry. Language validation
accepts common tags (such as `en-US` and `zh-Hant`), not every possible BCP 47 extension.
Character counts mean JavaScript string length (UTF-16 code units), not bytes or token counts.
Hashes are syntax-checked only; a future ingestion service must compute/verify their contents.

Provider outcomes are discriminated by `available`, `unavailable`, `authorization_required` or
`temporarily_failed`. Available text must be nonblank and match its metadata character count.
These are contracts only, not implementations or claims of provider authorization. Timestamped
segments and persisted database identifiers are intentionally deferred.

Generation types are exactly `detailed_notes`, `short_notes`, `flashcards` and `mcq_quiz`.
Generated payload schemas, generation endpoints and actual generation are outside B1.

### B1.5: additive generation selection v2

Package version 1.1.0 adds an opt-in `generationOutputTypeV2Schema` and
`generationSelectionV2Schema`. The latter requires `schemaVersion: 2` and one to six unique
output types. It preserves the original four values and adds `mindmap` and
`sample_question_paper` (AI-generated practice only, never actual PYQs).

The original `generationOutputTypeSchema` still accepts exactly its four B1 values. Canonical
sources, transcript contracts and API envelopes are unchanged. Existing clients do not silently
gain new generation types. No backend endpoint accepts or processes v2 selections yet.

### B3: additive detailed-notes workflow

Version 1.2.0 adds `notesRequestSchema`, `detailedNotesSchema` and
`notesOutcomeSchema`, without altering any B1/B1.5 enum or wire schema.
Requests accept a validated YouTube URL and optional manual transcript with explicit
public-sharing consent. The MVP caps transcripts at 40,000 characters / 80,000 UTF-8
bytes (lower than B1's generic limit). Outcomes are `transcript_required`, `processing`
or `ready`; ready payloads include cache/provenance metadata and strictly bounded
structured detailed notes. Only detailed notes are generated, in English.

Run `npm test` in this package for the full shared suite, including backward-compatibility checks.

`createApiSuccessSchema(dataSchema)` validates `{ data, meta? }`; `apiErrorSchema` validates
`{ error: { code, message, details? } }`. Envelopes and domain objects reject unexpected fields.
