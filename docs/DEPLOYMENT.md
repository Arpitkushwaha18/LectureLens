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

`render.yaml` describes a Node 24 backend with Chromium installed for export and automatic deployment disabled. Supply gallery/provider credentials through the dashboard. Set `FRONTEND_ORIGIN` to the exact frontend HTTPS origin and check the real proxy chain before setting `TRUST_PROXY_HOPS=1`.

Vercel uses `vercel.json` and only `VITE_API_BASE_URL=https://YOUR-API/api/v1`. SPA routes include `/admin`, `/gallery`, `/assistant` and `/ask`. No browser Supabase key is required.

For unrelated Vercel/Render domains, use production HTTPS with `SESSION_SAME_SITE=none` for the **admin** cookie. Some browsers still block third-party cookies; use frontend/API subdomains under one site or a reviewed same-site proxy if admin login fails. Public gallery/study/Ask require no cookie and are unaffected by that restriction.

FreeGG remains the study/PDF and Detailed Ask provider; Gemini handles Quick Ask independently. Auto selects Quick unless the prompt asks for detail. External outages, unavailable captions, missing keys, size limits and overload can still reject a request. Errors/retries are shown honestly. Quick Ask retries one explicit HTTP 503 rejection without Retry-After, not unknown timeouts/network outcomes. With no durable request records, timeouts/restarts cannot recover results or prevent duplicate provider charges. Do not enable automatic blind paid-call replay. Basic rate/concurrency limits remain to protect availability.

## Acceptance and rollback

- Verify hosted SQL grants/catalog RPC/Storage signing and real admin login/logout/expiry/wrong-password rejection.
- Confirm uploads, course→semester→subject filtering and PDF downloads without visitor login.
- Repeat opt-in live TranscriptFetch, FreeGG PDF **semantic readability**, and Gemini Ask checks against the deployed environment. Local live fixtures passed, but Gemini also intermittently returned HTTP 503; neither fixtures nor mocked tests prove hosted availability.
- Verify keyboard/mobile use and real PDF export. Check that no active `/library`, `/youtube` or `/operator` endpoint remains.
- Rollback by disabling admin uploads and restoring a reviewed prior application binary; preserve gallery files/metadata and historical records. Do not drop tables/buckets or replay old jobs as part of rollback.

No deployment, production migration, data deletion or live paid-provider verification was performed.
