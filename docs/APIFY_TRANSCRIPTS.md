# Automatic YouTube transcripts (local implementation)

> **Historical Apify implementation, now superseded.** Runtime Apify code and tests
> were replaced by the official TranscriptFetch SDK. Do not use the configuration
> instructions below for the current backend. See
> [`TRANSCRIPTFETCH_TRANSCRIPTS.md`](./TRANSCRIPTFETCH_TRANSCRIPTS.md).
> Migration `20261121000300` is preserved unchanged; a local forward-only `00400`
> changes future persistence labels and adds private usage accounting. The file
> inventory and verification results below describe the previous implementation.

## Configuration and review gate

In ignored `backend/.env`, configure `APIFY_API_TOKEN` and
`APIFY_ACTOR_ID=faVsWy9VTSNVIhWpR`. Both blank keeps manual-only mode. Never
use `VITE_` for these variables; the frontend build rejects Apify token/key names.
Supabase and Gemini still require their existing paired backend configuration.
No new dependency, student account, profile, or frontend credential is introduced.

**Review the local migration `supabase/migrations/20261121000300_apify_transcript_extraction.sql`
before applying it yourself. Nothing was pushed remotely.** It requires the corrected
B2/B3 schema; do not rewrite applied history. Follow target/history/preflight/dry-run
verification in `docs/PHASE_B3.md` and inspect the new private table/RPC names for collisions.
The old `supabase/preflight.sql` only checks B2/B3 names, not this migration.

## Workflow and storage

Select detailed notes and click Continue in `/assistant`. The existing canonical URL
validator runs before any provider spend. The backend checks Supabase's shared
video/language transcript cache first. On a miss it reserves extraction in PostgreSQL,
starts the Actor with **only** `videoUrl` and `targetLanguage`, records its run ID,
polls status, retrieves dataset items, validates segments, and atomically persists.
Existing Gemini generation/claims/configuration-aware notes caching then continue.
The UI reports extraction/pending state without fabricated percentages; manual paste
and sharing consent remain available, including after storage errors.

The four public resource tables are preserved. A new RLS-enabled, non-exposed
`ll_private.transcript_extractions` table records status, token, run ID, lease, safe
error code and timestamps for each canonical source/language. Four public RPCs
are SECURITY INVOKER with empty search paths and executable by service_role only.
No anon/authenticated reads, writes or RPC access is granted. Parent row locks
serialize extraction persistence with existing manual acquisition. A manual race
winner is reused, never overwritten or relabelled.

Timestamp segments are stored on initial insert in existing immutable
`transcripts.metadata.segments`, with `{start: number, duration: number, text: string}`.
Metadata also stores `requestedLanguage` and `extractedAt`; the existing row retains
language, content hash, provenance, provider version, obtained/created timestamps.
Retrieval includes metadata; Gemini continues to consume the normalized text.
`returnedLanguage` is omitted because the supplied sample does not confirm it.
`licensed_provider` is the existing external-provider provenance category, **not an
independent certification of the Actor's license or caption authenticity**.

## Verified output and limitations

The supplied verified fields are `start` and `dur` as decimal-second strings, and
nonempty `text`. Their partial Hindi sample is in
`backend/tests/fixtures/apify-segments.json`. Numeric values must be finite and
nonnegative. Invalid segments are discarded; all-invalid/empty output gives a
manual-fallback error. Valid segments preserve dataset order, including overlapping
timestamps, and text is joined with spaces. Oversized lectures are rejected, not
silently truncated (40,000 characters / 80 KB UTF-8 for the current notes workflow).

The parser supports top-level segment items and dataset items that are arrays of
segments. **The complete Actor dataset envelope remains unverified.** Unknown
object wrappers are rejected; supply a complete sanitized item if this Actor nests
segments under another property. No guessed title, channel, views, caption type,
returned language, or automatic/original-language mode is added.
`en` and `hi` map directly to the tested `targetLanguage` inputs. Neither means
verified translation. Manual versus auto-generated caption origin cannot be
distinguished from this segment sample. Private, restricted, unavailable and
caption-disabled videos may fail; the code supplies no cookies, login, bypass
flags, downloads, DRM handling, or access-control workaround.

## Cost and resilience

- Async REST start with server-enforced 60-second Actor timeout, automatic restarts
  disabled, and `maxTotalChargeUsd=0.50`. This is an Apify run cap, not a quoted
  extraction price or guarantee about external/platform charges or subscriptions.
  An Actor minimum above the cap fails rather than increasing spend automatically.
  Check the actual Actor pricing and account budget before enabling.
- Limited Actor permissions are explicitly forced. If the Actor requires broader
  access, extraction fails; review its code/permissions rather than elevating it.
- Authorization is a Bearer header to fixed HTTPS `api.apify.com`; redirects are
  rejected. Tokens, raw HTTP errors, dataset contents and run IDs are not logged
  or returned to students. Use a scoped token with only needed Actor/run/storage
  access and keep account storage private.
- 10-second HTTP request timeout; 75-second provider deadline; up to 30 polls at
  2-second intervals. Known failed/interrupted runs get a best-effort 5-second
  abort. Unknown start outcomes cannot be aborted by ID; the Actor timeout bounds them.
- Run-start POST is **never retried**. Safe GETs alone have at most two retries
  for transport failures, 429 or 5xx with 1/2-second backoff. Authentication,
  permission, billing and other non-transient failures are not retried.
- At most 10,000 segment/items, one bounded dataset request (limit 10,001 detects
  overflow), and 2 MB streamed response limit. No unbounded pagination/download.
- Database-global gate allows two active extractions and ten new reservations per
  minute, alongside the existing endpoint IP rate limit. This is not a complete
  production abuse/budget system.
- 120-second lease/token fencing prevents duplicate multi-process paid runs.
  Failure releases active capacity but retains the failed reservation. Failed or
  expired/uncertain runs are **not restarted automatically**, even on repeated UI
  requests. Operator recovery must inspect the recorded Apify run, billing and
  cache, ensure the run is terminal, and review a targeted recovery action.
  No automatic remote cleanup/history repair is implemented. A lost database
  response after a paid call stays fenced. Manual paste bypasses extraction.

## Privacy, security and terms evaluation

User-directed integration of this tested Actor does not establish blanket YouTube
permission. Only canonical public lecture URLs and requested language are submitted;
no student profile, private document, pasted transcript, Google/Supabase secret or
YouTube login credential is sent to Apify. Actor input/output are stored with runs,
and community Actor code may have its own processing/dependencies.

Apify documents isolation, encryption and SOC 2, but its shared-responsibility
policy assigns Actor trust, data retention and legal compliance to the customer.
Before production use, review this Actor's author/code/build/maintenance, platform
and Actor contract, output reuse rights, YouTube terms, retention/deletion settings,
subprocessors and regional transfers. The Actor build is not pinned because no
tested build number was supplied; output schema changes fail closed. Configure
private run/storage access and retention in Apify Console; this implementation
does not automatically delete remote datasets. No live Actor/code audit or
independent licensing/access-method attestation has been performed.

References reviewed:

- https://docs.apify.com/api/v2/actors-runs-post.md
- https://docs.apify.com/api/v2/dataset-items-get.md
- https://docs.apify.com/security.md
- https://docs.apify.com/security/shared-responsibility.md
- https://docs.apify.com/legal/privacy-policy.md
- https://docs.apify.com/legal/actor-terms-and-conditions.md
- https://developers.google.com/youtube/v3/docs/captions/download

## Automated verification

All HTTP/provider/Gemini calls in added tests are mocked; persistence/leases/RLS
are exercised against the local embedded PostgreSQL engine. Tests cover the verified
sample, en/hi mapping, malformed/empty/oversized data, invalid URLs, run failures,
timeouts, GET retry limits, billing/auth failures, concurrent reservation, cache
reuse, manual races, stale/expired tokens and URL → transcript → notes.
Embedded PostgreSQL serializes its connection; native multi-connection contention,
hosted PostgREST and live Actor envelope/permissions/availability remain unverified.

### Results

- Backend: 188 tests passed, zero failures; typecheck, ESLint and build passed.
- Frontend: 134 tests passed, zero failures; typecheck, ESLint and build passed.
- Contracts: 105 tests passed, zero failures; typecheck and build passed.
- Prettier check passed for all changed supported code/JSON/Markdown files.
- Existing nonblocking Vite warning remains: extensionless config import and future
  native config-loader compatibility.
- No live Apify/Gemini calls, Supabase connection, remote SQL, migration push,
  deployment or commit. Build/test scripts refreshed their usual generated artifacts.

### Exact authored file inventory

```text
backend/.env.example
backend/src/config/env-schema.ts
backend/src/controllers/notes.controller.ts
backend/src/modules/extraction/apify-transcript.ts
backend/src/modules/extraction/transcript-provider.ts
backend/src/repositories/notes.repository.ts
backend/src/repositories/transcript-extraction.repository.ts
backend/src/services/notes.service.ts
backend/src/services/transcript-extraction.service.ts
backend/tests/apify-transcript.test.mjs
backend/tests/fixtures/apify-segments.json
backend/tests/helpers/database.mjs
backend/tests/notes-workflow.test.mjs
backend/tests/transcript-extraction-workflow.test.mjs
contracts/src/learning.ts
contracts/src/notes.ts
contracts/tests/notes.test.mjs
frontend/src/features/workspace/DetailedNotesPanel.tsx
frontend/src/features/workspace/notes-api.ts
frontend/src/lib/supabase-env.ts
frontend/src/pages/AIWorkspacePage.tsx
frontend/tests/notes-api.test.mjs
frontend/tests/supabase-env.test.mjs
supabase/migrations/20261121000300_apify_transcript_extraction.sql
docs/APIFY_TRANSCRIPTS.md
docs/PHASE_B3.md
```
