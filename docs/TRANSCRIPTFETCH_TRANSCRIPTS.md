# TranscriptFetch captions — local implementation and review report

## Configuration

Backend dependency: official `transcriptfetch` **2.4.1**, pinned exactly in
`backend/package.json` and `backend/package-lock.json`. No frontend dependency.
Documentation currently recommends 2.4.0; npm installed 2.4.1. The installed
types/runtime support the documented object constructor and video options.

Set in ignored `backend/.env`:

```dotenv
TRANSCRIPTFETCH_API_KEY=
TRANSCRIPT_MAX_CHARACTERS=40000
TRANSCRIPT_MAX_DURATION_SECONDS=14400
```

Blank API key means manual-only mode. Limits must be positive integers, at most
40,000 characters and 14,400 seconds. Existing Supabase and Gemini paired backend
configuration is unchanged. Apify variables are no longer read or required; operators
may remove them from their backend environment after this release. Actual `.env`
files were checked for presence/validity without printing secrets and were not edited.
Never prefix the key with `VITE_`; frontend configuration
validation rejects TranscriptFetch names before bundling, and at runtime.

## Behavior and architecture

Canonical YouTube URL → canonical ID → shared video/language transcript cache →
database reservation → official SDK `tf.transcripts.video(canonicalUrl,
{ mode: "captions", timestamps: true })` → strict segments → joined text → atomic
Supabase persistence → existing database-fenced Gemini notes generation → display.

- **Audio fallback is explicitly disabled.** No audio requests, jobs, webhooks,
  polling, batch fetches, monitors, balance preflight calls or automatic mode changes.
  A caption miss ignores `retry_with: { mode: "audio" }` and offers manual paste.
- Text is always constructed from segment text joined with spaces, never `result.text`.
  All segments must be valid, with finite nonnegative numeric start/duration and
  nonempty trimmed text; preserve order, decimals and overlapping timestamps.
  Invalid/empty/missing cues fail, rather than being skipped or silently truncated.
- Preserve returned language and nullable source/platform/title/channel/URL/thumbnail/
  video-duration metadata when available. Unknown metadata remains null/absent, not
  invented. Media metadata is stored on the transcript, not used to rename sources
  or independently certify public availability or rights.
- The SDK has **no documented language request option**. English/Hindi selections
  partition the existing shared cache and check the returned track's base language;
  they do not select or translate captions. Unknown language or a mismatch asks for a matching
  selection/manual paste. `language`/`requestedLanguage` preserve the existing request
  identity; `returnedLanguage` records the actual language if known. Unknown returned
  language is not guessed from text. A rejected mismatch can still cost a caption credit.
- Accepted captions require a known returned language matching the selected cache
  partition, including the finish RPC check. Missing language is never mislabeled.
- Segments, requested/returned language, provider identity, acquisition time and
  source metadata are inserted together into immutable `transcripts.metadata`.
  Hashes, provenance and provider columns remain intact. Gemini consumes joined text.
  Notes responses include transcript text, timestamps and language; the workspace
  renders expandable transcript cues with timestamp links back to the lecture.
- Local Gemini configuration is checked before any paid caption request. This does
  not certify key validity or live model availability.
- Usage (`creditsSpent`, `balance`, `bytes`) from a successful accepted extraction is
  stored in **`ll_private.transcript_extractions.usage` only**. The finish RPC strips
  usage from public transcript metadata. No raw response, key or balance is returned
  in the student notes response. Rejected results do not persist usage accounting;
  inspect the provider ledger for their charges.
- Existing caches, four public resource tables, no-login notebook UI, Continue
  submission, progress polling for other callers' reservations, and manual paste
  with sharing consent remain. A cached transcript skips the SDK entirely, even
  when Gemini notes still need generating. Existing Apify/manual caches remain usable.

## Cost, bounds and failure behavior

Official docs say one credit per successful caption fetch; failed/blocked/no-transcript
requests are free. Auto/audio transcription is normally charged per started five
minutes on delivery, **but is not enabled here**. Pricing and billing are provider
claims, not independently tested guarantees; review account pricing and quotas.
No Apify dollar cap applies to this SDK; no total daily budget is implemented.

- SDK `maxRetries: 0`: no retry of POSTs, 429, 5xx, network uncertainty, auth or credit
  failures. SDK-generated idempotency headers remain enabled, but are not used as
  permission to replay uncertain requests. Database fencing is the duplicate-spend guard.
- Fixed HTTPS TranscriptFetch origin, redirects rejected. No cookies, platform login,
  private documents, pasted transcript, Supabase/Gemini key or student profile sent.
- 30-second request/download timeout, streamed response cap 2,000,000 bytes and at
  most 10,000 cues. The SDK clears its native timer after headers and normalizes bad
  timing to zero; its injected transport adds a body deadline and validates wire
  cues/metadata **before** SDK normalization. This is a guard around official SDK
  requests, not a replacement REST provider. Installed SDK errors are translated to
  safe application messages; raw provider error messages are never exposed/logged.
- Configurable character/video-duration/cue-end limits, plus the existing hard
  80 KB UTF-8 text limit. Limits reject rather than truncate. They are checked after
  fetching, so an oversized caption response can still consume a credit. Duration
  unknown: enforce cue endpoints; no guessed media duration or paid metadata preflight.
- Preserve database-global admission: two active extractions, ten new reservations
  per minute, plus existing HTTP IP rate limits. These are not a complete abuse system.
- 120-second token lease; failed/expired/uncertain reservations are never stolen or
  automatically reset. Duplicate callers receive extraction progress; subsequent
  failed requests ask for operator review/manual paste. An uncertain database commit
  stays fenced. Manual race winners are reused without overwriting text/metadata.
- Unexpected `processing`/audio responses or failed jobs fail safely, never poll/restart.
  Captions mode should never create a job according to docs. Unexpected job IDs are
  not persisted in the legacy Apify-shaped run-ID field; inspect the provider account
  ledger by source/time before any targeted recovery. No recovery endpoint is added.

Any future audio rollout needs a separate review: explicit user/operator enablement,
documented `transcripts.job(jobId)` polling with bounds, provider-compatible private
job IDs, stable reservation/idempotency identity, duration/credit budget and usage
accounting for intermediate/failure states. Do not simply change `mode` to `auto`.

## Migration plan — read-only hosted review, no production changes

`20261121000300_apify_transcript_extraction.sql` is **unchanged**. Prior local work
reported no push. Read-only CLI review now confirms 001/002 applied and 003/004
pending in project `hotreszoeqtsidpcbcaf`. Its reservation functions/table are still needed; only its finish function's
hard-coded Apify labels were provider-specific.

New local forward-only migration:
`supabase/migrations/20261121000400_transcriptfetch_captions.sql`.
It adds private usage accounting and replaces the existing finish RPC with identical
signature, validating TranscriptFetch identity, preserving timestamps/cache/manual
locking rules and service-only permissions. No new public resource table, auth/profile
feature, historical transcript rewrite, run-ID change or reservation reset.

- If 00300 is already applied: retain it and review/apply only the pending forward
  migration after confirming schema compatibility and migration history.
- If 00300 is not applied: retain the ordered 00100–00400 chain. 00300 establishes
  fencing; 00400 immediately supersedes its provider label before enabling this backend.
  This avoids guessing/replacing possibly applied migration history.
- Quiesce extraction/old backend instances before switching providers or applying the
  new finish RPC. Existing running/failed Apify reservations remain fenced and need
  operator reconciliation, not automatic reset. Do not allow mixed old/new writers.
- Verify corrected B2/B3 prerequisites, hosted history, collisions, service grants and
  dry-run locally before any separately authorized push. Existing `supabase/preflight.sql`
  is incomplete for these extraction migrations. Native multi-connection contention
  and hosted PostgREST remain unverified. **Nothing was pushed or deployed.**

Read-only hosted comparisons matched the local 001/002 columns, defaults, RLS,
constraints, indexes, triggers, policies, function-body hashes/security settings,
public-table grants, RPC execute grants and private-schema usage. PostgreSQL-version
differences in NOT NULL constraint catalog rows were excluded after separately
matching column nullability. No extraction table/RPC name collisions were found.
The existing server-only read check passed. A local upgrade test applies 003/004 to
a populated 001/002 database and verifies records and a running generation claim
survive unchanged. This is not a native multi-connection or hosted extraction test.

Dry-run command completed and listed exactly 003 and 004:

```sh
npx --yes supabase@3.2.0 db push --remote=hotreszoeqtsidpcbcaf --dry-run --skip-vault
```

After explicit approval and quiescing backend writers, run from the repository root:

```sh
npx --yes supabase@3.2.0 db push --remote=hotreszoeqtsidpcbcaf --skip-vault
```

`--skip-vault` prevents unrelated vault-secret updates. No reset, repair, include-all,
role/seed push or production schema change was performed during this review.

## Official evidence versus local tests

Reviewed official SDK docs, GitHub README, installed 2.4.1 types/runtime, video endpoint
reference, response docs and privacy/terms:

- https://transcriptfetch.com/docs/node
- https://github.com/TranscriptFetch/transcript-api-node
- https://transcriptfetch.com/docs/endpoints/video.md
- https://transcriptfetch.com/docs/output.md
- https://transcriptfetch.com/privacy

Docs confirm the constructor, caption mode, numeric cue shape, nullable metadata,
usage balance, typed errors and job statuses/API. The Node page says timestamped
responses omit text (SDK returns null); other response/endpoint docs still describe
text plus segments. Joining segments handles both without relying on that discrepancy.

Local tests use the **actual installed SDK with mocked fetch**, embedded PostgreSQL
for migrations/reservations/persistence/grants, and mocked Gemini. They verify request
serialization, SDK normalization/idempotency, en/hi/null metadata, invalid data, no
audio/polling/retries, auth/credits/rate limits, header/body timeouts, cache skip,
concurrent callers, failed/uncertain fencing, persistence, immutable/manual races and
URL-to-notes/manual fallback. No live API response, credit charge, key validity,
caption availability/quality or provider access method was independently verified.

## Privacy and rights review

TranscriptFetch's published terms limit use to publicly available content, prohibit
restricted-content access and place YouTube/content rights obligations on the user.
Its privacy policy records requested sources, credits, timestamps and caller IP for
billing/abuse prevention; account/usage retention is account-lifetime plus legal needs.
It lists processors including DeepInfra for audio transcription. Captions-only mode
avoids intentionally sending audio for that fallback; provider internals/retention
were not independently audited. No remote deletion automation is added.

Only request public lectures with appropriate reuse rights. URL parsing does not prove
visibility/rights. The existing `licensed_provider` label means external-provider
provenance, **not** independent licensing certification. Review provider security,
data retention/transfers, platform terms and shared-library permissions before live use.

## Verification results

| Area      | Tests                | Typecheck | Lint                        | Build  |
| --------- | -------------------- | --------- | --------------------------- | ------ |
| Backend   | 188 passed, 0 failed | Passed    | Passed                      | Passed |
| Frontend  | 135 passed, 0 failed | Passed    | Passed                      | Passed |
| Contracts | 106 passed, 0 failed | Passed    | Passed (TypeScript sources) | Passed |

Backend/frontend used their existing npm scripts. Contracts have no npm lint script;
their TypeScript sources were linted with the existing backend ESLint configuration:
`backend/node_modules/.bin/eslint --config backend/eslint.config.js contracts/src`.
Changed supported code/JSON/Markdown files passed Prettier checking. npm installation
reported zero dependency vulnerabilities. The existing nonblocking Vite warning about
the extensionless config import/future native loader remains.

No live TranscriptFetch/Apify/Gemini API requests, migration push, deployment or commit
were performed. Supabase verification used read-only hosted queries and a migration
dry-run only. Existing backend/frontend dev servers were confirmed running at ports
4000/5173, health returned OK, and the workspace rendered notes and clickable
timestamps using a browser-tab-only mock (not hosted extraction). The real HTTP
workflow test uses the SDK mocked transport, actual embedded SQL and mocked Gemini.
Backend environment is valid; Supabase/Gemini are set, the Gemini model matches
`gemini-3.8-flash`, and `TRANSCRIPTFETCH_API_KEY` is missing. Live caption extraction
requires that key and approved application of pending 003/004. Live model/key
availability remains unverified because paid requests were not authorized.

Start in separate terminals from the repository root:

```sh
npm --prefix backend run dev
npm --prefix frontend run dev
```

Open `http://localhost:5173/assistant`.

## Exact authored file inventory

```text
Added:
.prettierignore
backend/src/modules/extraction/transcriptfetch-transcript.ts
backend/tests/transcriptfetch-transcript.test.mjs
backend/tests/migration-upgrade.test.mjs
supabase/migrations/20261121000400_transcriptfetch_captions.sql
docs/TRANSCRIPTFETCH_TRANSCRIPTS.md

Modified:
backend/.env.example
backend/package.json
backend/package-lock.json
backend/src/config/env-schema.ts
backend/src/config/env.ts
backend/src/lib/supabase.ts
backend/src/app.ts
backend/src/controllers/notes.controller.ts
backend/src/services/notes.service.ts
backend/src/modules/extraction/transcript-provider.ts
backend/src/repositories/notes.repository.ts
backend/src/repositories/transcript-extraction.repository.ts
backend/src/services/transcript-extraction.service.ts
backend/tests/helpers/database.mjs
backend/tests/notes-workflow.test.mjs
backend/tests/transcript-extraction-workflow.test.mjs
contracts/src/learning.ts
contracts/src/notes.ts
contracts/tests/notes.test.mjs
frontend/src/features/workspace/DetailedNotesPanel.tsx
frontend/src/lib/supabase-env.ts
frontend/src/pages/AIWorkspacePage.tsx
frontend/src/components/HealthStatus.tsx (formatting only)
frontend/src/layouts/MobileNav.tsx (formatting only)
frontend/src/styles/index.css (formatting only)
frontend/tests/supabase-env.test.mjs
docs/APIFY_TRANSCRIPTS.md
docs/PHASE_B3.md

Removed obsolete Apify implementation/test/fixture:
backend/src/modules/extraction/apify-transcript.ts
backend/tests/apify-transcript.test.mjs
backend/tests/fixtures/apify-segments.json
```

Build/test scripts refresh usual ignored `dist`/test-build artifacts. The two obsolete
ignored `backend/dist/modules/extraction/apify-transcript.js{,.map}` files were also
removed; no other user files or historical migrations were deleted. The workspace
is largely untracked in git, so this inventory is task-specific, not a baseline diff.
