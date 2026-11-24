# Groq primary / FreeGG fallback

## Architecture and scope

The existing notebook generation boundary now uses a single provider manager:

```text
Study generation / Detailed Ask
  existing schema/prompt generator
    request-local long-source processor
      provider manager (bounded concurrency, cooldown, aggregate usage)
        Groq official SDK -> FreeGG Responses adapter

Quick/Auto Ask -> existing Gemini integration, unchanged (including backup key)
Original PDFs -> FreeGG directly (capability routing; no Groq PDF support / no local OCR)
```

No new API routes, database tables, migrations, persistent queues, student caches or
activity records are added. API notebook schemas, PDF handwriting, authentication,
gallery, extraction, caption acquisition and existing route-level limits are preserved.
Application services still use their existing configured-generator functions; individual
SDKs are isolated behind compatible transport adapters. `AI_PROVIDER=gemini` retains
the existing optional Gemini study implementation when `AI_PRIMARY_PROVIDER` is absent.
Detailed Ask still uses the study manager independently of this legacy Gemini override.

## Render environment

Set these **backend-only** values in Render's Environment dashboard:

```dotenv
GROQ_API_KEY=<your Groq key>
GROQ_MODEL=openai/gpt-oss-120b
GROQ_ENABLED=true
FREEGG_API_KEY=<your FreeGG bearer key, without the Bearer prefix>
FREEGG_BASE_URL=https://freegg.app/v1
FREEGG_MODEL=gpt-6.1-sol
FREEGG_ENABLED=true
AI_PRIMARY_PROVIDER=groq
AI_FALLBACK_PROVIDER=freegg
```

Leave all existing Gemini variables untouched. Never create `VITE_GROQ_API_KEY` or
`VITE_FREEGG_API_KEY`; frontend production builds reject these accidental secrets
without printing their values. Do not commit your actual `.env`.

Missing FreeGG credentials do **not** block text generation on Groq. Original PDF
generation needs FreeGG. Missing/disabled primary credentials produce a safe
`AI_CONFIGURATION` request-time error: there is no silent authentication bypass.
Explicitly set `AI_PRIMARY_PROVIDER=freegg` to operate on FreeGG alone, optionally
`AI_FALLBACK_PROVIDER=none`. Fallback may also be `groq`; equal primary/fallback values
are coalesced into a single provider. Valid provider selections are groq/freegg;
`none` is valid only for the fallback. New primary settings override legacy `AI_PROVIDER`.
The health endpoint stays available without AI credentials; no startup AI generation
or quota-consuming model probe is performed. Malformed configuration fails validation
with field names and safe messages, never secret values.

### Optional limits

| Variable                     | Default | Purpose                                                                          |
| ---------------------------- | ------- | -------------------------------------------------------------------------------- |
| `AI_TIMEOUT_MS`              | 120000  | Per-provider attempt deadline (1–180 seconds)                                    |
| `AI_JOB_TIMEOUT_MS`          | 540000  | Active output-generation deadline, including chunking/queue time                 |
| `AI_MAX_OUTPUT_TOKENS`       | 4096    | Application output ceiling per provider call                                     |
| `AI_TEMPERATURE`             | 0.2     | Sampling temperature (0–2)                                                       |
| `GROQ_CONTEXT_TOKENS`        | 131072  | Model context bound; configure explicitly when changing models                   |
| `GROQ_MAX_OUTPUT_TOKENS`     | 65536   | Model output bound; configure explicitly when changing models                    |
| `AI_MAX_CONCURRENCY`         | 1       | Maximum concurrent study-provider calls per backend process (1–4)                |
| `AI_MAX_QUEUE`               | 8       | Maximum in-memory waiting calls (0–32)                                           |
| `AI_MIN_REQUEST_INTERVAL_MS` | 2000    | Minimum per-provider dispatch spacing                                            |
| `AI_MAX_RETRIES`             | 1       | Maximum same-provider retries, only for definitive retryable HTTP failures (0–2) |
| `AI_MAX_RETRY_WAIT_MS`       | 5000    | Maximum acceptable same-provider backoff; longer waits fail safely               |
| `AI_CHUNK_TOKENS`            | 2000    | Conservative estimated input tokens per source chunk (1000–24000)                |
| `AI_CHUNK_OVERLAP_TOKENS`    | 150     | Small contextual overlap between source chunks (0–1000)                          |
| `AI_MAX_CHUNKS`              | 128     | Maximum source chunks (1–256); excess fails explicitly, never truncates          |

Keep the existing `TRANSCRIPT_MAX_CHARACTERS=500000` for long lectures. Token counts
use the maintained o200k tokenizer with a 20% safety reserve and prompt/output
headroom; o200k is an estimator, **not** an exact GPT-OSS tokenizer. Model-specific
tokenizers/rate limits can differ. Unknown Groq model IDs require operator-confirmed
context/output limits; defaults describe the requested GPT-OSS 120B model, not every
possible model. No unsupported tools, web search or paid infrastructure are enabled.

## Verified API documentation

- Groq's official [model list](https://console.groq.com/docs/models) lists
  `openai/gpt-oss-120b` with 131072 context and 65536 maximum completion tokens.
  The official `groq-sdk` calls `https://api.groq.com/openai/v1/chat/completions`,
  server-side only, with system/user messages and JSON-object output. Its automatic
  retries are disabled; the manager owns retries/fallback.
- FreeGG's public `https://freegg.app/api/status` identified `server_address` as
  `https://freegg.app` and linked `docs_link=https://docs.newapi.pro`. That official
  gateway documentation redirects to New API's documentation. Its
  [Responses API reference](https://docs.newapi.ai/en/docs/api/ai-model/chat/openai/createresponse)
  confirms **POST `/v1/responses`**, **Bearer authentication**, model/input,
  temperature, max_output_tokens, completed output messages and token usage.
  LectureLens retains its existing Responses implementation, rather than inventing
  a Chat Completions endpoint for FreeGG. The existing input_file/PDF behavior was
  previously exercised live in this project; PDF/model availability remains
  account/upstream-dependent, and this task makes no live generation request.

The transport/base URL/authentication contract is verified. Your account's enabled
FreeGG model list, quota and `gpt-6.1-sol` access are **not** independently verified
without an authorized key; select the exact model available in your dashboard.
Use an explicitly trusted HTTPS base URL ending in `/v1` (not `/responses`). URL
validation rejects credentials, query strings, IP literals and local-only hostnames;
administrators must not point it at an untrusted gateway, which would receive the key.

## Fallback, rate limits and duplicate-call risk

1. Text calls use Groq first. A successful complete response is parsed and validated
   against existing notebook/output schemas before anything is published.
2. 429, 5xx, network and attempt-timeout failures allow one sequential FreeGG fallback.
   Authentication, permission, model/endpoint configuration, invalid requests and
   malformed/incomplete completed outputs do **not** trigger automatic fallback.
3. Retry-After (seconds or HTTP date) controls that provider's in-memory cooldown.
   A different provider may run immediately: one provider's cooldown does not block
   the other provider. Subsequent chunks skip a cooling-down provider.
4. If no other provider can be attempted, definitive retryable HTTP failures may
   receive a bounded exponential+jitter retry, only when the wait fits the configured
   maximum. Timeouts and uncertain network failures are never replayed on the same key.
5. Both unavailable yields a safe `AI_UNAVAILABLE` error; a saturated queue yields
   `AI_BUSY`. No upstream error body, prompt, transcript, key or student identifier
   appears in manager logs. Retryable errors carry a retry delay.

Timeout/network fallback is intentionally enabled per this task. The original
provider may have consumed quota even if its response was lost: cross-provider
fallback cannot guarantee exactly-once generation. No SDK or infinite retries hide
extra calls. A client disconnect cancels active study/Detailed Ask work and queued
requests, without starting further chunks/fallback. Gemini Quick behavior is unchanged.

## Large transcripts and educational quality

Sources approaching 500000 characters are split **before provider requests** using
estimated tokens and paragraph boundaries, with a small overlap and no missing core
characters or split surrogate pairs. Chunks run sequentially. The existing NDJSON
progress events report completed/total chunks. Each chunk receives the original
educational instructions, requested output/language/preferences and source position.
Notes prompts request detailed explanations, definitions, examples, formulas, useful
tables/diagrams, applications and conclusions only when supported by the source;
no fabricated syllabus or exam provenance. The existing English-output policy remains.

Validated completed chunks remain in the active request's memory when a later chunk
fails over or retries. Identical chunks share results **only within that output run**.
Merging removes exact duplicate overlap, coalesces compatible paragraphs without
discarding text, and preserves unique definitions/formulas/graphs. Bounded quizzes
and flashcards are distributed across source parts; if there are more parts than
requested items, the final practice set samples evenly across the source. Too few
distinct questions fails explicitly rather than padding with duplicates.

The existing contract caps notebooks at **160 blocks**, **5000 characters per prose
block**, and **12 limitations**. Chunk prompts budget substantial blocks across the
full source. If the complete merged result cannot fit, `AI_OUTPUT_LIMIT` asks for a
smaller source; blocks/warnings are not silently sliced away. This is a bounded
large-source pipeline, not a guarantee of unlimited exhaustive notes within a fixed
schema, deadline or free quota. Incompatible final outputs are never labeled success.

There is **no persistent checkpoint or cross-request cache**: that would violate the
existing no-student-persistence requirement. Reload, disconnect, terminal failure or
restart discards request-local work; user Retry starts again. Already returned
successful output types remain page-local while failed output types can be retried.

## Usage and free-tier protection

The manager retains **anonymous aggregate counters only**: dispatched requests,
successful provider completions, failures and reported input/output tokens, by provider.
`snapshot()` is available internally/tests; no public usage endpoint or student usage
records are added. Safe structured logs record provider/model/attempt/outcome and
available numeric usage. Usage is not guessed when absent, and reported completion
counts do not imply notebook schema validation succeeded. Failed/time-out calls can
consume quota without usage metadata. Counters/cooldowns reset on restart and are
per-process, not a distributed quota ledger.

Groq's [published free-plan limits](https://console.groq.com/docs/rate-limits) currently
list GPT-OSS 120B at 30 RPM, 1000 RPD, 8000 TPM and 200000 TPD (organization-wide).
The 2000-token chunk estimate and 4096-token output ceiling leave room for the existing
prompt/schema within that per-minute scale; multiple requests, model reasoning,
account-specific limits and reset timing can still exhaust it. This is not a quota
reservation guarantee. Higher-throughput accounts may explicitly raise chunk/output
budgets within the validated model context bounds.

Free tiers are account/model-specific, finite and changeable. Tune chunk/output budgets,
spacing/concurrency against your dashboard limits; defaults do not promise free-tier
compatibility for every large request. There is no paid fallback or subscription setup.

## Build, deployment and troubleshooting

Repository-root Render commands remain:

```sh
npm --prefix contracts ci && npm --prefix backend ci && npm --prefix backend run build
npm --prefix backend start
```

Health check remains `/api/v1/health`; `render.yaml` keeps auto-deployment off.
After reviewing and committing/pushing **yourself**, set the environment above and
manually deploy the latest backend commit in Render. Manually configured services
must use the build/start commands above. Deploy the frontend to Vercel for the updated
Detailed provider label and secret guard; keep the existing `VITE_API_BASE_URL`.
This implementation does not deploy, migrate, commit or push anything.

- `AI_CONFIGURATION`: check selected provider's enabled flag, key, exact model and URL.
- `AI_QUOTA`/`AI_UNAVAILABLE`: inspect quota dashboard and safe provider outcome logs;
  honor retry delay, lower concurrency/output/chunk budgets or wait for quota reset.
- `AI_SOURCE_LIMIT`/`AI_OUTPUT_LIMIT`: reduce source scope or review bounded chunk settings;
  do not remove content automatically or raise schema limits without a contract review.
- `AI_REQUEST_INVALID`: verify model limits and input/schema compatibility, not just keys.
- `AI_INVALID_OUTPUT`: no partial notes were accepted; manual Retry can generate anew.
- Original PDFs fail while text works: check FreeGG key/model/PDF access. Groq cannot
  replace the PDF capability of the configured FreeGG model.
- Render still emits the old Chromium-install PDF error: deploy the current backend;
  changing AI variables or Vercel alone cannot update the exporter.

Tests use mocked SDK/HTTP providers, including the complete notes workflow and original
PDF transport. No tests added here require real credentials or consume live API quota.
