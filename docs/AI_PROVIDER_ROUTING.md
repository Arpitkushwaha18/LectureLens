# AI provider routing

Study materials and large text use FreeGG by default (`AI_PROVIDER=freegg`,
`FREEGG_MODEL=gpt-6.1-sol`). Quick Ask uses Gemini independently, with
`GEMINI_TUTOR_MODEL=gemini-3.5-flash-lite` and `GEMINI_API_KEY`. `GEMINI_MODEL`
is only needed if explicitly selecting Gemini for study generation.

Flash-Lite is Google's low-latency, cost-effective model; actual response time
and account access are not guaranteed. Tutor generation has a 30-second deadline,
1024 output-token budget, minimal Flash-Lite thinking and a small title/paragraphs JSON schema
converted to a validated notebook. One explicit temporary HTTP 503 rejection can be retried once;
quota errors, Retry-After and uncertain network/timeout outcomes are not automatically retried.
Quick answers never silently switch to FreeGG.

### Optional Gemini backup account

Add `GEMINI_BACKUP_API_KEY=<your second key>` in **backend/.env** (or server hosting variables),
then restart the backend. Leave it blank to preserve the single-key behavior. No frontend key is
needed, and neither key is exposed in responses or logs. Both keys use `GEMINI_TUTOR_MODEL`.

With two distinct keys, Quick Ask makes one primary request, then at most one sequential backup
request after explicit temporary/quota/auth/model rejections, known-unsent requests or invalid
completed output. There is no same-key retry before failover. Each call has a 15-second deadline;
successful primary responses never call the backup. Uncertain network resets/timeouts and invalid
request schemas do not trigger another potentially billed request. A primary-key rejection starts
an in-memory key-health cooldown (respecting its Retry-After); questions during that cooldown go
directly to the backup. No prompts, answers, request records or cooldowns are written to disk/DB.

Use authorized independent accounts/projects for separate quota. Keys sharing a project may share
limits, and model-wide outages can affect both accounts. Detailed Ask/study/PDF remain on FreeGG.
Live backup-account access is unverified until its key is supplied; synthetic tests cover routing,
failure bounds, key format validation and secret/prompt redaction.

Ask offers **Auto / Quick / Detailed**. Auto chooses Gemini unless the prompt explicitly asks for
detail (for example, “in detail” or “comprehensive”). Detailed selects FreeGG with an 8192-token,
180-second budget; it never requires Gemini. Retry keeps the original selection. Results and
prompts remain page/request-local without saved user records.

PDFs (up to 20 MB and 200 pages) are validated locally, then sent as complete
base64 `input_file` parts to FreeGG's `/v1/responses`. Embedded text is a bounded
preview, not a substitute for the file. Scanned pages are not locally recognized.
The model is instructed to read the attached file and state unreadable-content
limitations. Live local verification passed for a text PDF and an image-only PDF containing
unique fictional facts (Cedar, 47 sensors, ZETA-913), all preserved in generated notes.
This proves the small fixtures, not every scan, language, diagram or arbitrary-size PDF.
Rejection does not trigger an automatic Gemini call or text-only retry.

Local OCR/Tesseract, its native engine, configuration and installation scripts
have been removed. Spreadsheets preserve cell text only; embedded images are not
read. Existing cached OCR results may remain on disk but the new extraction
namespace does not reuse them. Historical generation evidence/fences are retained.

All provider keys belong only in backend/Render variables, never `VITE_`.
Changes to real credentials and deployments are separate operator actions. Live verification
is opt-in: `node backend/scripts/verify-current-workflows.mjs --live --ask --detailed --pdf`
(may incur provider charges). Add `--youtube=<URL>` for a live lecture check.
Existing documents describing local OCR are historical and are
superseded by this guide.

Model reference: https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite
