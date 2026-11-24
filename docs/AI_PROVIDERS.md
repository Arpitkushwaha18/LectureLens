# OpenRouter primary / FreeGG fallback

## Architecture and scope

Study generation and Detailed Ask use the existing schema/prompt generator behind one
provider manager:

```text
Study generation / Detailed Ask
  existing schema/prompt generator
    request-local long-source processor
      provider manager (bounded concurrency, cooldown, aggregate usage)
        OpenRouter Chat Completions -> FreeGG Responses adapter

Quick/Auto Ask -> existing Gemini integration, unchanged (including backup key)
Original PDFs -> FreeGG directly (capability routing; no OpenRouter PDF support / no local OCR)
```

No new API routes, database tables, migrations, persistent queues, student caches or
activity records are added. Notebook schemas, PDF handwriting, authentication, gallery,
extraction, caption acquisition and route-level limits are preserved. Application
services still call their existing configured-generator functions; provider transports
stay isolated. `AI_PROVIDER=gemini` retains the legacy Gemini study implementation when
`AI_PRIMARY_PROVIDER` is absent. Gemini Quick Ask remains independent.

## Chosen free model

The default is **`nvidia/nemotron-3.5-super-vl:free`**:

- OpenRouter lists it with a **1,000,000-token context**, **131,072-token maximum
  completion**, and **structurally enforced output** support.
- In independent October–November 2026 testing of every free OpenRouter model, it
  answered and passed 20/20 general requests, 7/7 JSON requests, 7/7 tool requests and
  6/6 code requests, at a median 106 tokens/second.
- It is text-capable for this workload. Its vision support is unused.

Free catalog entries change frequently. Alternatives with verified structured-output
support and 1M context include `baidu/ernie-5.5-flash-preview:free` (mandatory high
reasoning; slower) and `particle-ai/particle-1:free` (coding-oriented). Do **not** use
`openrouter/free` here: its automatic model selection is not deterministic enough for a
strict educational schema and long multi-part generation. Verify the live catalog at
`https://openrouter.ai/api/v1/models` before changing the model.

## Render environment

Set these **backend-only** values in Render's Environment dashboard:

```dotenv
OPENROUTER_API_KEY=<your OpenRouter key>
OPENROUTER_MODEL=nvidia/nemotron-3.5-super-vl:free
OPENROUTER_ENABLED=true
FREEGG_API_KEY=<your FreeGG bearer key, without the Bearer prefix>
FREEGG_BASE_URL=https://freegg.app/v1
FREEGG_MODEL=gpt-6.1-sol
FREEGG_ENABLED=true
AI_PRIMARY_PROVIDER=openrouter
AI_FALLBACK_PROVIDER=freegg
OPENROUTER_MAX_OUTPUT_TOKENS=16384
FREEGG_MAX_OUTPUT_TOKENS=16384
AI_LONG_SOURCE_CHUNK_TOKENS=12000
AI_MAX_RETRY_WAIT_MS=60000
AI_MIN_REQUEST_INTERVAL_MS=3000
```

Leave all existing Gemini variables untouched. Never create
`VITE_OPENROUTER_API_KEY` or `VITE_FREEGG_API_KEY`; frontend production builds reject
these accidental secrets without printing their values. Do not commit your actual
`.env`. Remove obsolete `GROQ_*` values after rollout; they are no longer read.

Missing FreeGG credentials do **not** block text generation on OpenRouter. Original
PDF generation needs FreeGG. Missing/disabled primary credentials produce a safe
`AI_CONFIGURATION` request-time error: there is no silent authentication bypass.
Explicitly set `AI_PRIMARY_PROVIDER=freegg` to operate on FreeGG alone, optionally
`AI_FALLBACK_PROVIDER=none`. Fallback may also be `openrouter`; equal primary/fallback
values are coalesced. Valid provider selections are openrouter/freegg; `none` is valid
only for the fallback. New primary settings override legacy `AI_PROVIDER`. For safe
rollout, the deprecated value `groq` is accepted as an alias for `openrouter`; it does
not restore the removed Groq route.

The health endpoint stays available without AI credentials; no startup AI generation
or quota-consuming model probe is performed. Malformed configuration fails validation
with field names and safe messages, never secret values.

### Optional limits

| Variable                       | Default | Purpose                                                                     |
| ------------------------------ | ------- | --------------------------------------------------------------------------- |
| `AI_TIMEOUT_MS`                | 120000  | Per-provider attempt deadline (1–180 seconds)                               |
| `AI_JOB_TIMEOUT_MS`            | 540000  | Active output-generation deadline, including chunking/queue time            |
| `AI_MAX_OUTPUT_TOKENS`         | 4096    | Application fallback output ceiling when a provider has no explicit ceiling |
| `OPENROUTER_CONTEXT_TOKENS`    | 1000000 | Configured model context bound; verify when changing models                 |
| `OPENROUTER_MAX_OUTPUT_TOKENS` | 16384   | Requested OpenRouter output ceiling per call                                |
| `FREEGG_MAX_OUTPUT_TOKENS`     | 16384   | Separate FreeGG output ceiling                                              |
| `AI_TEMPERATURE`               | 0.2     | OpenRouter sampling temperature (0–2); omitted for FreeGG reasoning models  |
| `AI_MAX_CONCURRENCY`           | 1       | Maximum concurrent study-provider calls per backend process (1–4)           |
| `AI_MAX_QUEUE`                 | 8       | Maximum in-memory waiting calls (0–32)                                      |
| `AI_MIN_REQUEST_INTERVAL_MS`   | 3000    | Minimum per-process dispatch spacing; below OpenRouter's 20 requests/minute |
| `AI_MAX_RETRIES`               | 1       | Maximum same-provider retries for definite retryable HTTP failures (0–2)    |
| `AI_MAX_RETRY_WAIT_MS`         | 60000   | Maximum acceptable same-provider backoff (0–120 seconds); longer waits fail |
| `AI_CHUNK_TOKENS`              | 2000    | Conservative estimated input tokens per source chunk (1000–24000)           |
| `AI_LONG_SOURCE_CHUNK_TOKENS`  | 12000   | Larger complete batches for sources above eight ordinary chunks             |
| `AI_CHUNK_OVERLAP_TOKENS`      | 150     | Small contextual overlap between source chunks (0–1000)                     |
| `AI_MAX_CHUNKS`                | 128     | Maximum source chunks (1–256); excess fails explicitly, never truncates     |

Keep the existing `TRANSCRIPT_MAX_CHARACTERS=500000` for long lectures. Token counts
use the maintained o200k tokenizer with a 20% safety reserve and prompt/output
headroom; o200k is an estimator, not an exact tokenizer for every OpenRouter model.
Model-specific tokenizers/rate limits can differ. Unknown model IDs require
operator-confirmed context/output limits. No unsupported tools, web search or paid
infrastructure are enabled.

## Verified API contract

- OpenRouter implements an OpenAI-compatible API at
  `https://openrouter.ai/api/v1`. The adapter calls **POST
  `/chat/completions`** server-side with **Bearer authentication**, system/user
  messages, `max_tokens`, optional `temperature`, and `stream:false`.
- Structured output uses `response_format: { type: "json_schema", json_schema: {
name, strict: true, schema } }`, as documented by OpenRouter. Support is per
  endpoint, not merely per model. The adapter sends
  `provider.require_parameters: true`, so an endpoint that does not advertise every
  requested parameter is not silently selected.
- The notebook schema is sent with canonical string/array/numeric bounds, closed
  objects and every property required. Only originally optional fields become
  nullable; they are restored to the unchanged public notebook contract before local
  validation. Required, unknown or invalid educational content is never dropped or
  fabricated. Cross-field graph/table correctness is still validated locally.
- The strict-schema adapter does not reuse Gemini's deliberately simplified schema,
  and the request never falls back to a second provider merely because JSON-schema
  output is invalid.

### Free-tier limits

OpenRouter's official limits for model IDs ending in `:free` are **20 requests per
minute**, and either **50 requests per day** (less than $10 of credits purchased
lifetime) or **1,000 per day** (at least $10 purchased). The $10 threshold is a
purchase history, not a subscription. The daily counter is reported by
`GET /api/v1/key` as `free_model_daily_requests`.

A five-part long lecture therefore consumes roughly 5–7 requests, including one
retry. On the 50/day tier that is only about 7–10 complete generations per UTC day.
A 429 may be a per-minute limit, a daily limit, or upstream provider capacity. The
adapter honors `Retry-After`; when only `X-RateLimit-Reset` is present, it converts
that reset time into a bounded retry hint. A daily reset is too far away to wait for,
so the manager fails safely with `AI_UNAVAILABLE` instead of sleeping for hours.

Free endpoints have provider-specific prompt logging/training policies that can be
stricter or looser than paid endpoints. LectureLens still stores no student URL,
caption, prompt, note, answer, generation record or usage identity. Review the model
page and your OpenRouter privacy setting before sending student material, and keep
the existing consent/terms review for third-party AI processing.

## Fallback, rate limits and duplicate-call risk

1. Text calls use OpenRouter first. A complete response is parsed/validated against
   existing notebook/output schemas before anything is published.
2. 429, 5xx, network and attempt-timeout failures allow one sequential FreeGG fallback.
   Authentication, permission, model/endpoint configuration, insufficient credits,
   invalid requests, and malformed/incomplete outputs do **not** trigger automatic
   fallback.
3. Retry-After (seconds or HTTP date) controls that provider's in-memory cooldown.
   A different provider may run immediately. Subsequent chunks skip a cooling-down
   provider.
4. If no other provider can be attempted, a definitive retryable HTTP failure may get
   one bounded exponential+jitter retry, only when the wait fits the configured
   maximum. Timeouts and uncertain network failures are never replayed on the same key.
5. Both unavailable yields `AI_UNAVAILABLE`; a saturated queue yields `AI_BUSY`. No
   upstream error body, prompt, transcript, key or student identifier appears in
   manager logs. Retryable errors carry a retry delay.

Timeout/network fallback can consume quota twice if the first response was lost;
cross-provider fallback cannot guarantee exactly-once generation. No SDK or infinite
retries hide extra calls. A client disconnect cancels active study/Detailed Ask work
and queued requests without starting further chunks/fallback.

## Large transcripts and educational quality

Sources approaching 500000 characters are split **before provider requests** using
estimated tokens and paragraph boundaries, with a small overlap and no missing core
characters or split surrogate pairs. Chunks run sequentially. Existing NDJSON progress
events report completed/total chunks. Each chunk receives the original educational
instructions, requested output/language/preferences and source position. Notes prompts
request detailed explanations, definitions, examples, formulas, useful tables/diagrams,
applications and conclusions only when supported by the source; no fabricated syllabus
or exam provenance. The existing English-output policy remains.

Sources above eight ordinary chunk budgets use larger complete batches
(`AI_LONG_SOURCE_CHUNK_TOKENS`), bounded by context headroom. This avoids dozens of
tiny calls exhausting the overall deadline or daily request cap. No source text is
dropped. Notes prompts budget total blocks including headings and reserve room for
merged source-part titles.

Validated completed chunks remain in the active request's memory when a later chunk
fails over or retries. Identical chunks share results **only within that output run**.
Merging removes exact duplicate overlap, coalesces compatible paragraphs without
discarding text, and preserves unique definitions/formulas/graphs. Bounded quizzes and
flashcards are distributed across source parts; if there are more parts than requested
items, the final practice set samples evenly across the source. Too few distinct
questions fails explicitly rather than padding with duplicates.

Small unique chunk limitations are packed into ordered strings up to 1000 characters,
without dropping warning text. This preserves the existing 12-item contract for long
lectures whose chunks each produce a few short limitations. More than 12000 characters
of irreducible warnings still fails explicitly rather than truncating them.

The contract caps notebooks at **160 blocks**, **5000 characters per prose block** and
**12 limitations**. Chunk prompts budget substantial blocks across the full source. If
the complete merged result cannot fit, `AI_OUTPUT_LIMIT` asks for a smaller source;
blocks/warnings are never silently sliced away. This is a bounded large-source pipeline,
not a guarantee of unlimited exhaustive notes within a fixed schema, deadline or free
quota. Incompatible final outputs are never labeled success.

There is **no persistent checkpoint or cross-request cache**: that would violate the
existing no-student-persistence requirement. Reload, disconnect, terminal failure or
restart discards request-local work; user Retry starts again. Already returned
successful output types remain page-local while failed output types can be retried.

## Usage and free-tier protection

The manager retains **anonymous aggregate counters only**: dispatched requests,
successful provider completions, failures and reported input/output tokens, by provider.
`snapshot()` is internal/tests only; no public usage endpoint or student usage records
are added. Safe structured logs record provider/model/attempt/outcome and available
numeric usage. Usage is not guessed when absent, and reported completion counts do not
imply notebook validation succeeded. Failed/time-out calls can consume quota without
usage metadata. Counters/cooldowns reset on restart and are per-process, not a
distributed quota ledger.

OpenRouter's free limits are account-wide, not raised by creating more keys. Tune
chunk/output budgets, spacing/concurrency against your dashboard; defaults do not
promise free-tier compatibility for every large request. There is no paid fallback or
subscription setup. Higher-throughput accounts may raise the configured limits after
checking the exact model and account policy.

## Build, deployment and troubleshooting

Repository-root Render commands remain:

```sh
npm --prefix contracts ci && npm --prefix backend ci && npm --prefix backend run build
npm --prefix backend start
```

Health check remains `/api/v1/health`; `render.yaml` keeps auto-deployment off. After
reviewing and committing/pushing **yourself**, set the environment above and manually
deploy the latest backend commit in Render. Deploy the frontend to Vercel for the
updated Detailed provider label and secret guard; keep the existing
`VITE_API_BASE_URL`. This implementation does not deploy, migrate, commit or push
anything.

- `AI_CONFIGURATION`: check the selected provider's enabled flag, key, exact model ID,
  context/output limits and URL.
- `AI_QUOTA`/`AI_UNAVAILABLE`: inspect `GET /api/v1/key` (`free_model_daily_requests`),
  safe outcome logs, and retry delay; wait for reset, lower concurrency/output/chunk
  budgets, or purchase the documented credits threshold to raise the daily cap.
- `AI_SOURCE_LIMIT`/`AI_OUTPUT_LIMIT`: reduce source scope or review bounded chunk
  settings; do not remove content automatically or raise schema limits without a
  contract review.
- `AI_REQUEST_INVALID`: verify model availability, endpoint parameter support and
  schema compatibility, not just the key. Free models can be retired or changed.
- `AI_INVALID_OUTPUT`: no partial notes were accepted; manual Retry can generate anew.
- Original PDFs fail while text works: check FreeGG key/model/PDF access. OpenRouter
  cannot replace the PDF capability of the configured FreeGG model.
- Render still emits the old Chromium-install PDF error: deploy the current backend;
  changing AI variables or Vercel alone cannot update the exporter.

The normal regression suite uses mocked HTTP providers, including the complete notes
workflow and original PDF transport, without real credentials or live API quota.

An explicitly opt-in, no-student-storage browser probe is available separately:

```sh
# With the frontend running locally; backend credentials remain in backend/.env.
LIVE_YOUTUBE_URL='<the URL to verify>' node frontend/tests/provider-live-workflow.mjs --live
node frontend/tests/provider-live-workflow.mjs --live --pdf --scan
# Add --hosted to target the existing Vercel/Render application instead of local code.
```

Each selected source runs once, without silent user Retry. This probe consumes real
caption/AI quota, prints only numeric outcomes/error codes, and keeps URLs, captions,
notes and exported bytes in temporary process/browser memory. It does not replay
historical persisted caches or save generated study content to disk.
