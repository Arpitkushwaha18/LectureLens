# LectureLens

A shared study space with **UrTutor**, your learning companion. Bring a PDF, a YouTube lecture
or a spreadsheet and prepare handwritten notes, revision sheets, flashcards, quizzes, mind maps
and practice papers.

The interface is built around a **digital notebook** idea: warm paper surfaces, ruled lines where
they help, editorial serif headings and restrained ink accents. Not a generic dashboard.

---

## Current status

**Local source → real Gemini → saved notebook → PDF workflow verified (22 November 2026).**

| Area                                              | State                                                                      |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| Repository, tooling, lint/format                  | Done                                                                       |
| Frontend app shell and navigation                 | Done                                                                       |
| Notebook design system (tokens + UI primitives)   | Done                                                                       |
| Backend scaffold, health endpoint, error contract | Done                                                                       |
| Persistence                                       | Supabase YouTube detailed/short notes; owner-scoped private SQLite outputs |
| Automatic YouTube URL validation                   | URL format only; transcript fetching begins after Continue                |
| Gemini generation                                 | All six outputs verified with real 3.5 Flash                               |
| Notebook PDF download                             | Real 15-page A4 export verified                                            |

Nothing in this repository pretends to work: sections that are not built yet say so on the page.

**YouTube B1 — contracts and URL handling:** shared, versioned Zod contracts and a pure HTTPS
YouTube URL parser live in `contracts/`. Both apps run automated contract tests. B1's original
contracts and URL policy are preserved by the additive B3 workflow.
See [`contracts/README.md`](contracts/README.md) for URL policy, versioning and setup.

**FreeGG setup:** Add your key to `FREEGG_API_KEY` in `backend/.env`, with
`AI_PROVIDER=freegg` and `FREEGG_MODEL=gpt-6.1-sol`, then restart the backend.
See [`docs/FREEGG_SETUP.md`](docs/FREEGG_SETUP.md). No key belongs in the frontend.

**Current workspace:** `/assistant` uploads PDF/XLSX/XLS/CSV to the local backend (20 MiB/file,
100,000 extracted characters), extracts embedded text/cells and scanned-PDF/XLSX-image OCR,
then generates detailed notes, short notes, flashcards, quizzes, mind maps and sample
question papers. All generated material and doubt answers are in English. Transcript language metadata
is preserved, while provider lectures support up to 500,000 characters without truncation;
PDF/XLSX OCR retains English/Hindi support. Per-output progress, partial-extraction consent,
durable output reuse, safe Retry and uncertainty fences are retained. Completed outputs open
individually while the rest continue. Backend completion events track real stages internally;
the UI uses a subtle loading circle without percentages. Videos are capped at
five hours. Flashcards and quizzes are selectable in section 2; separate navigation sections stay
hidden. Gallery, publishing and public
resource routes are removed.
The inline doubt search bar opens a dedicated `/ask` page with a GPT-style answer thread and composer.

**Final YouTube workflow:** Detailed Notes and Short Notes alone are reused across learners
through protected Supabase RPCs, with no creator identity or public feed. Identity includes
canonical video ID, caption hash, actual language, output, model, prompt and schema versions.
Claims are transactional and preserve unknown paid-job fences. PDFs/spreadsheets and other
activities use owner-scoped private storage; activity answers stay in the current tab.
Local device sessions use `LIBRARY_STORE=local_postgres`; hosted authenticated sessions use
`LIBRARY_STORE=supabase`. The historical library tables remain intact but are no longer exposed.
See [`docs/FINAL_YOUTUBE_WORKFLOW.md`](docs/FINAL_YOUTUBE_WORKFLOW.md). No hosted migrations applied.

**B2 — Supabase foundation:** version-controlled SQL provides shared YouTube sources/transcripts,
configuration-aware reusable outputs, atomic job reservation and private-by-default document
visibility. This historical foundation has no student accounts; the new library adds separate
authenticated ownership and read-only RLS without altering its historical records.
See [`docs/PHASE_B2.md`](docs/PHASE_B2.md) for the correction.

**YouTube:** saved captions are reused; TranscriptFetch acquires captions on misses when configured
with the hosted extraction setup. The main workflow uses Supabase notes storage plus
checks against older hosted/SQLite paid-job fences. The real cached-Hindi-caption path
was verified through rendered notes and a four-page PDF; fresh live caption acquisition was not.
Hosted workflow migrations 005–012 remain local/unapplied; the legacy hosted detailed-notes
endpoint still fails closed until approved setup. Unknown paid outcomes are not resent.

**Setup and evidence:** see [`docs/GENERATION_RECOVERY_OCR.md`](docs/GENERATION_RECOVERY_OCR.md)
for current configuration, OCR/Chromium prerequisites, actual live evidence, tests and limitations.
Local `GEMINI_MODEL=gemini-3.5-flash` was verified. A successful model-list/metadata GET does not
prove generation access: this account rejected 2.5 Flash with HTTP 404. No automatic paid model
fallback is used. Earlier [`docs/PHASE_B3.md`](docs/PHASE_B3.md) describes the historical MVP.

---

## Stack

| Layer                  | Choice                                                             |
| ---------------------- | ------------------------------------------------------------------ |
| Frontend               | React 19, Vite 8, TypeScript, Tailwind CSS v4                      |
| Routing / server state | React Router 7, TanStack Query 5                                   |
| Backend                | Node.js, Express 5, TypeScript                                     |
| Validation             | Zod                                                                |
| Logging                | Pino (+ pino-pretty in development)                                |
| Database               | Supabase YouTube notes/captions + private SQLite + device sessions |
| File storage (planned) | ImageKit                                                           |
| AI                     | Official `@google/genai`, backend only                             |

---

## Requirements

- Node.js **22.12+** (developed on Node 24)
- npm 10+
- Git

---

## Getting started

The frontend and backend are two independent applications. Run each in its own terminal.

First install the local shared contracts package (`npm install` inside `contracts/`). Both apps
depend on it via `file:../contracts`; this does not introduce a root workspace package. App
development, build, typecheck and test commands rebuild contracts automatically.

### 1. Backend

```bash
cd backend
npm install
# Only if .env does not exist; retain your existing configuration.
cp -n .env.example .env
npm run dev
```

The API starts on <http://localhost:4000>. Check it:

```bash
curl http://localhost:4000/api/v1/health
```

```json
{
  "data": {
    "status": "ok",
    "service": "lecturelens-api",
    "version": "0.1.0",
    "environment": "development",
    "uptimeSeconds": 12,
    "timestamp": "2026-01-01T00:00:00.000Z"
  }
}
```

### 2. Frontend

```bash
cd frontend
npm install
# Only if .env.local does not exist; retain your existing configuration.
cp -n .env.example .env.local
npm run dev
```

Open <http://localhost:5173>. The status chip in the top bar shows whether the API is reachable.

### Useful scripts

| Command             | Where   | What it does                                                           |
| ------------------- | ------- | ---------------------------------------------------------------------- |
| `npm run dev`       | both    | Development server with reload                                         |
| `npm run build`     | both    | Type-check, then build (frontend also bundles)                         |
| `npm run typecheck` | both    | TypeScript only                                                        |
| `npm run lint`      | both    | ESLint                                                                 |
| `npm test`          | both    | Shared contracts and app foundation tests using Node's built-in runner |
| `npm run format`    | both    | Prettier                                                               |
| `npm start`         | backend | Run the compiled build from `dist/`                                    |

---

## Environment variables

### `frontend/.env.local`

| Variable                        | Purpose                                                       |
| ------------------------------- | ------------------------------------------------------------- |
| `VITE_API_BASE_URL`             | Backend base URL including `/api/v1`                          |
| `VITE_SUPABASE_URL`             | Public project URL (MVP does not query Supabase from browser) |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Public `sb_publishable_...` key                               |

Every `VITE_*` variable is compiled into the browser bundle and is **public**. Never put a secret
there.

### `backend/.env`

| Variable                  | Purpose                                                   |
| ------------------------- | --------------------------------------------------------- |
| `NODE_ENV`                | `development` / `test` / `production`                     |
| `PORT`                    | HTTP port (default `4000`)                                |
| `LOG_LEVEL`               | Pino log level                                            |
| `SERVICE_VERSION`         | Reported by the health endpoint                           |
| `FRONTEND_ORIGIN`         | Comma-separated CORS allowlist                            |
| `SUPABASE_URL`            | Supabase project URL (same project as frontend)           |
| `SUPABASE_SECRET_KEY`     | Server-only `sb_secret_...` key; never expose to frontend |
| `GEMINI_API_KEY`          | Backend-only Gemini API key                               |
| `GEMINI_MODEL`            | Explicit available model ID; run `npm run gemini:models`  |
| `WORKSPACE_YOUTUBE_STORE` | `local` (default SQLite) or approved `supabase` lifecycle |

`backend/src/config/env.ts` validates these at boot and exits on anything invalid. Leave both
Supabase variables blank for health/preview-only mode, or configure both. The frontend validates
its public configuration before dev/build. ImageKit and AI remain unintegrated future phases.

---

## Project structure

```
.
├── frontend/
│   └── src/
│       ├── app/          # Router and providers
│       ├── layouts/      # AppShell, Sidebar, Topbar, MobileNav
│       ├── pages/        # Route-level screens
│       ├── features/     # Vertical slices (home, later: auth, catalog, ...)
│       ├── components/   # ui/ primitives and brand/ elements
│       ├── hooks/        # Shared hooks
│       ├── lib/          # API client, navigation map, utilities
│       └── styles/       # Tailwind entry + design tokens
└── backend/
    └── src/
        ├── config/       # Validated environment
        ├── routes/       # URL -> controller only
        ├── controllers/  # HTTP in/out
        ├── services/     # Business logic, no req/res
        ├── repositories/ # Database access (from Milestone 2)
        ├── middleware/   # Auth, validation, errors, rate limiting
        ├── validators/   # Zod schemas (as endpoints appear)
        ├── modules/      # ai/, extraction/, storage/ (later phases)
        └── lib/          # Logger, errors, helpers
```

### Architectural rules

1. `route → middleware → controller → service → repository`. Controllers never query the database;
   services never touch `req`/`res`.
2. Frontend features never import from each other. Shared code moves up to `components/` or `lib/`.
3. All API responses use one envelope:
   - success: `{ "data": ... }`
   - failure: `{ "error": { "code", "message", "details?" } }`
4. Backend imports use explicit `.js` extensions (`NodeNext` ESM). This is what lets the compiled
   output run directly on Node.

---

## Design system

Tailwind v4 is configured in CSS — there is no `tailwind.config.js`. Tokens live in
`frontend/src/styles/index.css` under `@theme`, so they are both CSS variables and Tailwind
utilities.

**Palette**

| Token        | Value     | Use                           |
| ------------ | --------- | ----------------------------- |
| `paper`      | `#faf6ec` | Page background               |
| `paper-deep` | `#f2ead9` | Sidebar, desk surfaces        |
| `surface`    | `#fffdf8` | Cards, sheets of paper        |
| `ink`        | `#1c2733` | Primary text                  |
| `ink-soft`   | `#46586a` | Body copy                     |
| `ink-muted`  | `#66717f` | Metadata                      |
| `rule`       | `#e6ddca` | Borders, notebook lines       |
| `navy`       | `#2b4a6f` | Primary accent, active nav    |
| `terracotta` | `#b4573c` | Secondary accent, margin rule |
| `brown`      | `#7b5a41` | Margin notes                  |
| `olive`      | `#5c7052` | Healthy / live states         |

**Typography** — Fraunces Variable for headings, Inter Variable for interface text. Both are
self-hosted through Fontsource, so there is no third-party font request.

**Utilities** — `.paper-panel`, `.ruled`, `.ruled-margin`, `.label-caps`, `.margin-note`.

**Primitives** — `Button` / `ButtonLink`, `Card`, `Input`, `Badge`, `SectionHeading`.

---

## API

| Method | Path                             | Purpose                                                                                 |
| ------ | -------------------------------- | --------------------------------------------------------------------------------------- |
| `GET`  | `/api/v1/health`                 | Service status, version, uptime                                                         |
| `POST` | `/api/v1/youtube/detailed-notes` | Validated URL/manual transcript; returns transcript required, processing or saved notes |

Unknown routes return `404` with the standard error envelope. Requests from origins outside
`FRONTEND_ORIGIN` return `403 CORS_FORBIDDEN`.

---

## Roadmap

| Milestone | Scope                                                                                     |
| --------- | ----------------------------------------------------------------------------------------- |
| **1**     | Foundation, design system, app shell, health endpoint                                     |
| B2/B3     | Shared database foundation and YouTube detailed notes; hosted verification pending        |
| Later     | Academic catalog (university → course → branch → semester → subject), no student accounts |
| 3         | Resource library: ImageKit uploads, Notes Gallery, reading view                           |
| 4         | Document extraction and AI-generated notes                                                |
| 5         | Flashcards and quizzes                                                                    |
| 6         | Sample papers and the AI study assistant                                                  |
| 7         | My Learning, progress tracking, polish                                                    |

The future catalog will support many universities/courses without hardcoding one academic scope.
The current schema contains shared learning resources, not catalog or student records.

---

## Notes for contributors

- Do not commit `.env`, `.env.local` or any real key.
- Academic PDFs and other resources will use the separately approved storage/resource workflow. This repository
  contains no sample academic content and no placeholder resource records.
- Add a dependency only with a stated reason; prefer the platform over a package.
