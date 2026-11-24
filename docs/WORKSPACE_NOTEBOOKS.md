# Workspace notebooks — local verification

**Latest recovery/OCR update:** see [GENERATION_RECOVERY_OCR.md](GENERATION_RECOVERY_OCR.md) for the exact blocker, protected recovery procedure, reusable OCR, structured partial extraction and measured timings. The older CLI-OCR and 225-test descriptions below are historical; current verification is **238 backend, 139 frontend and 109 contracts tests passing**. No new paid generation or hosted mutation was performed.

## What is implemented

- `http://localhost:5173/assistant` submits YouTube URLs or actual PDF/XLSX/XLS/CSV files to `POST /api/v1/workspace/process` using multipart uploads.
- The backend streams validated NDJSON stages, extracted source previews, results and safe failures. Progress starts immediately, reflects actual stages, and does not invent percentages. Continue is disabled during a request.
- All six selections are dispatched: detailed notes, short notes, flashcards, MCQ quizzes, mind maps and AI-generated sample question papers (not actual PYQs).
- Validated notebook JSON renders on screen and in exported PDFs with self-hosted Kalam/Caveat fonts, ruled warm paper, a red margin, definitions, examples, formulas, tables, SVG graphs, flashcards and quizzes. Legacy YouTube detailed notes convert deterministically without invented content.
- Export PDF opens the browser print dialog. Select **Save as PDF**, A4, and enable background graphics if required by the browser. The isolated print portal includes all selected materials, closed flashcard answers and quiz solutions, without workspace navigation.
- Manual transcript entry, Progress and My Learning are removed from the UI. The legacy backend notes API remains compatible; this does not reintroduce manual entry into the workspace.
- Notes Gallery has no fabricated starter content. Its endpoint returns only operator-imported validated notebooks. Missing captions use an exact video-ID match or the clean empty state.

## Extraction and safety

Document parsers run in bounded worker threads: **20 MiB per file, 100,000 source characters**, 400,000 UTF-8 bytes, 180 seconds, 256 MiB worker heap, 200 PDF pages, 30 sheets, 5,000 data rows/100 columns per sheet and 2,000 characters per cell. Boundaries and OCR labels count toward the source ceiling; exceeding it fails with split-document guidance, never truncation. XLSX archives are checked against 40 MiB expanded content/2,000 entries. The JSON API accepts up to 2 MiB to accommodate escaped Unicode sources. These are bounded application parsers, not an OS sandbox; native canvas/Sharp/Tesseract memory also needs deployment-level resource limits.

PDFJS preserves page order, boundaries and text lines. Pages with fewer than 24 non-whitespace text characters are rendered locally and passed to free **Tesseract 5**, using English/Hindi packs and bounded orientation attempts (0/90/180/270 degrees). Text-rich pages are not OCRed. This supports scanned and mixed-page documents, not extraction of every image region inside a text-rich page. Unreadable/blank scans fail explicitly; low-quality text, handwriting, tables and formulas are not guaranteed accurate.

XLSX image relationships are read locally from ordinary drawing anchors and associated with worksheet names and approximate one-based row/column locations. OCR text is labeled separately from cell data. PNG/JPEG/WebP/single-frame GIF/TIFF raster decoding is supported; unsupported/corrupt images warn without discarding readable cells. Unassociated/grouped/chart/rich-data images may be unsupported and are disclosed. External relationships are ignored, XML document types are rejected, and no URLs, formulas or macros are executed. **Legacy XLS images are unsupported**: cells still work; export to XLSX for image OCR. CSV extraction remains unchanged. File size/type validation happens before cache lookup.

OCR prerequisites (no paid API):

```sh
# macOS
brew install tesseract
# Debian/Ubuntu alternative: apt install tesseract-ocr fonts-noto-core
npm --prefix backend run ocr:setup
```

The setup script downloads pinned free tessdata_fast 4.1.0 eng/hin/osd packs into private `backend/.cache/tessdata`; it does not install the system binary. Keep that directory persistent or provision system packs. `.env.example` documents `OCR_LANGUAGES`, `OCR_TESSERACT_PATH`, `OCR_TESSDATA_DIR` and `OCR_MAX_IMAGES` (default 30, maximum 50). Each OCR subprocess has a 20-second deadline; parent worker termination also kills tracked OCR children. Documents exceeding the OCR/time budget must be split. Linux OCR test rendering requires a Devanagari font; optionally set `OCR_TEST_HINDI_FONT` to a local Noto Sans Devanagari TTF.

TranscriptFetch remains backend-only, captions-only and database-fenced, with timestamps, canonical URL identity, shared transcript caching and no automatic provider retries. Known missing-caption results are remembered locally per video/language so repeated requests preserve the gallery fallback. Existing transcripts are checked first; uncertain extraction failures are not treated as known missing captions.

## Persistence and operation

YouTube detailed notes retain existing Supabase transcript/notes caches and fenced jobs. Document extraction, other output materials and gallery imports use a private SQLite cache under `backend/.cache/workspace`, configurable with `WORKSPACE_DATA_DIR`. This is **single-host persistence**, not a multi-host Supabase cache. Keep that directory private and persistent; it contains extracted document content. Retention/backup and operator-only gallery import are deployment responsibilities; no public publishing endpoint is provided.

SQLite job identities include source text, output type, model, prompt and schema. Completed output is reused. Known retryable Gemini failures require an explicit request after bounded exponential cooldown (60/120/240 seconds, cap 300), respecting longer provider Retry-After, and stop after three attempts. There are **no automatic paid-call retries**. Unknown failures, timeouts, connection uncertainty and expired running claims remain fenced across model/prompt changes. Historical SQLite jobs lacking operation identity are conservatively fenced globally when uncertain; the earlier attempt-2 running job was not reset. Gracefully quiesce active jobs before restarting or applying migrations; shutdown allows active work to drain.

Backend environment loading resolves `backend/.env` relative to source/dist rather than the launch directory; shell values win, secrets are never browser configuration. Google GenAI SDK 3.6.1 uses the official Developer API, pinned v1beta, one request attempt, and strict local Zod validation. The provider response schema drops deeply multiplied array/string bounds, translates oneOf to anyOf and const to enum. The local full contract still rejects invalid block/reference/output data. Gemini 2.5 Flash has thinking disabled so its 8,192-token output budget is available for notes; incomplete output is rejected, not silently published.

Startup issues only a **non-generating model metadata GET**, validating credentials, model name, generateContent capability and input/output capacity. Failure disables new generation/caption spend while allowing same-config completed-cache lookup and other workflows; fix configuration and restart. HTTP 401/403, 404, 400, 429 and 500/503 now have distinct safe classifications; invalid-key details on HTTP 400 are recognized, Retry-After survives SDK parsing, and raw provider bodies/secrets are not exposed.

## Verified locally

Run from the project root:

```sh
npm --prefix backend test
npm --prefix frontend test
npm --prefix contracts test
npm --prefix backend run lint
npm --prefix frontend run lint
npm --prefix backend run build
npm --prefix frontend run build
npm --prefix frontend run test:browser
```

The browser suite requires the frontend at `http://localhost:5173` (or `FRONTEND_TEST_URL`) and installed Playwright Chromium. It launches its own isolated HTTP backend with embedded PostgreSQL and disposable SQLite, **real document parsers**, fixture captions and a **mocked Gemini transport**. It does not send live provider requests or import test notebooks into the production gallery.

Evidence: 225 backend, 139 frontend and 109 contracts tests pass. New tests cover actual local OCR for scanned/mixed/rotated/Hindi PDFs and English/Hindi multi-sheet XLSX images, unreadable/unsupported scans, combined source limits, archive/XML/SSRF safety, exact upload boundaries, SDK error handling, Retry-After, cooldowns and cross-model fences. The forward-only SQL upgrade is executed against disposable embedded PostgreSQL, never hosted production. Chromium verifies actual uploads of all four document formats plus six OCR fixtures, immediate/streamed progress, all notebook block types, flashcard/quiz interactivity, every selected output, cache reuse, corrupt-file errors, invalid YouTube URLs, timestamp links, missing-caption fallback, empty gallery, removed navigation and mobile overflow. A six-page rendered-notebook PDF is parsed back to verify all extended sections, final section and answers; text coordinates stay inside page bounds. A separate multi-material PDF includes all six outputs and each final section. Artifacts are `frontend/.cache/e2e/notebook.png`, `notebook-export.pdf` and `all-materials.pdf`; these are explicitly labeled test fixtures, not live generated notes. Arbitrary provider layouts and non-Chromium printing are not exhaustively verified.

## Live integration status — not a success claim

- The actual small two-page PDF uploaded/extracted in the website and reached Gemini generation. Its first approved live attempt returned a temporary provider failure.
- The single explicitly approved retry was submitted. Local read-only inspection shows attempt 2 still marked running without a saved material, now an uncertain expired claim. Its success/billing outcome is unconfirmed. No further live generation was submitted and no fencing was reset; operator review is required.
- Both reported Gemini messages came from lossy classification: `GEMINI_TEMPORARY` grouped HTTP 500/502/503/504 with a fixed 60-second message; `GEMINI_CONFIGURATION` incorrectly grouped HTTP 400 request/schema failures with 401/403 authentication and 404 model failures. Read-only historical job inspection confirms those codes but stores no original status/body, so the exact provider subcause cannot be reconstructed. The bounded union response schema is a compatibility risk, not a proven cause of either historical incident. Metadata success cannot rule out generation-specific billing, permission, model or service failures.
- Current configuration is **gemini-2.5-flash**, a cost-effective structured-output Flash model. A live non-generating metadata GET, using the current key from the project-root launch path, verified `models/gemini-2.5-flash`, `generateContent`, 1,048,576 input tokens and 65,536 output tokens. The model existed in the live list too. No credentials were printed or replaced; only the model setting changed. **Live successful generation remains unverified; no new paid requests were authorized or sent.**
- The user reports successful YouTube extraction. A fresh read-only hosted connection check passed; migration-list inspection on 2026-11-22 shows 001–004 applied and new **005 pending**. This supersedes earlier missing-key/pending-003/004 notes. No production migrations were applied by this work. Hosted transcript persistence still enforces 40,000 characters/80,000 bytes until approval/application of `supabase/migrations/20261122000500_source_limits_and_generation_fences.sql`; document OCR/100,000-character processing is local and does not depend on that migration. The migration also provides atomic cross-model paid-claim fencing; until applied, the application guard is not a proven multi-host race barrier.
- No deployment, commit or push was performed. Existing records and the uncertain SQLite running claim were retained.
- Production multi-host operation, hosted PostgREST contention and live generated-notebook/export success remain unverified. Vite still reports its extensionless-config warning and the approximately 516 KB frontend bundle warning; builds succeed.

Start locally with `npm --prefix backend run dev` and `npm --prefix frontend run dev`. Website: **http://localhost:5173/assistant**. API: **http://localhost:4000/api/v1**.
