# B2 cleanup + B3 YouTube detailed-notes MVP

> Subsequent local implementation: automatic captions via the official TranscriptFetch SDK are described in
> [`TRANSCRIPTFETCH_TRANSCRIPTS.md`](./TRANSCRIPTFETCH_TRANSCRIPTS.md). The provider-unconfigured statements
> below describe the original B3 baseline. The new local extraction migration has
> not been pushed; provider credentials, API availability and hosted setup
> still require operator review.

## 1. Removed account functionality

The initial B2 implementation incorrectly added student accounts. Removed:

- `backend/src/{controllers/auth.controller.ts,routes/auth.routes.ts,middleware/requireAuth.ts}`
- `backend/src/services/{auth.service.ts,profile.service.ts}`
- `backend/src/repositories/profile.repository.ts`
- `backend/tests/auth-foundation.test.mjs`
- `frontend/src/pages/ProfilePage.tsx` and its route/navigation item
- `frontend/src/app/AuthProvider.tsx`
- `frontend/src/lib/{auth-context.ts,session-cache.ts,supabase.ts}`
- `frontend/tests/session-cache.test.mjs`
- The obsolete account screenshot and corresponding generated JS/map/cache files
- Frontend Supabase SDK dependency, account API helper and provider wrapping
- Account-specific SQL table, read policy, timestamp trigger, auth-user insert trigger,
  profile helper/backfill/grants and tests

`PHASE_B2.md` now records the correction instead of instructing users to configure accounts.
README, local auth redirect/signup configuration, sidebar and home status copy were corrected.
There are no login/registration/sign-out screens or account/session management. `/profile`
is no longer a route. Existing notebook navigation and B1/B1.5 URL/output contracts remain.
Supabase's own managed `auth.users` is not modified: the dormant private-document owner FK
still references it for a future separately approved document workflow. YouTube owner IDs are
always NULL. No student owns shared YouTube resources.

## 2. Final schema

Two version-controlled SQL migrations, only four application tables:

1. `supabase/migrations/20261121000100_b2_learning_foundation.sql`
2. `supabase/migrations/20261121000200_b3_notes_workflow.sql`

| Table               | Important invariants                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `learning_sources`  | UUID identity; one unique case-sensitive YouTube video ID/canonical watch URL, published and ownerless. Documents require uploader/hash, default private and never appear through MVP APIs. |
| `transcripts`       | Source FK, language/version uniqueness, immutable text/provenance/provider/hash. SHA-256 is calculated/checked in PG over UTF-8. Expiry invalidates eligibility.                            |
| `generated_content` | Source + same-source transcript FK, output/language/model/prompt/schema/settings identity, unique DB-computed cache key, structured payload/status/expiry. YouTube requires transcript.     |
| `generation_jobs`   | Content FK, matching idempotency key, partial unique active-job indexes, bounded attempts, cooldown, lease token and terminal metadata.                                                     |

Source, transcript and configuration fields are immutable. Relevant settings include explicit
temperature, output token limit and output language. JSONB normalization ignores object key
order and equivalent numeric spelling but preserves array order. Source identity/hash, transcript
ID/hash/version, output type, language, configured model, prompt version, schema version and
settings all affect cache identity. URLs or student IDs alone are never cache keys.

`ensure_youtube_source` resolves canonical identity atomically. `acquire_youtube_transcript`
locks the source and returns the first existing unexpired transcript for the selected language,
instead of overwriting it. If all transcripts have expired, it creates a new immutable version.
Concurrent submissions cannot create competing active versions through this RPC. Historic
identical text may have different versions after expiry; cache identity separates those versions.

`reserve_generation` locks/upserts the unique content row and returns `reused`, `reserved`,
`existing_job` or `failed`. Valid notes skip all Gemini network calls. `claim_generation`
atomically claims queued/due retry jobs, increments attempts and creates a 180-second fencing
token. Only one caller can claim. `finish_generation` validates current lease, parent visibility
and transcript validity, and publishes content + job success in one transaction. Readers get
only ready/unexpired detailed notes from a matching published YouTube parent.

Explicit Gemini quota/5xx failures use `fail_generation`: a 60-second cooldown on the same job,
at most three paid attempts. Invalid output/configuration and uncertain network outcomes fail
closed. Terminal failure blocks unlimited re-reservation. A changed generation configuration
is a different cache/job identity, as expected.

There is no background worker. Subsequent requests claim queued/due retry work. Expired running
leases are **not automatically reclaimed** because the upstream paid-call outcome could be
uncertain. An interrupted process/save failure leaves the claim fenced and eventually surfaces
`JOB_RECOVERY_REQUIRED`. Operator recovery must confirm the original call is no longer active,
inspect any saved output, and approve a bounded requeue or permanent failure. No automatic
repair/reset command is included. Stale lease tokens cannot publish content.

## 3. Reviewed RLS / controlled APIs

All four tables enable RLS. Both `anon` and `authenticated`, plus PUBLIC, have **no direct
table grants or read/write policies**. All reservation/acquisition/claim/finalization/read RPCs
deny execution to those roles. Trigger helpers use a fixed empty search path, live outside API
schemas and deny browser execution. Service-role grants are explicit. PostgreSQL default API
grants are revoked on these objects only; unrelated tables/default privileges are not changed.

No anonymous database writes were enabled. The unauthenticated local MVP has one controlled
backend POST API: it validates a supported HTTPS YouTube URL, accepts only bounded transcript
input with consent, and fixes output/model/prompt/settings server-side. It does not accept source,
job, student or document UUIDs; arbitrary URLs are never fetched. Every published output read
rechecks source type/visibility, video identity, output state and expiry. Documents are excluded
even if someone later marks a document published. The secret key bypasses RLS, so these backend
checks must not be removed. Browser public keys cannot access resource tables directly.

Existing CORS allowlisting, Helmet and API rate limiting remain. The notes route has a 30/minute
per-IP limit; a per-process gate allows only two active generations. Bodies are capped at 100 KiB,
manual transcripts at 40,000 JS characters / 80,000 UTF-8 bytes, model output at 8,192 tokens and
100,000 response characters. Unknown SDK/driver exceptions are not serialized into logs.
Authorization, API-key and cookie headers are redacted. No keys or transcript text are logged.

These are local MVP controls, not a distributed production abuse/billing system. CORS is not
authentication. A public deployment would need distributed quotas, abuse protection, moderation,
budget controls and operator recovery—not relaxed RLS. Deployment is out of scope.

## 4. Migration status and safe hosted procedure

The original B2 report stated that its initial migration was never pushed. Inspection found no
active backend credentials and no local linked-project reference. On that basis the initial file
was corrected in place; no compensating drop migration was created. Hosted history remains
independently unverified: if the old migration was applied outside this session, **stop** and
review a forward-only migration/retention plan. Do not push a rewritten historical migration or
drop account/unrelated tables automatically.

Both actual SQL migrations were applied successfully to embedded PostgreSQL tests. No hosted
push, database reset, seed, account creation, unrelated DROP or hosted auth setting change occurred.
No database password from chat was used. Rotate the password shared in chat and enter the new
value only at your local terminal prompt if needed.

CLI **3.2.0** commands attempted:

- `migration list --remote`: stopped, no linked project.
- `db push --remote --dry-run --skip-vault`: stopped, no linked project; no successful dry run claimed.
- `db query --remote=hotreszoeqtsidpcbcaf --read-only --file supabase/preflight.sql`:
  explicitly targeted the intended ref, but stopped because CLI login/access token was absent;
  its target environment was reported unverified.

From the repository root, in **your local terminal**, after rotating the exposed password:

```sh
npx --yes supabase@3.2.0 login
npx --yes supabase@3.2.0 link --project-ref hotreszoeqtsidpcbcaf
cat supabase/.temp/project-ref
```

Verify that metadata prints exactly `hotreszoeqtsidpcbcaf`, and compare with your Dashboard
project's URL/reference. Do not trust `current_database()` alone as project identification.
Stop if a different project/branch is shown. Enter any requested database password at the prompt,
not in chat, command arguments or recorded logs. The npm `--yes` only installs the pinned runner;
do not pass a CLI `--yes` to bypass hosted-change approval.

Show and review the SQL, then perform read-only preflight/history and dry run:

```sh
cat supabase/migrations/20261121000100_b2_learning_foundation.sql
cat supabase/migrations/20261121000200_b3_notes_workflow.sql
npx --yes supabase@3.2.0 db query --remote --read-only --file supabase/preflight.sql
npx --yes supabase@3.2.0 migration list --remote
npx --yes supabase@3.2.0 db push --remote --dry-run --skip-vault
```

`supabase/preflight.sql` checks PostgreSQL version, collisions, old account objects, helper schema
and RPC/trigger names. Review every result and existing migration history. Match local
`db.major_version` (currently 17) to the hosted major version. Back up any existing hosted data
using your plan's supported process. Any collision/old B2 object requires review, not a DROP,
`IF NOT EXISTS` workaround or blind migration-history repair.

Only after the target, SQL and successful dry run have been reviewed/approved:

```sh
npx --yes supabase@3.2.0 db push --remote --skip-vault
npx --yes supabase@3.2.0 migration list --remote
```

Do not run `db reset`, `migration repair`, `--include-all`, `--include-seed` or unrelated DROP
commands. Editing `supabase/config.toml` configures local development only, not the dashboard.
Review hosted table/function grants and Security Advisor after applying. Student auth setup,
SMTP, login redirects and signup are not required for this MVP.

## 5. Hosted connection status

**Not verified.** `npm run supabase:check` (from backend/) stopped because the local backend
URL/secret pair was absent. The supplied public URL/key are stored only in the ignored
`frontend/.env.local`; templates contain blanks. There is no frontend Supabase client.

After configuring backend credentials and applying reviewed migrations, run:

```sh
# backend/
npm run supabase:check
```

This script enforces the intended project URL, makes head-only table probes and an empty,
read-only notes RPC query. It never writes or prints data/keys. A successful probe verifies the
server connection and required tables/read RPC, not all migration history, grants or concurrency.

## 6. Gemini integration and model availability

Backend runtime uses official **`@google/genai` 3.6.1**; nothing calls Gemini from the browser.
No default model ID is guessed. `GEMINI_MODEL` must be configured explicitly. Floating `latest`
aliases are rejected. Before generation, official `models.get` verifies the exact name,
`generateContent` support and sufficient input/output capacity; metadata verification is cached
for five minutes. UTF-8 input bytes plus instruction margin form a conservative token ceiling.
Actual structured-output support/access is finally proven by the generation response.

The SDK gets separate system instructions and JSON-quoted transcript data. No URL-context,
search, function, video or other tools are enabled. Instructions restrict output to educational
notes, resist transcript-embedded instructions, disclose uncertainty and prohibit fabricated
actual PYQs. The JSON schema comes from the shared Zod schema; output must complete with STOP,
parse as JSON and pass Zod before publishing. The frontend validates the same response contract
and renders strings as escaped React text, never raw HTML.

SDK timeouts are 60 seconds with **one** transport attempt. No hidden generation retries.
Quota/temporary failures are safely classified without raw messages; bounded job retries are
database-controlled. A cache hit calls neither `models.get` nor `generateContent`.

**Live status:** `npm run gemini:models` stopped because no local key exists. No account-specific
model availability, structured output or quota access was verified, and no real generation was
called. Official model documentation was inspected, but public documentation is not proof of
availability under your key. From backend/, set the key first and run:

```sh
npm run gemini:models
```

Choose an exact text/structured-output-capable ID returned for your key, with at least 8,192
output tokens and enough input capacity. Configure it in `GEMINI_MODEL`; restart the backend.
No fallback model or paid provider is silently selected. Models can change/retire: review provider
deprecations and bump prompt/config identity if a provider silently remaps a stable model.

## 7. Transcript availability and limitations

**Automatic URL-only extraction is not enabled.** A URL contains identity, not captions.
Official [YouTube captions.download](https://developers.google.com/youtube/v3/docs/captions/download)
requires OAuth and permission to edit the video. It is not an arbitrary public lecture-caption API.
Authorized channel/editor OAuth and licensed-provider arrangements require separate approval,
credentials and rights/retention review. None is configured here. No scraping library, cookies,
video downloading, browser extraction or unapproved paid service was installed/called.

`TranscriptProvider` preserves explicit `available`, `unavailable`, `authorization_required`
and `temporarily_failed` states via B1 contracts. Its current implementation reports
`provider_not_configured`. If there is no usable saved transcript, the frontend asks for text
copied manually from YouTube's **Show transcript** feature, when available. Save provenance is
`manual` with provider `youtube_show_transcript`, version `manual-v1`; it does not certify that
the student actually copied from YouTube. PG computes the content hash.

Students must affirm rights to share and absence of private information. Saved YouTube transcripts
and notes are shared, not private uploads. Existing active text wins; later public submissions
cannot overwrite it. A malicious/incorrect first submission can still poison a video's shared
transcript. Hashing verifies content identity, not truth or rights. Moderation/correction controls
are unresolved and needed before public deployment. If captions are missing, don't invent them.
Long transcripts require a shorter excerpt; automatic chunking/summarization is not implemented.
Notes are English; transcript selection supports English, Hindi and undetermined in the UI.

Future provider results are validated for video/language/hash/expiry. Expiring licensed transcripts
are explicitly rejected until retention handling is implemented; no provider with such requirements
can be enabled accidentally under this MVP.

## 8. Files changed / preserved UI

New runtime files:

- `contracts/src/notes.ts`: additive request/output/outcome schemas; package now 1.2.0.
- `backend/src/modules/ai/gemini-notes.ts`: model checks, SDK generation and validation.
- `backend/src/modules/extraction/transcript-provider.ts`: compliant unavailable adapter.
- `backend/src/repositories/notes.repository.ts`, `services/notes.service.ts`,
  `controllers/notes.controller.ts`, `routes/notes.routes.ts`: controlled workflow.
- `frontend/src/features/workspace/{notes-api.ts,DetailedNotesPanel.tsx}`: API validation,
  manual fallback, genuine loading/errors, bounded pending-job polling and escaped note rendering.
- `backend/scripts/{gemini-models.mjs,check-supabase.mjs}`, `supabase/preflight.sql`:
  safe manual availability/connection/preflight helpers.

Updated routes/providers/navigation, `/assistant`, status copy, API helper, environment validation,
log redaction/error classification, local Supabase config, shared exports, manifests/lockfiles,
test compilation scope, both placeholder env templates, README and phase docs. The only actual
credential file added contains supplied **public** frontend configuration and is ignored by git.
The backend secret/key/password were not written to files.

New/updated tests: `contracts/tests/notes.test.mjs`,
`backend/tests/{database-foundation,notes-workflow,gemini-notes}.test.mjs`,
`backend/tests/helpers/database.mjs`, `frontend/tests/{notes-api,supabase-env}.test.mjs`.

B1 parsing/versioned contracts, all six B1.5 selections, local file checks and Continue's honest
selection confirmation remain. Generate detailed notes is a separate action beneath that preview;
only a selected YouTube + Detailed notes can invoke it. No other selected outputs are generated.
Changing video cancels UI polling and clears that component's state. Cancelling a browser request
does not cancel the already claimed backend paid job. Results clearly say cached vs generated and
identify manual provenance. No fake progress/content is displayed.

## 9. Tests and exact results

Final verification after the last runtime edits:

| Check                 | Result                                           |
| --------------------- | ------------------------------------------------ |
| Backend `npm test`    | 134 passed, 0 failed                             |
| Frontend `npm test`   | 134 passed, 0 failed                             |
| Contracts `npm test`  | 103 passed, 0 failed                             |
| TypeScript            | Passed in all three packages                     |
| ESLint                | Passed in both apps and shared contracts         |
| Production builds     | Passed in all three packages                     |
| Changed-file Prettier | Passed for changed TS/TSX/JS/JSON/Markdown files |

Frontend build retains a non-blocking Vite warning about a config import without a file
extension and future native config-loader compatibility. SQL was verified by execution in
embedded PG, not by a claimed hosted lint/preflight.

Browser review used the actual frontend at localhost:5173 and a temporary unconfigured
backend on port 4010 (the local env's default remains 4000). Verified API online, all six
selections, enabled detailed-notes action for a valid synthetic YouTube identity and the real
`The learning database is not configured` error. Console showed only the expected failed
503 resource request, no uncaught application error. No browser-ready notes/manual fallback
integration or actual video was claimed: that path remains covered by mocked/embedded tests
until hosted credentials are available. Temporary review servers were stopped afterward.

All tests use synthetic fixtures. Database tests execute both actual migrations, constraints,
triggers/RLS/grants and all RPCs on **PGlite embedded PostgreSQL**. Only Supabase's managed roles
and minimal `auth.users` are simulated. Workflow tests use those SQL functions with mocked Gemini.
The official Gemini SDK also has a mocked HTTP transport serialization test. Frontend tests mock
API responses and validate outcomes; contracts tests retain original compatibility coverage.

Covered: canonical source/transcript reuse, provider-unavailable/manual fallback, consent/size
limits, cache dimensions/hits/misses, no duplicate Gemini call on hit, malformed/blocked/truncated
model output, quota/failure/cooldown, active-job uniqueness, token fencing, private-document
exclusion, denied database reads/writes/RPCs, HTTP errors and overlapping service requests using
independent service instances. No mock is reported as live integration.

PGlite serializes SQL on one connection. Overlapping JavaScript request tests prove orchestration
and the claim path, **not native multi-connection lock contention or production load**. Native
PostgreSQL/Docker/psql were unavailable. Before public traffic, test two real connections against
a disposable local Supabase database and verify exactly one successful claim/paid call. No hosted
fixtures or deletes should be used for that test without separate review.

Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` from both apps; contracts has
`npm test`, `npm run typecheck`, `npm run build`. Shared ESLint can be run as documented in the
contracts README. There is no new root workspace.

## 10. Exact local environment configuration

Do not overwrite existing env files. Examples have placeholders only. These paths are ignored.

`frontend/.env.local` already has the supplied public project URL/key and default API URL:

```dotenv
VITE_API_BASE_URL=http://localhost:4000/api/v1
VITE_SUPABASE_URL=https://hotreszoeqtsidpcbcaf.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<your supplied sb_publishable key>
```

The frontend's project configuration is reserved/validated but is **not** used to query the DB.
Vite rejects wrongly-prefixed server/Gemini/Google keys before bundling. Every VITE variable is
public. Never place Gemini keys, the Supabase secret or database password there.

Create/configure **`backend/.env` locally** using the existing example, retaining runtime values:

```dotenv
NODE_ENV=development
PORT=4000
LOG_LEVEL=info
SERVICE_VERSION=0.1.0
FRONTEND_ORIGIN=http://localhost:5173,http://127.0.0.1:5173
SUPABASE_URL=https://hotreszoeqtsidpcbcaf.supabase.co
SUPABASE_SECRET_KEY=<server-only sb_secret key from Supabase Settings / API Keys>
GEMINI_API_KEY=<your Gemini API key>
GEMINI_MODEL=<exact verified model ID from npm run gemini:models>
```

For initial model listing, the script reads only `GEMINI_API_KEY`; set `GEMINI_MODEL` after listing.
App startup rejects partial Supabase/Gemini pairs, malformed endpoints/keys and floating model
aliases. Both pairs may remain blank for health/preview-only mode. Use only modern Supabase
publishable/secret keys, not legacy JWT keys. No database password belongs in app env files.

Restart both processes after edits. If port 4000 is occupied by a different app, choose another
backend PORT and update VITE_API_BASE_URL accordingly; never kill unrelated processes. CORS must
include the exact frontend origin. No login/SMTP/dashboard auth setup is required.

## 11. Test a real YouTube URL

1. Rotate the exposed database password. Complete CLI login, verified linking, preflight, SQL
   review, successful dry run and reviewed migration push from section 4.
2. Configure the server-only keys locally. Run `npm run supabase:check` and
   `npm run gemini:models` from backend/. Select/configure a supported model ID.
3. From backend/ run `npm run dev`; from frontend/ run `npm run dev`. Check the topbar says
   API online and `/api/v1/health` returns OK. Open `http://localhost:5173/assistant`.
4. Select YouTube, paste a real supported HTTPS lecture URL, select **Detailed notes**, and
   click **Generate detailed notes** beneath the workspace. Other outputs remain preview only.
5. If no shared transcript exists, the UI explicitly says automatic extraction is unavailable.
   Open the lecture in YouTube yourself, use Show transcript when available, copy the permitted
   text, paste it, select its language, and confirm public-sharing consent. Click Generate again.
6. Wait for the real backend response. A ready result must say **Generated and saved** and show
   structured notes beneath the workspace. An error must remain an error, not substitute content.
7. Reload or use a second browser with the same URL/language, select Detailed notes and Generate.
   It should say **Reused from shared cache** without asking for text or calling Gemini again.
8. For a different uncached permitted lecture, use two browsers simultaneously. One claims the
   job; the other shows pending and then cached notes. Check server/DB job state, not UI labels
   alone. Changing model/prompt/schema/settings creates a new generation identity.

If captions are unavailable or you don't have permission to share them, stop. Do not scrape or
invent transcript text. Quota errors permit a bounded retry after 60 seconds; uncertain/interrupted
jobs require operator review. A real end-to-end test has **not** run in this implementation session
because hosted credentials, migration verification, a model and permitted transcript were absent.

## 12. Unresolved risks / stop boundary

- Hosted schema/history/version/grants and real PostgREST/RPC compatibility are unverified.
- Account-specific Gemini model/structured-output availability, quotas and real generation remain
  unverified. Model retirement/remapping can affect output cache semantics.
- Single-connection embedded testing is not a native concurrency/load test.
- First manual submission is shared/unverified; rights, misinformation and prompt injection need
  review/moderation. Hashing and separate instructions are not a semantic trust guarantee.
- Interrupted paid jobs deliberately block rather than risking duplicate calls; manual recovery,
  queue durability, distributed quotas and monitoring are future work.
- No automatic long-transcript chunking, arbitrary-video caption API or provider retention policy.
- Dormant document schema is private; no document access/upload/publication/delete workflow exists.

No profiles/accounts, PDF/CSV processing, OCR, ImageKit/R2, Gallery redesign, actual PYQ retrieval
or deployment was implemented. **Stop after this milestone and wait for approval.**
