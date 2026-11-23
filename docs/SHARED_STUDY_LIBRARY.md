# LectureLens shared study library

**Historical implementation record — discontinued.** The current product removes the gallery,
publication UI and public resource APIs. See `FINAL_YOUTUBE_WORKFLOW.md` for the replacement.

## Local product upgrade — 22 November 2026

The UI is LectureLens; `/assistant` is **UrTutor**. Dedicated experiences include ruled
handwritten detailed notebooks, compact revision sheets, flip/shuffle/known-state decks,
one-question-at-a-time scored quizzes, draggable/zoomable SVG maps and clearly labelled
AI-generated practice papers with separately revealed answers. PDF downloads retain the
existing isolated Chromium notebook renderer and include answers. Deck review marks and
written paper answers stay in the current tab; quiz submissions are privately persisted.

Real stage events and independently completed output events stream over NDJSON. The page
shows immediate upload/validation status without invented percentages. Completed outputs
remain visible when another output fails. Retry reuses completed work and only claims missing
or definitively failed operations; Check result cannot dispatch providers. Existing uncertain
SQLite/Supabase jobs, history and cross-model/store fences are preserved.

## Captions: capabilities and costs

Reviewed [TranscriptFetch video endpoint documentation](https://transcriptfetch.com/docs/endpoints/video.md)
and installed SDK 2.4.1. The documented endpoint accepts `video`, `mode`, `timestamps` and
other presentation options, **not** a language selector, track enumeration, human-caption
preference or translation selection. We cannot honestly promise best-original/human-track
selection upstream. The backend records `provider_default`, keeps the returned language and
never requests translation. Previously cached licensed captions explicitly marked human are
preferred when available; unknown track types are never relabelled human. If language is
absent, local statistical detection is used, or `und` for insufficient/unknown text.

The documentation quotes **1 credit per caption fetch**, and audio fallback at **1 credit per
started five minutes** (minimum one). Credits are not a guaranteed dollar price; the account
plan determines that. `mode: "captions"` is always explicit. No audio provider or audio extraction
was added, and no paid provider requests were made for this upgrade. Missing/disabled/private,
member-only, region/age-restricted captions receive explanations and permitted gallery links.
Related resources match the source or an explicitly owner-provided subject, never fabricated
video content. A prior failed/uncertain extraction remains fenced; disabling the picker does
not open a new billing namespace around legacy extraction jobs.

All supported BCP-style returned language tags are accepted by automatic mode. Tests cover
Spanish, French, Japanese, Chinese, Arabic, German and Hindi with mocked provider responses.
English/Hindi legacy explicit-language callers remain compatible. Notes are generated in
English; source language and output language are separate metadata. Automatic provider
language detection and availability for fresh/restricted real videos remain unverified live.

## Persistence and ownership

`contracts/src/resources.ts` validates six versioned resource formats and stable entry IDs.
`study_resources` stores identity/metadata; `study_resource_entries` separately stores ordered
blocks, revision points, cards, quiz questions, maps, paper sections and answers. Private
provenance contains source/content hashes, model/prompt versions and publication permission
audit, **not** raw uploaded files or captions. No resource TTL or usage-based deletion exists.
Publications are idempotent and deduplicated by generated identity. Subject labels are
owner-provided and labelled accordingly; unclassified subjects stay unclassified. No usage,
ratings or popularity statistics are invented.

The local development default is `LIBRARY_STORE=local_postgres`, persistent at
`backend/.cache/library`. PGlite applies only independent library migrations 008 and 010;
it does not modify the existing SQLite billing cache or hosted database. The directory is
single-process: do not run multiple API workers against one PGlite directory. Local guest
ownership uses a random HttpOnly, SameSite device cookie and a hashed server-side session.
Losing this cookie loses access to the device's private shelf; published resources persist.

For hosted/account use, set `LIBRARY_STORE=supabase` **only after explicit approval** and apply
forward-only migrations in order to an appropriate Supabase project:

- 005–007: existing limits, recovery, retry lifecycle (still unapplied to hosted project).
- 008: normalized resources, permissions, private attempts and RLS/RPCs.
- 009: automatic caption extraction with legacy billing fences and actual-language persistence.
- 010: removal/republication fences and permitted related-resource lookup.

No migration has been applied to production. Sign-in/signup use Supabase Auth through the
backend; the frontend never gets the service-role secret. The backend validates the user
with Supabase `getUser`, and only then supplies an owner ID to service-only RPCs. Read-only RLS
permits published resources or `auth.uid()` ownership, and private attempts only for their
owner. Browser roles cannot write resources or invoke privileged owner-parameter RPCs.
State-changing API requests require a custom header plus allowlisted credentialed CORS.
Expired Supabase access tokens currently require signing in again; refresh-cookie rotation
and hosted email-confirmation workflows have not been verified live. Production requires
Supabase library mode and HTTPS for session cookies.

Publishing requires an ownership/licence/permission/public-domain basis, a rights statement,
and affirmative redistribution/platform-terms confirmations. Private uploads remain private
unless their owner explicitly publishes generated resources. Public availability alone is
not permission. Takedown is operator-only via `POST /api/v1/operator/resources/:id/remove`
with the existing protected operator bearer token and a 20–1000-character reason. It hides
the resource and retains audit history; the same identity cannot simply be republished.
Historical SQLite gallery rows remain intact but are not automatically republished by the
production compatibility gallery endpoint.

Shared resource persistence does not coordinate multiple SQLite generation workers. Keep
`WORKSPACE_YOUTUBE_STORE=local` for the tested six-output worker and one authoritative worker.
Do not concurrently migrate live paid jobs between local and hosted workers. The historical
hosted detailed-notes path is separately fenced and still requires its approved migrations.

## Verification

- Backend: 266 passing tests; frontend: 139; shared contracts: 109 (514 total).
- Actual PostgreSQL SQL tests: normalized persistence/reopen, private access isolation,
  anonymous/authenticated RLS, rights enforcement, duplicate publication, private scored
  attempts, stale/replayed submissions, removal/republication fences and automatic-caption
  migration compatibility with historical uncertain jobs.
- Browser regression: real PDF/XLSX/XLS/CSV parsing, English/Hindi scanned/image OCR, partial
  recovery, progress without percentages, six activity views, retries/cache/fences, readable
  multi-output PDF, mobile layout and **two independent browser sessions** testing denied
  private reads, explicit publishing and isolated private quiz scores. Provider generation
  in this regression is mocked, not a new paid live verification.
- Existing genuine Gemini-generated YouTube short notes were reused via **checkOnly** after
  automatic selection of cached 22,301-character Hindi captions. The revision resource was
  saved privately to local PostgreSQL and opened in the actual browser: 13 revision points,
  output `en`, source `hi`. No generation/caption dispatch, no publication. This also exposed
  and fixed a compatibility lookup for exact validated results from the prior renamed prompt.

Fresh live caption acquisition, Supabase-hosted auth/RPC deployment and cross-device hosted
operation remain pending. Original unavailable large uploads and arbitrary 100,000-character
generation were not live-benchmarked. Local SQL/browser tests are not a claim of production
readiness or verified redistribution rights for any real video.
