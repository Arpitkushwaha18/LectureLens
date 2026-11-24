# FreeGG generation (localhost)

Put your bearer key in `backend/.env`, never in frontend variables or chat:

```dotenv
AI_PROVIDER=freegg
FREEGG_API_KEY=your_api_key_here
FREEGG_MODEL=gpt-6.1-sol
GEMINI_API_KEY=your_gemini_key_here
GEMINI_TUTOR_MODEL=gemini-3.5-flash-lite
```

Restart the backend with `npm run dev` from `backend/` after saving the file.
Do not include `Bearer ` in the key value; the backend adds that header itself.
Keep `TRANSCRIPTFETCH_API_KEY` unchanged: it still supplies YouTube captions.

The study-set outputs and standalone detailed-notes route use
`https://freegg.app/v1/responses`. FreeGG retired Chat Completions on 23 November 2026.
Gemini startup/model requests are skipped
when FreeGG is selected for study generation. Ask doubts uses the separate Gemini
Flash-Lite configuration above; there is no automatic provider fallback. Existing Gemini
settings and stored results are retained, not deleted. Provider-qualified cache
identities separate new results, while old uncertain requests remain fenced.

The transport sends system/user `input`, `text.format: {type: "json_object"}`,
`max_output_tokens`, `store: false` and `stream: false`. The full source is sent without
truncation. English instructions, notebook-schema validation, selected counts,
timeouts and bounded responses remain enforced. There are no automatic generation
retries or startup generation calls. Upstream errors never expose provider bodies.

FreeGG generation is bounded to five minutes, with worker leases covering that wait.
HTTP 410 is a definitive endpoint rejection, not an uncertain completion. Recorded
rejections can be resolved through audited recovery without weakening timeout fences.

The API key must have access to the specified model. Actual context limits and
five-hour lecture capacity remain provider-dependent; a curl example alone does
not establish those capabilities. Live JSON-mode detailed-note generation for
`https://youtu.be/kepBmgvWNDw` passed on 23 November 2026: 42 English blocks were
saved through the real localhost route, and a browser study session generated
and rendered 41 blocks. Both completed in roughly 67–68 seconds, exceeding the
old 60-second wait. Same-session read-only checks and cached UI rendering then
passed without another generation.

The first Responses attempt timed out and was retained as unconfirmed. The user
approved one retry with possible duplicate-charge acknowledgment; that approval
and the recorded HTTP 410 rejection were resolved through audited recovery,
not deletion or bulk fence resets. The separate browser session unexpectedly
caused one additional request, which was disclosed; no further generation was
submitted. Captions and all attempt evidence remain private and preserved. Lectures
and PDFs are sent to FreeGG; doubt questions are sent to Gemini when submitted.
PDFs use standard Responses `input_file` parts, without local OCR. FreeGG file-input
support remains unverified live; see [the current routing guide](AI_PROVIDER_ROUTING.md).
