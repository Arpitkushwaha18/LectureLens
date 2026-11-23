# Final YouTube learning workflow

Latest local control (22 November 2026): `K6BCYpTuwa0` returned 119,178 characters,
3,182 caption segments and 6,521 seconds. The prior 100,000-character ceiling was the
confirmed parsing failure. One real TranscriptFetch response was saved privately and replayed
through the full SQL/generation workflow; real Gemini produced 49 English detailed-note blocks.
Live quiz requests received HTTP 503 on bounded retries, so quiz success is not claimed.
Completed notes, provider response and failed-attempt evidence are retained in the isolated
local control store. No hosted migrations, deployments or historical fence resets were performed.

This supersedes the discontinued shared-library product. `/notes`, detail/publication UI and
library resource APIs have been removed. Historical rows, migration files, audits and uncertain
paid jobs have not been deleted. Migration 011 withdraws the old public table grants and
publication RPC capability without removing data.

## Product behavior

- UrTutor detects/validates watch, youtu.be, Shorts, embed and recorded live URLs immediately.
  URL-only validation starts after 600 ms without further calls for tracking changes.
  Invalid links cannot Continue. Validation never contacts YouTube, TranscriptFetch or storage;
  it checks the URL format, not video existence or transcript availability. Stale responses are
  ignored. Verification receipts bind only the video ID and ten-minute expiry.
  Continue validates the receipt, internally acquires/persists the transcript, then generates
  the selected materials. Transcript failures occur after Continue and can be dismissed.
- TranscriptFetch is captions-only, without
  audio or requested translation. Fresh captions cost **one provider credit** according to the
  provider documentation; dollar cost depends on the account plan. One controlled caption call
  used one credit in this implementation. Known cached human captions are preferred; the upstream SDK
  does not expose track enumeration or human-track selection. Unknown provenance is never
  relabelled human. Returned language is retained.
- Detailed/Short Notes alone use the new protected Supabase persistence. There is no public
  feed, publication operation or creator identity. Identity includes video ID, current stored
  caption hash, actual source language, output, model, prompt (`study-notebook-v3-5-english`), normalized
  preference defaults and schema
  version. Expired transcripts are not valid cache sources. Matching completed notes are reused
  across users; only missing selected notes are generated. Changing identity cannot bypass an
  older uncertain paid operation. Failed/incomplete outputs are not saved as completed notes.
- PDFs and Excel/CSV extraction/results are private, keyed by server-verified device/account
  owner. Other study outputs are private, not reusable YouTube notes. Their counts also enter
  cache identity. No shared-resource persistence is performed for these activities.
- Flashcards and quizzes are available in section 2, Make it your study set, with count selectors;
  separate navigation and homepage sections remain hidden.
  Their saved data, contracts and backend support remain intact. Flashcard count 5–20; quiz
  count 5–30; default ten. Backend/contract validation rejects
  fractional/out-of-range counts. Gemini responses must contain exactly the requested number
  of blocks, and MCQs exactly four options. Mismatches fail definitively without automatic
  regeneration. Cards flip/shuffle/navigate and support known/revision marks. Quizzes navigate
  one question at a time, submit score/percentage/explanations and retry. Answers stay in-tab.
- Processing is shown with a subtle rotating circle, not a percentage or estimated completion
  bar. Reduced-motion preferences disable rotation. Loading stops when the request finishes;
  partial failures keep completed material. Internal completion events remain truthful.
  Explanatory transcript/storage/privacy/progress paragraphs were removed from the workspace.
- There is no automatic preferences popup and no extra step between verification and Continue.
  The URL/PDF/Excel source workflow stays unchanged. An inline “Ask UrTutor” search bar lets a
  student type a doubt or request notes directly. Submission navigates to `/ask`, a dedicated
  GPT-style answer page with a conversation thread and bottom composer, not a popup. Questions
  are passed in navigation state, never URL parameters. Answers are generated privately,
  cached by prompt/model/English-policy identity, and failures can be dismissed independently.
  Enter sends and Shift+Enter inserts a line break on the chat page. Failed workspace attempts
  have a visible dismiss action that clears the failure state so it cannot block a new request.
  All generated notes, quizzes, cards, maps, papers and tutor answers are in English, regardless
  of source language or a non-English request. Transcript language metadata stays accurate.
  Historical non-English caches are not reused under the new prompt identity; historical unknown
  paid operations remain fenced, including tutor jobs across the English-policy identity change.
- Caption text, segments, timestamps and provider payloads are server-only. Public workspace
  source events/results use a strict metadata-only YouTube schema. The legacy notes endpoint
  also no longer returns transcript text or segments. There is no transcript preview/tab.

## Storage correction and safety

`20261122001100_final_youtube_workflow.sql` is forward-only. The extraction dependencies are
001–007 and 009; 008/010 preserve historical library migration ordering but are not caption
storage prerequisites. The automatic-caption path now records runs with
`record_automatic_caption_run(source_id, token, run_id)`, not the old explicit-language RPC.
Stored captions must be confirmed before generation begins, not during URL validation.
Local migration 013 raises provider transcript storage to 500,000 characters / 2 MB UTF-8 and
30,000 segments. Parsing and generation use the same bounds; manually pasted/document source
limits stay unchanged. Videos are capped at five hours (18,000 seconds), including cached
transcripts. Caption acquisition has a bounded 120-second wait. Local migration 014 gives new
caption requests 180-second leases and notebook requests 360-second leases without resetting
historical jobs. Very long sources get up to 300 seconds for generation.
Generation keeps all ordered source segments in one request, without truncation or paid
map/reduce fallback. Unicode inputs that exceed the conservative byte estimate use Gemini's
token-count endpoint to check actual context capacity before paid generation. Provider quota
and service errors are not disguised as transcript errors; Google RetryInfo cooldowns are
honored and raw provider messages stay out of the UI.
The failure UI does not display numeric cooldowns. It shows “Please try again later.” and
keeps Retry hidden until the real cooldown expires; no five-second bypass or automatic replay
is used. A 54,553-second local wait was traced to a definitive Gemini HTTP 429, not URL parsing.
Migration `20261122001200_caption_retry_safety.sql` adds bounded cooldown retries only for
definitive upstream/rate-limit failures. Within one request, at most one retry is permitted,
using the same persisted idempotency key. Only documented transient error codes retry; no
audio job is polled. Client timeouts, malformed responses and unknown commits remain fenced.
The SDK is 2.4.1, uses Bearer authentication and `POST /api/v2/transcripts/video` with
`mode: captions`, `timestamps: true`. The official envelope and snake/camel-case metadata
are validated before SDK normalization. HTTP error classification survives non-JSON failures.
The parser accepts the SDK's real transcript shape, including diarization `speaker` fields,
audio-sourced results and arbitrary platform/language tags (unsupported tags are dropped rather
than failing the whole transcript). Only genuinely malformed cues, wrong video identity or
configured size limits produce the “couldn't read the transcript” message; all student-facing
copy talks about transcripts, not captions, and never suggests that the student find a
“captioned lecture”.

New note jobs and successful notes reside in `ll_private.youtube_note_jobs` and
`ll_private.youtube_saved_notes`. Only `service_role` can use the RPCs/tables. Transactional
operation-level advisory locks prevent concurrent claims even across model/prompt changes.
Validated response checkpoints recover interrupted saving without another generation call.
Unknown sent requests stay blocked; only definitive failure codes allow retry after cooldown.
Existing SQLite and hosted job fences are still consulted before new dispatch.

Storage errors distinguish missing schema/RPC (`LEARNING_SCHEMA_MISSING`), missing grants
(`LEARNING_STORAGE_FORBIDDEN`) and connection failure (`LEARNING_STORAGE_UNAVAILABLE`).
Backend logs give the operation, safe database error code and remedy, never credentials,
raw source text or raw provider responses. Students get a friendly save/check message.

Run the non-mutating diagnostic with:

```sh
npm --prefix backend run youtube:storage:check
```

The configured hosted database returned **PGRST202** for the final storage health RPC. It
still requires prepared migrations **005–012** on an **approved development Supabase database**.
No production migration, reset, deployment, commit or push was performed. Docker and the
Supabase CLI are unavailable on this machine, so a local Supabase stack cannot currently be
started. The full SQL migration chain was executed against PGlite PostgreSQL in integration
tests, including roles/grants/RLS, but this is not a hosted PostgREST integration claim.

## Verification

Backend/contract/frontend tests, lint, typechecks and production builds are run locally.
The browser regression uses actual HTTP endpoints, full SQL note persistence, independent
browser sessions, real PDF/XLSX/XLS/CSV parsing and English/Hindi OCR; external generation is
injected/mocked to avoid charges. It verifies reuse of existing Detailed/Short Notes, generating
only missing notes, selector limits/exact counts, quiz/card activities, partial recovery,
ordered percentage events, stale verification, mobile layout and absence of publishing/feed UI.

The running application also automatically verified the existing real lecture
`iJC87bWWuPM` using free metadata and previously saved Hindi captions. No caption or Gemini
dispatch was made. Live notes generation remains intentionally blocked until the configured
Supabase storage migrations are approved/applied to a development database.

The real controlled English lecture `WUvTyaaNkzM` returned 15,797 characters and 243 segments
from TranscriptFetch, cost one credit, and was successfully persisted in a separate durable
local PostgreSQL store at `backend/.cache/caption-control/postgres`. Concurrent equivalent URLs
and repeated submission made only one provider call. A protected one-run lock prevents this
test being accidentally resent. No Gemini request was made. The free credential check passed;
existing real Hindi captions (`hi`, 791 segments) were retrieved read-only from Supabase.
Hindi/English/arbitrary languages, auto captions, absent captions, unavailable/private videos,
malformed results, timeouts and rate limits have local fixture coverage. Only the single English
caption request was freshly tested against the live provider; other cases were not claimed as
fresh live acquisitions.

Free provider diagnostic: `npm --prefix backend run transcript:check`.
An invalid `LIBRARY_STORE` value containing a pasted CLI command was corrected in `backend/.env`.
