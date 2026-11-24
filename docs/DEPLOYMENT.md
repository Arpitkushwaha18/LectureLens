# Deployment checklist (not executed)

## Current storage policy

Only PDFs deliberately uploaded through `/admin` and their course/semester/subject/title/description metadata are stored in Supabase. Student sources, URLs, captions, generated outputs, prompts, quiz answers and request ledgers are not persisted by the active API. No user account is needed. Refreshing/leaving a study page loses its work: download results first. Repeating the same URL or document runs again.

Existing historical tables and SQLite files are **not deleted**. Historical library/YouTube/operator routers are no longer mounted. Earlier migrations 015–016 and their recovery architecture are not prerequisites for the new gallery; do not apply them just for this version.

## Gallery setup — required before uploads work

1. Back up existing data. Review and manually apply `supabase/migrations/20261123001700_admin_pdf_gallery.sql` to the approved Supabase project. It creates only `public.admin_gallery_notes`, its catalog RPC and the private `admin-gallery-pdfs` Storage bucket. No data reset or migration has been performed automatically.
2. Set server-only `SUPABASE_URL`, `SUPABASE_SECRET_KEY` and a unique random **16+ character** `GALLERY_ADMIN_PASSWORD` (maximum 256). Keep passwords/keys out of frontend variables and source control. Changing the admin password invalidates existing admin cookies.
3. Open `/admin`, sign in with that password, upload an unencrypted PDF up to 20 MB, choose/type course, select semester (1–12), choose/type subject and confirm sharing rights. New courses/subjects are added by the metadata on uploaded notes. PDFs themselves need no password.
4. Verify `/gallery` filters and anonymous PDF opening/download. The server signs five-minute Storage URLs only for files with gallery records. There are no direct anon/authenticated table writes or bucket policies.

Admin sessions are signed, one-hour HTTP-only cookies, not database sessions. Login is rate-limited; mutations require a custom request header and exact allowed origin. No default password is shipped. PDF parsing validates readability, not malicious links/content—review your files before publishing.

## Hosting

`render.yaml` describes a Node 24 backend with automatic deployment disabled. PDF export on Linux uses the pinned `@sparticuz/chromium` runtime dependency (including its native libraries), not a Playwright browser downloaded into Render's build-only cache. `npm --prefix backend run build` copies notebook CSS into `backend/dist/assets`; runtime no longer reads frontend source. For a Render service with the repository root as its Root Directory, the build command is `npm --prefix contracts ci && npm --prefix backend ci && npm --prefix backend run build`; start remains `npm --prefix backend start`. If the service was created manually, update its dashboard build command too—editing `render.yaml` alone does not update that service. Redeploy the backend after installing these dependencies; macOS development still uses `npx playwright install chromium`.

Supply gallery/provider credentials through the dashboard. Set `FRONTEND_ORIGIN` to the exact frontend HTTPS origin and check the real proxy chain before setting `TRUST_PROXY_HOPS=1`.

Vercel uses `vercel.json` and only `VITE_API_BASE_URL=https://YOUR-API/api/v1`. SPA routes include `/admin`, `/gallery`, `/assistant` and `/ask`. No browser Supabase key is required.

If `/workspace/export` still responds with “Install the local Chromium browser with npx playwright install chromium”, Render is serving the older backend. Deploy the latest backend commit on Render (and check its build/start commands above); a Vercel-only deployment cannot update that endpoint. PDF exports and browser printing use embedded Kalam handwriting for body text and Caveat for headings, with STIX for readable math. On-screen study notes now use the same Kalam/Caveat handwriting (tables, formulas, diagrams included), while interface chrome remains Inter/Fraunces.

For unrelated Vercel/Render domains, admin cookies are now sent with `SameSite=None; Secure` automatically in production, so `SESSION_SAME_SITE` no longer needs to be changed for admin access. Public gallery/study/Ask require no cookie and are unaffected.

OpenRouter is now primary for text study generation and Detailed Ask, with automatic FreeGG fallback for transient failures. Original PDFs route directly to FreeGG because the configured OpenRouter model is text-only. Gemini handles Quick Ask independently and is unchanged. Auto selects Quick unless the prompt asks for detail. Set the backend variables in [AI_PROVIDERS.md](AI_PROVIDERS.md), including `AI_PRIMARY_PROVIDER=openrouter` and `AI_FALLBACK_PROVIDER=freegg`; no frontend AI keys are needed. That guide covers exact defaults, the selected free model, verified FreeGG API documentation, rate-limit behavior and request-local chunk recovery. External outages, missing credentials, quota exhaustion and format/size limits can still reject requests. With no durable student records, timeouts/restarts cannot recover results or guarantee exactly-once provider charging; cross-provider timeout fallback intentionally accepts that risk. Existing authentication and route-level rate/concurrency controls remain.

## Acceptance and rollback

- Verify hosted SQL grants/catalog RPC/Storage signing and real admin login/logout/expiry/wrong-password rejection.
- Confirm uploads, course→semester→subject filtering and PDF downloads without visitor login.
- Repeat opt-in live TranscriptFetch, FreeGG PDF **semantic readability**, and Gemini Ask checks against the deployed environment. Local live fixtures passed, but Gemini also intermittently returned HTTP 503; neither fixtures nor mocked tests prove hosted availability.
- Verify keyboard/mobile use and real PDF export. Check that no active `/library`, `/youtube` or `/operator` endpoint remains.
- Rollback by disabling admin uploads and restoring a reviewed prior application binary; preserve gallery files/metadata and historical records. Do not drop tables/buckets or replay old jobs as part of rollback.

No deployment, production migration, data deletion or live paid-provider verification was performed.
