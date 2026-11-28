# ServiceNow Knowledge Hub — Wabi-Sabi & Matcha Theme

> A serene, Japanese-inspired learning platform built with **Next.js (App Router)**, **TypeScript**, and the **official Notion API**. It combines a public bilingual (EN/VI) **Knowledge Hub**, a private **Study Room** (Practice Mode, Mock Exams, and FSRS Active Recall), and a local **AI Translation Worker**.

---

## 🌿 Overview

**ServiceNow Knowledge Hub** is a documentation and certification-study portal designed for ServiceNow developers and administrators. Public content is managed directly in Notion, while the private Study Room uses an isolated Notion workspace with server-side grading and spaced-repetition scheduling.

### Key Highlights
- ⚡ **Next.js App Router & Strict TypeScript**: Server Components (RSC), Incremental Static Regeneration (ISR), and strict TypeScript across the web app, Study Room, and Translation Worker.
- 🍵 **Wabi-Sabi Design System**: Earthy, organic palette (`matcha`, `rice-paper`, `tea-slate`, `ink`, `sage`) with dark mode.
- 📖 **Modular Notion Engine (`lib/notion/`)**: Powered by `@notionhq/client`, supporting 25+ block types, callouts, columns, nested databases, Mermaid diagrams, math equations, lazy-loaded toggle blocks, and on-demand signed image URL refresh.
- 🌐 **Bilingual Articles (EN / VI)**: Locale-aware routing, `LanguageSwitcher`, `hreflang` SEO metadata, sibling navigation, and internal link localization.
- 🎓 **Private Study Room (`/study`)**: Access-key authentication, Practice Mode with instant server-side grading, timed randomized Mock Exams, bookmark-driven Active Recall using FSRS-6 (`ts-fsrs`), and cross-device bookmark synchronization.
- 🤖 **Local AI Translation Worker (`worker/` + `lib/notion-translation/`)**: One-click Notion Database Button workflow that discovers hierarchies, protects ServiceNow terminology, translates English articles into Vietnamese Draft pages, and recovers safely from interruptions using local checkpoints.

---

## 📂 Project Structure

```text
NotionNextArticle/
├── proxy.ts                                ← Edge guard for /study/* and /api/study/* (cookie gate + noindex headers)
├── app/
│   ├── layout.tsx                          ← Root layout, Google Fonts, and optional GA4 loader
│   ├── page.tsx                            ← Public Knowledge Hub homepage with course filtering
│   ├── not-found.tsx                       ← Zen "無 Mu" 404 page
│   ├── robots.ts                           ← Search engine rules (allows public Hub, disallows /study)
│   ├── sitemap.ts                          ← Locale-aware dynamic sitemap
│   ├── llms.txt/route.ts                   ← Machine-readable article index
│   ├── contact/page.tsx                    ← Bilingual contact & article correction form (Formspree)
│   ├── [...slug]/page.tsx                  ← Dynamic public article route (RSC + ISR + hreflang metadata)
│   ├── study/                              ← Private Study Room pages (dashboard, login, practice, exams, flashcards)
│   └── api/
│       ├── notion/
│       │   ├── children/route.ts           ← Lazy-loads child blocks for toggle blocks
│       │   └── image/route.ts              ← Refreshes expired signed Notion image/cover URLs
│       └── study/                          ← Authenticated Study Room APIs (auth, dashboard, practice, exams, recall, bookmarks, images)
├── components/
│   ├── Layout.tsx, Header.tsx, Sidebar.tsx ← Knowledge Hub shell, navigation, search, and dark mode
│   ├── CourseFilter.tsx, CourseCard.tsx    ← Homepage category/tag filter and article cards
│   ├── ArticleCover.tsx, NotionContent.tsx ← Article hero cover and interactive HTML enhancer
│   ├── NotionCodeBlock.tsx, MermaidDiagram.tsx, ImageSlider.tsx, NotionToggleBlock.tsx, NotionToggleHeading.tsx
│   ├── LanguageSwitcher.tsx, SiblingNavigation.tsx, TableOfContents.tsx, ReadingProgress.tsx, ArticleFeedback.tsx
│   └── study/
│       ├── StudyDashboardClient.tsx, LoginForm.tsx, StudyNav.tsx, StudyNavigationContext.tsx, StudyRichText.tsx
│       ├── PracticeModeClient.tsx + practice/  ← Practice UI components & hooks (session, bookmarks, shortcuts)
│       ├── ExamRunnerClient.tsx + exam/        ← Mock Exam UI components & hooks (session, review, shortcuts)
│       └── RecallSessionClient.tsx + recall/   ← Active Recall flashcard UI & hooks (session, bookmarks, shortcuts)
├── lib/
│   ├── locales.ts, site-url.ts, contact-i18n.ts
│   ├── notion-types.ts, notion-datasource-recovery.ts, notion-image-recovery.ts
│   ├── notion.ts + notion/                 ← Modular Knowledge Hub Notion integration (client, cache, properties, posts, access, images, renderer, translations, navigation, articles)
│   ├── study/
│   │   ├── config.ts, types.ts, schemas.ts, notion-client.ts, notion-data-source.ts
│   │   ├── auth/                           ← Scrypt key hashing, HMAC sessions, request guards, CSRF & rate limiting
│   │   ├── cache/, concurrency/            ← Server TTL content cache and Upstash Redis distributed locks
│   │   ├── fsrs/scheduler.ts               ← FSRS-6 spaced-repetition scheduler wrapper
│   │   ├── repositories/                   ← Notion-backed repositories (users, exams, questions, card-states, review-events, bookmarks)
│   │   ├── services/                       ← Server business logic (dashboard, practice, exam, grading, recall, bookmark)
│   │   ├── local-progress.ts + local-progress/ ← Browser LocalStorage persistence (practice, mock-exam, pending-bookmarks, dashboard, legacy-bookmarks)
│   │   ├── bookmark-sync.ts                ← Coalescing client bookmark sync controller with retry & recovery
│   │   ├── exam-shuffle.ts, practice-state.ts, practice-completion.ts, recall-removal.ts, keyboard.ts, navigation.ts
│   │   └── importer/                       ← Local HTML exam importer and image resolver
│   └── notion-translation/                 ← Local TypeScript AI Translation Worker engine
│       ├── config.ts, types.ts, reader.ts, block-classifier.ts, extractor.ts, terminology.ts, servicenow-glossary.json
│       ├── discovery.ts, planner.ts, validator.ts
│       ├── notion-client.ts + notion-client/   ← Notion SDK client, retry, pagination, DB schema, file uploads, mapping DB
│       ├── translator.ts + translator/         ← Prompts, reasoning modes, rate limiter, batching, parsers, AI providers, execution
│       ├── builder.ts + builder/               ← Rich-text reconstruction, block tree builder, VI slugs & page properties
│       ├── writer.ts + writer/                 ← Fingerprints, assets, block converter, 400 KB append batches, reconciliation, page creation
│       ├── checkpoint-store.ts + checkpoint-store/ ← Atomic state storage, job checkpoints, resource mappings, segment cache
│       └── workflow.ts + workflow/             ← Active job tracking, status updates, duplicate checks, single-page & hierarchical execution, stale recovery
├── worker/
│   ├── index.ts                            ← CLI entry point (--once, --dry-run, --page / --page-id)
│   ├── logger.ts                           ← Structured Pino logger with secret redaction
│   └── poller.ts                           ← Single-instance lock, poll cycle runner, and graceful shutdown
├── scripts/study/
│   ├── generate-key.ts                     ← CLI helper to generate Study Room access keys and hashes
│   └── import-exams.ts                     ← CLI helper to import exam HTML files into Study Room Notion DBs
├── tests/study/                            ← Unit & integration tests for Study Room (118 tests across 21 suites)
├── styles/
│   ├── globals.css                         ← Tailwind CSS directives and base typography
│   └── wabi-sabi-theme.css                 ← Wabi-Sabi color tokens and Notion block styling
├── .env.local.example
├── next.config.js, tailwind.config.js, postcss.config.js
├── tsconfig.json, tsconfig.study.json, tsconfig.worker.json
└── package.json
```

---

## 🧭 Developer Guide

This guide explains how the codebase works in plain English so you can debug issues and make changes with confidence.

### 1. Application Architecture

The project follows a clear layered flow:

```text
Browser (Client Components + Hooks)
  ↓ fetch('/api/...')
Next.js API Routes (app/api/**)
  ↓ validate request + check auth
Services (lib/study/services/* or lib/notion/*)
  ↓ read/write data
Repositories / Notion Clients (lib/study/repositories/*, lib/notion/client.ts)
  ↓ HTTPS API
Notion Databases (+ optional Upstash Redis)
```

#### Where does each part run?

| Runtime Environment | Code Locations | Purpose |
|---|---|---|
| **Browser** | `'use client'` files in `components/`, `components/study/**`, `lib/study/local-progress/**`, `lib/study/bookmark-sync.ts`, `lib/notion-image-recovery.ts` | Renders interactive UI, handles keyboard shortcuts, runs timers, syncs bookmarks, refreshes expired images, and stores device-local draft progress in `localStorage`. Never holds Notion tokens or answer keys. |
| **Next.js Server** | `proxy.ts`, Server Components in `app/**`, API routes in `app/api/**`, `lib/notion/**`, `lib/study/auth/**`, `lib/study/services/**`, `lib/study/repositories/**` | Talks to Notion APIs using server-only secrets, checks authentication and authorization, grades Practice and Mock Exam answers, runs FSRS scheduling, and caches content in memory. |
| **Local Translation Worker** | `worker/**`, `lib/notion-translation/**` | Runs locally from your terminal (`pnpm translate:worker`). Never runs inside the Next.js web server or browser. Polls Notion, calls your configured AI provider, writes translated Vietnamese Draft pages, and saves recovery checkpoints to `.translation-worker-state/`. |

#### How Notion, Redis, and Browser LocalStorage are used

- **Notion (Source of Truth):**
  - **Public Workspace (`NOTION_TOKEN`):** Stores public Knowledge Hub articles, nested lessons, and optional translation mappings.
  - **Private Study Workspace (`STUDY_NOTION_TOKEN`):** Completely separate Notion integration storing Study Users, Exam Collections, Question Bank (including answer keys and explanations), FSRS Card States, Review Events, and user Bookmarks.
- **Upstash Redis (Optional Server Infrastructure):**
  - Used only by the Study Room when `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are configured.
  - Provides distributed login rate limiting (`lib/study/auth/security.ts`) and short-lived per-card / per-user write locks (`lib/study/concurrency/distributed-lock.ts`). Falls back gracefully to in-memory guards for single-instance local use.
- **Browser LocalStorage (`lib/study/local-progress/`):**
  - Strictly scoped per authenticated `userId` and `examId`.
  - Stores only non-sensitive browser progress: in-progress Practice selections/filters, latest Practice completion summary, latest/best server-graded Mock Exam summary, and pending/failed bookmark sync operations waiting for retry.
  - Never stores auth secrets, session cookies, exam tokens, correct answer keys, or explanations.

---

### 2. Knowledge Hub Flow

When a visitor opens an article (for example `/servicenow-handbook`), the request moves through five clear steps:

1. **Route Request (`app/[...slug]/page.tsx`):**
   - Next.js matches the catch-all route and calls `generateMetadata()` and the page Server Component. Pages use ISR (`revalidate = 3600`) so static pages stay fast while refreshing in the background.
2. **Locate Article in Notion (`lib/notion/articles.ts` → `getPageBySlug`):**
   - Checks the published article catalog from `lib/notion/posts.ts` (`getAllPosts`). Matches by custom `Slug` or by a 32-character Notion page UUID (for nested child pages).
3. **Authorization (`lib/notion/access.ts` → `isPublicNotionPage`):**
   - Confirms the requested page is `Published` (or an authorized descendant of a published article) so unpublished drafts or private pages cannot be viewed by guessing a UUID.
4. **Retrieve & Render Blocks (`lib/notion/renderer.ts` → `getNotionPageData`, `renderBlocks`):**
   - Fetches child blocks via `lib/notion/client.ts` (with automatic data-source resolution and recovery from `lib/notion-datasource-recovery.ts`), converts Notion blocks into HTML with custom renderers (code blocks, callouts, columns, tables, `[slider]` toggles, Mermaid diagrams), and rewrites internal article links for the current locale via `localizeInternalLinks` (`lib/notion/translations.ts`).
5. **Display to the User (`components/NotionContent.tsx`):**
   - Renders the HTML on the client and upgrades interactive blocks into React components (`NotionCodeBlock`, `MermaidDiagram`, `ImageSlider`, `NotionToggleBlock`, `NotionToggleHeading`). Expanding a toggle calls `app/api/notion/children/route.ts` to lazy-load nested blocks.

#### Supporting Knowledge Hub Features
- **Language Switching:** `lib/notion/translations.ts` (`getArticleTranslations`, `getTranslationMappings`) links published `en` and `vi` articles by their shared `Translation Group ID` (or dedicated mapping DB). `components/LanguageSwitcher.tsx` renders the switch link, and `app/[...slug]/page.tsx` outputs `hreflang` SEO alternates.
- **Sibling Navigation:** `lib/notion/navigation.ts` (`getSiblingPages`) computes the previous and next lessons within the same course and locale for `components/SiblingNavigation.tsx`.
- **Caching:** `lib/notion/cache.ts` stores posts, rendered pages, and mappings on `globalThis` with a 50-minute TTL and in-flight request deduplication to stay under Notion's 1-hour signed S3 URL lifetime.
- **Image URL Refresh:** Notion-hosted image URLs expire after ~1 hour. If an image fails to load in the browser, `lib/notion-image-recovery.ts` calls `app/api/notion/image/route.ts`, which verifies public block ownership (`isBlockInPublicContent` in `lib/notion/access.ts`) and fetches a fresh signed URL via `refreshNotionBlockImageUrl` / `refreshNotionPageCoverUrl` (`lib/notion/images.ts`).

---

### 3. Study Room Flow

#### Authentication & Session Handling
1. A user signs in at `/study/login` (`components/study/LoginForm.tsx` → `POST /api/study/auth/login`).
2. `lib/study/auth/crypto.ts` verifies the access key using salted Node `scrypt` and signs an HMAC session cookie (`lib/study/auth/session.ts`).
3. `proxy.ts` blocks unauthenticated requests to `/study/*` and `/api/study/*` early and sets `X-Robots-Tag: noindex` and `Cache-Control: private, no-store` headers.
4. Every Study Room Server Component and API route also calls `lib/study/auth/guard.ts` to verify the cookie signature, check user revocation/`credentialVersion` in Notion, and enforce CSRF protection on state-changing requests (`lib/study/auth/security.ts`).

#### Practice Mode
- `components/study/PracticeModeClient.tsx` coordinates the screen using focused hooks under `components/study/practice/`:
  - `usePracticeSession.ts` loads exam questions via `GET /api/study/practice/[examId]` (`lib/study/services/practice-service.ts`), restores saved local progress (`lib/study/local-progress/practice.ts`), and checks each answer via `POST /api/study/practice/check` (`lib/study/services/grading.ts`).
  - `usePracticeBookmarks.ts` delegates bookmark toggles to `lib/study/bookmark-sync.ts`.
  - `usePracticeKeyboardShortcuts.ts` handles keyboard navigation using `lib/study/keyboard.ts`.
- Practice Mode **never mutates FSRS card state**; it is strictly for low-pressure learning.

#### Mock Exam Mode
- `components/study/ExamRunnerClient.tsx` delegates state to `components/study/exam/useMockExamSession.ts` and renders `ExamActiveView.tsx` (during the exam) and `ExamResultsReview.tsx` (after grading).
- `POST /api/study/exams/start` (`lib/study/services/exam-service.ts`) selects questions, shuffles question and option order safely (`lib/study/exam-shuffle.ts`, keeping order-dependent questions intact), and issues a signed exam token without sending correct answers to the browser.
- `POST /api/study/exams/submit` verifies the signed exam token, grades answers server-side (`lib/study/services/grading.ts`), returns full explanations, and the client saves the latest/best summary to `lib/study/local-progress/mock-exam.ts`.

#### Active Recall & FSRS Scheduling
- Only **bookmarked** questions enter Active Recall.
- `components/study/RecallSessionClient.tsx` uses `components/study/recall/useRecallSession.ts` to fetch the queue from `GET /api/study/recall/queue` (`lib/study/services/recall-service.ts`), which loads bookmarked questions first, orders due cards before new cards, and tracks upcoming review dates.
- Clicking reveal fetches the answer/explanation via `POST /api/study/recall/reveal`.
- Submitting a rating (`Again`, `Hard`, `Good`, `Easy`) calls `POST /api/study/recall/review`, which acquires a per-card lock (`distributed-lock.ts`), computes the next schedule via `lib/study/fsrs/scheduler.ts` (`ts-fsrs`), writes an idempotent `ReviewEvent`, and saves `FsrsCardState` with optimistic revision concurrency.
- Removing a bookmark from Active Recall (`useRecallBookmarks.ts` + `lib/study/recall-removal.ts`) excludes the card immediately without deleting its FSRS history—if re-bookmarked later, its FSRS state is reused.

#### Bookmark Synchronization Across Devices
- `lib/study/bookmark-sync.ts` implements a non-blocking, coalescing sync controller: rapid clicks update the UI immediately, batch/coalesce pending add/remove changes into `POST /api/study/bookmarks` (`lib/study/services/bookmark-service.ts`), respect `Retry-After` headers, guard against stale `GET` responses overwriting newer saves, and persist failed operations to `lib/study/local-progress/pending-bookmarks.ts` so they can be retried after offline/error recovery.

---

### 4. Translation Worker Flow

When you click **Translate to Vietnamese** in Notion (setting `Translation Status = Requested`) or run `pnpm translate --page <id>`, the local worker runs an 8-stage pipeline:

1. **Polling (`worker/poller.ts` → `startPoller`, `runPollCycle`):**
   - Acquires `.translation-worker.lock` (preventing duplicate worker processes), checks required Notion schema columns (`ensureTranslationSchema`), runs stale job recovery (`recoverStaleProcessingPages` in `workflow/recovery.ts`), and scans for English pages with `Translation Status = Requested`.
2. **Content Discovery & Planning (`discovery.ts` → `discoverContentHierarchy`, `planner.ts` → `buildTranslationPlan`):**
   - Recursively discovers the root page, inline `child_page` blocks, nested `child_database` rows, and `Parent`-related items.
   - Marks all discovered IDs active in `workflow/active-jobs.ts` (cleaned up in `finally`), checks existing translations/duplicates (`workflow/existing-translation.ts`), and builds a `ReferenceResolutionMap` for cross-page links.
3. **Manifest Extraction (`extractor.ts` → `extractTranslationManifest`, `block-classifier.ts`):**
   - Walks the raw Notion block tree (`reader.ts` → `readRawNotionTree`) and extracts only human-readable `rich_text` runs (page Title, Summary, paragraph/heading/list/table/caption text) with stable run IDs while preserving code blocks, equations, inline code, and mentions untouched.
4. **AI Translation & Batching (`translator.ts` → `translateManifest` + `translator/`):**
   - `terminology.ts` replaces ServiceNow terms, tables, fields, `sys_id`s, and API calls with `__SN<n>__` placeholders.
   - Reuses fully technical segments and persistent cache hits from `.translation-worker-state/segment-cache.json`.
   - `translator/batching.ts` groups remaining segments into section-aware adaptive batches (40–80 segments) within input/output token and timeout budgets.
   - `translator/rate-limiter.ts` enforces RPM/TPM/RPD/TPD pacing and provider cooldown headers.
   - `translator/providers.ts` sends requests to Gemini, Anthropic, or OpenAI-compatible APIs (Groq, OpenRouter, OpenAI, DeepSeek) with model-aware reasoning control (`translator/reasoning.ts`).
   - `translator/response-parser.ts` parses JSON, verifies placeholders, salvages completed pairs if an output is truncated (`finish_reason="length"`), and `translator/execution.ts` escalates `max_tokens` or splits oversized batches/segments when needed.
5. **Translated Block & Property Reconstruction (`builder.ts` + `builder/`):**
   - `builder/block-tree.ts` and `builder/rich-text.ts` apply translations back onto the cloned block tree, preserve annotations and boundary whitespace, split runs over 2,000 characters, and localize internal links/mentions.
   - `builder/page-properties.ts` generates a unique ASCII Vietnamese slug and builds Notion properties with `Status = Draft` and `Locale = vi`.
6. **Notion Page & Block Writing (`writer.ts` → `createTranslatedNotionPage` + `writer/`):**
   - `writer/assets.ts` re-uploads Notion-hosted cover/icon files via `notion-client/assets.ts` (`reuploadNotionAsset`) and caches upload IDs in the checkpoint.
   - `writer/page.ts` creates or safely resumes the target Draft page.
   - `writer/block-converter.ts` converts translated nodes to Notion `BlockObjectRequest` payloads.
   - `writer/append.ts` chunks writes within Notion's 100-block and **400 KB** payload ceilings, interleaves positional `child_page` creations, and reconciles uncertain API responses via `writer/reconciliation.ts` + `writer/fingerprint.ts`.
7. **Checkpoint Persistence & Recovery (`checkpoint-store.ts` + `checkpoint-store/`):**
   - Atomically writes per-job progress (`job-<id>.json`), cross-job page mappings (`resource-map.json`), and translated segments (`segment-cache.json`) into `.translation-worker-state/` with secret keys stripped.
   - Saves AI translations **before** Notion writes and records pending/completed batches around every `blocks.children.append`, so crashed or quota-paused jobs resume cleanly without duplicating pages or blocks or overwriting `Published` targets.
8. **Validation & Final Status Updates (`validator.ts` + `workflow/single-job.ts` / `workflow/hierarchical-plan.ts`):**
   - Re-reads the written Vietnamese page from Notion, verifies block counts, order, code, equations, links, and media (`validateTranslation`), updates `Translation Status` to `Draft Ready` or `Needs Review` (aggregating child outcomes onto the root page), updates the Notion Translation Mapping DB (`notion-client/mapping.ts`), and removes the completed checkpoint file.

---

## 🗺️ Where Should I Make Changes?

| Task / Question | Primary File(s) / Module(s) | Responsibility |
|---|---|---|
| Change the homepage layout | `app/page.tsx`, `components/CourseFilter.tsx`, `components/CourseCard.tsx` | Homepage Server Component, category/tag filter bar, and article cards |
| Change article rendering or page chrome | `app/[...slug]/page.tsx`, `components/NotionContent.tsx`, `components/ArticleCover.tsx`, `styles/wabi-sabi-theme.css` | Article route, client HTML-to-React hydration, hero cover, and typography styles |
| Add support for a Notion block type (Website) | `lib/notion/renderer.ts`, `components/NotionContent.tsx` | Custom block-to-HTML renderers and interactive React enhancers |
| Add support for a Notion block type (Translation Worker) | `lib/notion-translation/block-classifier.ts`, `lib/notion-translation/writer/block-converter.ts`, `lib/notion-translation/writer/fingerprint.ts`, `lib/notion-translation/validator.ts` | Block rules, Notion write payload builder, reconciliation fingerprint, and post-write checks |
| Change image URL refresh behavior | `app/api/notion/image/route.ts`, `lib/notion/images.ts`, `lib/notion/access.ts`, `lib/notion-image-recovery.ts` | Image refresh API endpoint, Notion block/cover URL fetchers, public authorization, and client retry helper |
| Change bilingual navigation or language switching | `lib/notion/translations.ts`, `lib/notion/navigation.ts`, `components/LanguageSwitcher.tsx`, `components/SiblingNavigation.tsx` | EN/VI translation group lookup, link localization, prev/next lesson computation, and UI controls |
| Change Practice Mode UI | `components/study/PracticeModeClient.tsx`, `components/study/practice/PracticeQuestionCard.tsx`, `components/study/practice/PracticeExamSelector.tsx`, `components/study/practice/PracticeBanners.tsx`, `components/study/PracticeCompletion.tsx` | Practice screen layout, question card, exam selector, banners, and completion summary |
| Change Practice Mode keyboard shortcuts | `components/study/practice/usePracticeKeyboardShortcuts.ts`, `lib/study/keyboard.ts` | Key bindings for Practice navigation, selection, checking, and bookmarking |
| Change Mock Exam UI or timer behavior | `components/study/ExamRunnerClient.tsx`, `components/study/exam/ExamActiveView.tsx`, `components/study/exam/ExamResultsReview.tsx`, `components/study/exam/useMockExamSession.ts` | Timed exam runner, results review screen, timer state, and submit flow |
| Change Active Recall UI | `components/study/RecallSessionClient.tsx`, `components/study/recall/RecallFlashcard.tsx`, `components/study/recall/RecallStatusViews.tsx`, `components/study/recall/useRecallSession.ts` | Flashcard UI, rating buttons, empty/completion states, and review queue state |
| Investigate bookmark synchronization | `lib/study/bookmark-sync.ts`, `lib/study/local-progress/pending-bookmarks.ts`, `app/api/study/bookmarks/route.ts`, `lib/study/services/bookmark-service.ts`, `lib/study/repositories/bookmark-repo.ts` | Coalescing sync controller, failed-op retry persistence, API route, locking, and Notion bookmark storage |
| Investigate local progress persistence | `lib/study/local-progress.ts`, `lib/study/local-progress/*` (`storage.ts`, `practice.ts`, `mock-exam.ts`, `pending-bookmarks.ts`, `dashboard.ts`, `legacy-bookmarks.ts`) | Versioned, user-scoped `localStorage` keys, bounds, and read/write helpers |
| Investigate FSRS scheduling | `lib/study/fsrs/scheduler.ts`, `lib/study/services/recall-service.ts`, `lib/study/repositories/card-state-repo.ts`, `lib/study/repositories/review-event-repo.ts` | `ts-fsrs` interval calculation, review idempotency, and Notion FSRS persistence |
| Change the AI translation prompt or glossary | `lib/notion-translation/translator/prompts.ts`, `lib/notion-translation/servicenow-glossary.json`, `lib/notion-translation/terminology.ts` | System/user prompt templates, `PROMPT_VERSION`, glossary terms, and `__SN<n>__` placeholder rules |
| Change translation batching or output token budgets | `lib/notion-translation/translator/batching.ts`, `lib/notion-translation/translator/prompts.ts`, `lib/notion-translation/config.ts` | Adaptive section-aware batching (40–80 segments), oversized segment splitting, and token ceiling formulas |
| Investigate AI rate limiting or quota pauses | `lib/notion-translation/translator/rate-limiter.ts`, `lib/notion-translation/translator/errors.ts`, `lib/notion-translation/translator/providers.ts` | Sliding-window RPM/TPM/RPD/TPD pacing, `Retry-After` cooldowns, and daily quota exhaustion detection |
| Investigate Notion file uploads (media/covers/icons) | `lib/notion-translation/notion-client/assets.ts`, `lib/notion-translation/writer/assets.ts`, `lib/notion-translation/writer/block-converter.ts` | Byte-limited streaming download, Notion `fileUploads` API, and checkpoint upload reuse |
| Investigate failed, duplicate, or interrupted translation jobs | `lib/notion-translation/workflow/single-job.ts`, `lib/notion-translation/workflow/hierarchical-plan.ts`, `lib/notion-translation/workflow/existing-translation.ts`, `lib/notion-translation/workflow/recovery.ts`, `lib/notion-translation/writer/reconciliation.ts` | Job lifecycle, Published target protection, duplicate alerts, stale `Processing` recovery, and append reconciliation |
| Investigate checkpoint persistence & recovery | `lib/notion-translation/checkpoint-store/` (`storage.ts`, `job-checkpoint.ts`, `resource-mappings.ts`, `segment-cache.ts`) | Atomic JSON writes, per-job checkpoints, cross-job mapping store, and segment translation cache |

---

## 🚀 Quick Start

### 1. Clone & Install Dependencies

```bash
pnpm install
```

### 2. Configure Environment Variables

Copy the template file:
```bash
cp .env.local.example .env.local
```

Edit `.env.local` with your credentials (never commit `.env.local` or real secrets). See `.env.local.example` for the complete list of optional Knowledge Hub, Translation Worker, and private Study Room variables:

```env
# Public Knowledge Hub Notion config
NOTION_ROOT_PAGE_ID=your_notion_database_or_page_id
NOTION_TRANSLATION_DATABASE_ID=your_articles_database_id_here
NOTION_TOKEN=secret_your_notion_integration_token

# Site metadata
NEXT_PUBLIC_SITE_NAME="ServiceNow Knowledge Hub"
NEXT_PUBLIC_SITE_DESCRIPTION="A serene learning space for mastering ServiceNow."
NEXT_PUBLIC_SITE_URL=http://localhost:3000

# AI translation configuration
# Supported AI_PROVIDER values: groq | openrouter | openai | openai-compatible | gemini | anthropic | deepseek
AI_PROVIDER=groq
GROQ_API_KEY=your_groq_api_key_here
AI_BASE_URL=https://api.groq.com/openai/v1
AI_MODEL=qwen/qwen3-32b

# Local translation worker settings (matches config.ts defaults)
TRANSLATION_POLL_INTERVAL_MS=60000
TRANSLATION_TARGET_LOCALE=vi
TRANSLATION_BATCH_SIZE=60
TRANSLATION_MAX_BATCH_SEGMENTS=80
TRANSLATION_MAX_BATCH_CHARS=12000
TRANSLATION_MAX_INPUT_TOKENS_PER_BATCH=4500
TRANSLATION_TARGET_OUTPUT_TOKENS_PER_BATCH=5000
TRANSLATION_MIN_OUTPUT_TOKENS=2048
TRANSLATION_MAX_OUTPUT_TOKENS=8192
TRANSLATION_OUTPUT_SAFETY_MARGIN=1.8
TRANSLATION_ASSUMED_OUTPUT_TPS=53
TRANSLATION_CONCURRENCY=1
TRANSLATION_STALE_TIMEOUT_MS=1800000

# Request timeouts, media size limit, and pagination safety limits
TRANSLATION_AI_TIMEOUT_MS=120000
TRANSLATION_NOTION_TIMEOUT_MS=30000
TRANSLATION_ASSET_TIMEOUT_MS=60000
TRANSLATION_MAX_ASSET_BYTES=20971520
TRANSLATION_MAX_PAGINATION_PAGES=500

# Private Study Room (separate isolated Notion integration + session secret)
STUDY_NOTION_TOKEN=secret_your_private_study_notion_token_here
STUDY_NOTION_USERS_DB_ID=your_study_users_database_id_here
STUDY_NOTION_EXAMS_DB_ID=your_exam_collections_database_id_here
STUDY_NOTION_QUESTIONS_DB_ID=your_question_bank_database_id_here
STUDY_NOTION_CARD_STATES_DB_ID=your_fsrs_card_state_database_id_here
STUDY_NOTION_REVIEW_EVENTS_DB_ID=your_review_events_database_id_here
STUDY_NOTION_BOOKMARKS_DB_ID=your_study_bookmarks_database_id_here
STUDY_SESSION_SECRET=replace_with_at_least_32_random_characters
```

### 3. Run Development Server

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## ⚙️ Notion Database Schema

Your Notion **Articles** database uses the following properties:

### Core & Bilingual Properties

| Property | Notion Type | Description |
|---|---|---|
| `Name` / `Title` | `title` | Article / Lesson title (detected dynamically regardless of column name) |
| `Slug` | `rich_text` | Custom URL slug (falls back to auto-slugified title or Page ID) |
| `Status` | `status` / `select` | Controls website publication: `Published` (shown on website), `Draft`, `Archived` |
| `Locale` | `select` / `rich_text` | Content language: `en` (default if empty) or `vi` |
| `Translation Group ID` | `rich_text` | Stable UUID/ID linking translations of the same article (auto-generated if empty) |
| `Category` | `select` | High-level topic (e.g., `ITSM`, `Discovery`, `Scripting`, `CMDB`) |
| `Tags` | `multi_select` | Keyword tags for secondary filtering |
| `Summary` | `rich_text` | Short description displayed on cards and article headers |
| `Difficulty` | `select` | `Beginner`, `Intermediate`, `Advanced` |
| `Duration` | `rich_text` / `number` | Estimated read/completion time (e.g. `20 min`) |
| `Parent Course` | `relation` / `select` | Optional parent course reference to group sub-lessons |

### AI Translation Workflow Properties

The worker automatically checks for and creates these properties on the database if they do not already exist (`lib/notion-translation/notion-client/database.ts` → `ensureTranslationSchema`):

| Property | Notion Type | Purpose |
|---|---|---|
| `Translation Status` | `select` | Controls the translation job state (`Not Started`, `Requested`, `Processing`, `Draft Ready`, `Needs Review`, `Failed`) |
| `Translation Error` | `rich_text` | Stores validation warnings, review notes, duplicate alerts, or error details |
| `Translation Target Page ID` | `rich_text` | Stores the generated Vietnamese Notion page ID |
| `Translation Updated At` | `date` | Timestamp of the last worker job state update |

> **Important**: Never confuse `Status` with `Translation Status`.
> - `Status` (`Draft` / `Published`) controls whether an article is publicly visible on the website.
> - `Translation Status` (`Requested` → `Processing` → `Draft Ready` / `Needs Review` / `Failed`) controls the local AI translation worker lifecycle.

---

## 🤖 Local AI Translation Worker Setup & Usage

### 1. Notion Integration Permissions

In [Notion My Integrations](https://www.notion.so/my-integrations), open your integration settings and ensure the following **Capabilities** are enabled:
- ✅ **Read content**
- ✅ **Update content**
- ✅ **Insert content**

Also make sure your Articles database is connected to the integration (`•••` menu in top-right of the Notion database → **Connections** → select your integration).

### 2. Configure the Notion Database Button (`Translate to Vietnamese`)

Add a **Button** property to your Notion Articles database:
1. Click `+` to add a new property in your Articles database and choose **Button**.
2. Name the property: `Translate to Vietnamese`.
3. Set the button label to: `Translate to Vietnamese`.
4. Add an action: **Edit pages in...** → select **This page**.
5. Configure the property edit:
   - Set `Translation Status` = `Requested`
   - *(Optional)* Set `Translation Error` = *(Clear / Empty)*

Whenever you finish writing an English article (`Locale = en` or empty), simply click **Translate to Vietnamese** on that row.

### 3. AI Provider Configuration

The translation engine uses a multi-provider adapter (`lib/notion-translation/translator/providers.ts`) configured via `.env.local`:

- **Groq (Recommended for Free/Low-Cost Development Testing)**:
  ```env
  AI_PROVIDER=groq
  GROQ_API_KEY=your_groq_api_key_here
  AI_BASE_URL=https://api.groq.com/openai/v1
  AI_MODEL=qwen/qwen3-32b
  ```
- **OpenRouter (Flexible Multi-Model Routing)**:
  ```env
  AI_PROVIDER=openrouter
  OPENROUTER_API_KEY=your_openrouter_api_key_here
  AI_BASE_URL=https://openrouter.ai/api/v1
  AI_MODEL=qwen/qwen3-32b
  ```
- **OpenAI**:
  ```env
  AI_PROVIDER=openai
  AI_API_KEY=your_openai_api_key_here
  AI_BASE_URL=https://api.openai.com/v1
  AI_MODEL=gpt-4o-mini
  ```
- **Google Gemini**:
  ```env
  AI_PROVIDER=gemini
  AI_API_KEY=your_gemini_api_key_here
  AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta
  AI_MODEL=gemini-2.5-flash
  ```
- **Anthropic Claude**:
  ```env
  AI_PROVIDER=anthropic
  AI_API_KEY=your_anthropic_api_key_here
  AI_BASE_URL=https://api.anthropic.com/v1
  AI_MODEL=claude-3-5-sonnet-latest
  ```

### 3b. ServiceNow Terminology Protection & Token Optimization

- **Deterministic Terminology Protection (`lib/notion-translation/terminology.ts`)**:
  - Official ServiceNow terms (`Catalog Item`, `Record Producer`, `Business Rule`, `Script Include`, `Flow Designer`, `Service Catalog`, `CMDB`, `CSDM`, `IRE`, `RITM`, `SCTASK`, `GlideRecord`, etc.), table/field identifiers (`sc_req_item`, `short_description`, `sys_id`), 32-char hex `sys_id`s, ticket numbers, API calls (`gs.*`, `g_form.*`), URLs, and custom object names are automatically protected with compact placeholders (`__SN0__`, `__SN1__`, ...) before sending text to the AI and restored verbatim after translation.
  - Customize protected terms without changing code by editing `lib/notion-translation/servicenow-glossary.json` (or setting `TRANSLATION_GLOSSARY_PATH` / `TRANSLATION_CUSTOM_TERMS` in `.env.local`).
- **Compact Batching & Persistent Segment Cache**:
  - Batches are sent as compact flat JSON maps (`{"a":"...","b":"..."}`) with short keys and a concise ServiceNow-specific system prompt (`lib/notion-translation/translator/prompts.ts`).
  - Translated segments are cached in `.translation-worker-state/segment-cache.json` by SHA-256 fingerprint (`lib/notion-translation/checkpoint-store/segment-cache.ts`), so re-runs or incremental edits to an article reuse unchanged segments with zero AI token cost.
- **Output Token Budgeting, Reasoning Control & Truncation Recovery**:
  - Separates estimated visible output tokens from the `max_tokens` generation ceiling using `TRANSLATION_MIN_OUTPUT_TOKENS` (default `2048`), `TRANSLATION_MAX_OUTPUT_TOKENS` (default `8192`), and `TRANSLATION_OUTPUT_SAFETY_MARGIN` (default `1.8`).
  - Capability-aware reasoning control (`TRANSLATION_DISABLE_REASONING=true` in `translator/reasoning.ts`): disables chain-of-thought reasoning where officially supported (`qwen/qwen3*` on Groq via `reasoning_effort="none"`, `gemini-2.5-flash` via `thinkingBudget=0`, and hybrid reasoning models on OpenRouter via `reasoning: { effort: "none", exclude: true }`).
  - Always-on reasoning models (such as Nemotron, DeepSeek R1, QwQ, and `o1`/`o3`/`o4`) cannot disable internal thinking via API and count reasoning tokens toward `max_tokens`. When one is selected, the worker logs a one-time capability warning, allocates extra reasoning headroom (`4096`+ floor), salvages completed JSON key-value pairs on `finish_reason="length"`, escalates `max_tokens` before splitting batches, and splits oversized single segments at natural sentence/clause boundaries.
- **Rate-Limit Pacing & Daily Quota Pause/Resume**:
  - Configurable `TRANSLATION_RPM_LIMIT`, `TRANSLATION_TPM_LIMIT`, `TRANSLATION_RPD_LIMIT`, and `TRANSLATION_TPD_LIMIT` (`translator/rate-limiter.ts`).
  - If a provider's daily quota is exhausted (HTTP 429 daily limit / 402 or configured RPD/TPD cap), the worker safely pauses the job, keeps the Notion source page in `Requested` with `[Quota Paused]` details in `Translation Error`, preserves all completed batches and cached segments locally, and stops polling until restarted.

### 4. Starting the Worker on Windows PowerShell

The worker runs locally on your Windows PC and does **not** require `pnpm dev` or Docker to be running.

- **Continuous polling mode** (scans every 60 seconds by default):
  ```powershell
  pnpm translate:worker
  ```
- **Translate a specific page (and its entire nested hierarchy) once**:
  ```powershell
  pnpm translate --page <32_char_or_uuid_page_id>
  ```
- **Single-cycle mode** (scans once, processes all `Requested` English pages, then exits):
  ```powershell
  pnpm translate:worker -- --once
  ```
- **Dry-run mode** (discovers hierarchy, runs AI translation, and validates in memory without modifying Notion):
  ```powershell
  pnpm translate:worker -- --once --dry-run
  ```
- **Dry-run a specific page ID**:
  ```powershell
  pnpm translate --page <32_char_or_uuid_page_id> --dry-run
  ```

Press `Ctrl+C` in PowerShell at any time for a **graceful shutdown** — the worker will finish the active article job (if one is in progress), release `.translation-worker.lock`, and exit cleanly.

### 5. Reviewing and Publishing a Translated Article

1. When a translation job finishes cleanly, the English source page's `Translation Status` becomes `Draft Ready` (or `Needs Review` if special/unsupported blocks require attention) and `Translation Target Page ID` is populated.
2. Open the newly created Vietnamese row in your Notion Articles database:
   - `Locale` is set to `vi`.
   - `Translation Group ID` matches the English source article.
   - `Slug` is an ASCII Vietnamese-friendly unique slug (e.g. `tim-hieu-kien-truc-cmdb-va-ire`).
   - `Status` is set to **`Draft`** (never auto-published).
3. Review the Vietnamese content in Notion.
4. Change the Vietnamese page's **`Status`** property from `Draft` to **`Published`**.
5. The Next.js website (`LanguageSwitcher`, `hreflang` SEO tags, sitemap, and internal article links) will automatically detect and link the published Vietnamese version.

---

## 🧱 Supported & Special Notion Block Types

| Block Type | Translation Behavior | Support Level |
|---|---|---|
| `paragraph` | Translates rich text runs; preserves bold, italic, underline, strikethrough, color, links, inline code, inline math, and mentions | ✅ Full |
| `heading_1` – `heading_6` | Translates heading rich text; preserves color and toggleable headings | ✅ Full (`heading_5`/`6` mapped to `heading_4` on Notion API write) |
| `bulleted_list_item` | Translates rich text and recursively reconstructs nested lists/children | ✅ Full |
| `numbered_list_item` | Translates rich text and recursively reconstructs nested lists/children | ✅ Full |
| `to_do` | Translates rich text, preserves `checked` boolean state, color, and children | ✅ Full |
| `quote` | Translates rich text and nested children; preserves color | ✅ Full |
| `callout` | Translates rich text and nested children; preserves emoji/external icon and color | ✅ Full |
| `toggle` | Translates toggle title and nested children; preserves `[slider]` marker for `ImageSlider` | ✅ Full |
| `table` / `table_row` | Translates cell rich text; preserves `table_width`, `has_column_header`, `has_row_header` | ✅ Full (supports >100 rows via chunked append) |
| `column_list` / `column` | Preserves column layout, `width_ratio`, and recursively translates column children | ✅ Full |
| `code` | **Never translates programming code**; preserves code text, caption, and language verbatim | ✅ Full |
| `equation` | **Never translates LaTeX formulas**; preserves block and inline equations verbatim | ✅ Full |
| `image`, `video`, `file`, `pdf`, `audio` | Translates caption; reuses external URLs and re-uploads Notion-hosted expiring files via `fileUploads` API | ✅ Full (marks `Needs Review` if an expiring URL cannot be downloaded) |
| `bookmark`, `embed` | Preserves destination `url`; translates `bookmark` caption | ✅ Full |
| `divider`, `breadcrumb`, `table_of_contents` | Preserves block structure and metadata without translation | ✅ Full |
| `synced_block` | Recreates as an independent `synced_block` (`synced_from: null`) with translated children | ⚠️ Marks `Needs Review` (live sync with English block is not retained) |
| `child_page` | Creates a real Vietnamese child page (`parent: { page_id }`) under the Vietnamese parent page at the exact block position and recursively translates its content | ✅ Full |
| `child_database` | Shares the same nested database (never duplicates the database), recursively translates its English rows into Vietnamese (`Locale = vi`, `Status = Draft`) inside that database, and links the shared database on the Vietnamese parent page | ✅ Full |
| `link_to_page` | Localizes `page_id` references to the corresponding Vietnamese page when available, or preserves the original reference | ✅ Full (marks `Needs Review` only if referenced external page has no translation) |
| `unsupported` | Never silently dropped; records block ID, type, and position in `Translation Error` | ⚠️ Marks `Needs Review` |

---

## Google Analytics 4 (GA4)

This application includes an optional, lightweight integration with **Google Analytics 4 (GA4)** using Next.js's official `@next/third-parties/google` package. It tracks homepage visits, dynamic article pages (`/[...slug]`), and both English and Vietnamese articles using GA4's built-in automatic events and Enhanced Measurement — with no custom database, authentication, or backend API required.

If `NEXT_PUBLIC_GA_MEASUREMENT_ID` is not set, GA4 is completely disabled and no analytics scripts are loaded.

### 1. Create a GA4 Property

1. Sign in to [Google Analytics](https://analytics.google.com/).
2. Click **Admin** (gear icon in the bottom-left corner).
3. Under the **Account** column, select an existing account or click **Create Account**.
4. Under the **Property** column, click **Create Property**.
5. Enter a property name (for example, `ServiceNow Knowledge Hub`), select your reporting time zone and currency, and complete the setup prompts.

### 2. Create a Web Data Stream

1. In **Admin → Data collection and modification → Data streams**, click **Add stream** → **Web**.
2. Enter your production website URL (for example, `https://your-domain.vercel.app`) and a stream name.
3. Keep **Enhanced measurement** toggled **ON**.
4. Click **Create & continue**.

### 3. Obtain Your Measurement ID

1. Open your newly created Web Data Stream in **Admin → Data streams**.
2. Copy the **Measurement ID** at the top-right of the stream details panel. It starts with `G-` (for example, `G-XXXXXXXXXX`).

### 4. Configure `NEXT_PUBLIC_GA_MEASUREMENT_ID`

#### Locally (`.env.local`)

Add your Measurement ID to `.env.local` (never commit `.env.local`):

```env
NEXT_PUBLIC_GA_MEASUREMENT_ID=G-XXXXXXXXXX
```

Restart the development server (`pnpm dev`) after updating `.env.local`.

#### On Vercel

1. Open your project in the [Vercel Dashboard](https://vercel.com/dashboard).
2. Go to **Settings → Environment Variables**.
3. Add a new variable:
   - **Key**: `NEXT_PUBLIC_GA_MEASUREMENT_ID`
   - **Value**: `G-XXXXXXXXXX` (your GA4 Measurement ID)
   - **Environments**: Select **Production** (optionally **Preview** if you want to track preview deployments; keeping it Production-only avoids polluting production metrics).
4. Click **Save** and trigger a **Redeploy** (Next.js inlines `NEXT_PUBLIC_*` environment variables at build time).

### 5. Enable & Verify Enhanced Measurement

1. In Google Analytics, go to **Admin → Data collection and modification → Data streams** and select your Web Data Stream.
2. Ensure **Enhanced measurement** is enabled, then click the gear icon to review individual toggles:
   - **Page views** (ON) — expand **Show advanced settings** and confirm **Page changes based on browser history events** is checked. This enables automatic `page_view` tracking across Next.js client-side navigation without duplicate events.
   - **Scrolls** (ON) — automatically tracks 90% scroll depth.
   - **Outbound clicks** (ON) — automatically tracks clicks on external links.
   - **File downloads** / **Video engagement** (optional, ON by default).
3. Click **Save**.

### 6. Verify `page_view` Events in GA4 Realtime

1. Open your deployed site (or local dev server with `NEXT_PUBLIC_GA_MEASUREMENT_ID` set) in a browser without an ad blocker.
2. Navigate between the homepage, an English article, and a Vietnamese article.
3. In Google Analytics, open **Reports → Realtime** (wait 10–30 seconds).
4. Confirm:
   - Active users appear on the Realtime map/cards.
   - `page_view` events appear in the **Event count by Event name** card.
   - Each route change generates **one** `page_view` event (no duplicates) with the expected page title and URL path.

### 7. Find the Most Visited Articles

1. Go to **Reports → Engagement → Pages and screens**.
2. Change the primary dimension dropdown to **Page path and screen class** (to see article slugs like `/your-article-slug`) or **Page title and screen name**.
3. Sort by **Views** or **Active users** to see your most popular ServiceNow articles.

### 8. View Engagement, Traffic Sources & Audience Metrics

- **Engagement & Reading Time**: Go to **Reports → Engagement → Overview** and **Pages and screens** to view **Average engagement time per active user**, **Engaged sessions**, `user_engagement`, `scroll`, and outbound `click` events.
- **Traffic Sources**: Go to **Reports → Acquisition → Traffic acquisition** to see where visitors come from (Organic Search, Direct, Referral, Social, etc.).
- **Locations & Devices**: Go to **Reports → User → User attributes (Demographic details)** and **Tech → Tech details** for country/city and device category breakdowns.

### 9. Limitations Without Additional Custom Tracking

Because this initial setup intentionally avoids custom events and backend pipelines, the following limitations apply:

- **Automatic scroll tracking**: GA4 Enhanced Measurement only records a single `scroll` event when a visitor reaches **90% vertical depth** of a page. Intermediate depth milestones (25%, 50%, 75%) or custom read-completion events require custom event tracking.
- **Internal site search**: The site's built-in search bar filters articles client-side in memory without updating URL query parameters (such as `?q=...`). GA4's automatic **Site search** Enhanced Measurement relies on URL query parameters, so internal searches are not recorded unless URL query sync or a custom `search` event is added later.
- **Category-level popularity & bilingual (EN/VI) article aggregation**: Articles use flat URL slugs (`/<slug>`) without category or locale path segments, so GA4 tracks each English and Vietnamese URL separately. To analyze traffic by Notion `Category`, `Tags`, `Locale`, or aggregate EN + VI views under a shared `Translation Group ID`, you can later send custom GA4 event parameters (for example, `article_category`, `article_locale`, `translation_group_id`) via `sendGAEvent` or page-level config and register them as **Custom Dimensions** in GA4 Admin.

### Privacy & Consent Notice

- This integration uses the official `@next/third-parties/google` loader and does **not** send personally identifiable information (PII), store IP addresses in application code, or add custom tracking cookies/fingerprinting.
- Before deploying to production, publish a **Privacy Policy** informing visitors that Google Analytics 4 is used to measure site traffic and engagement.
- If your audience includes visitors in jurisdictions with strict privacy/cookie consent laws (such as the EEA/UK under GDPR/ePrivacy), implement a consent banner integrated with **Google Consent Mode v2** so analytics storage only activates after visitor consent.

---

## Contact & Feedback

The website provides a lightweight, bilingual (EN / VI) contact and article-feedback workflow at `/contact`, backed by **Formspree** — with no custom database, user accounts, SMTP server, or backend API routes required.

If `NEXT_PUBLIC_FORMSPREE_FORM_ID` is not set, `/contact` renders safely with a friendly configuration notice and does not attempt any submissions.

### 1. Create a Free Formspree Account

1. Visit [formspree.io](https://formspree.io/) and sign up for a free account.
2. Verify your email address when prompted — this is the default inbox where contact messages will be delivered.

### 2. Create a Contact Form in Formspree

1. In your Formspree dashboard, click **+ New Form** (or **New Project → New Form**).
2. Give the form a clear name (for example, `ServiceNow Knowledge Hub Contact`).
3. Confirm the **Target Email** is set to the email address where you want to receive reader questions and article corrections.
4. Keep Formspree's built-in **Spam Filtering** enabled under the form's **Settings** tab (the contact form also includes Formspree's `_gotcha` honeypot field).

### 3. Obtain the Form ID

1. Open your newly created form in Formspree and go to the **Integration** tab.
2. Locate the endpoint URL, which looks like:
   ```text
   https://formspree.io/f/xabcdefg
   ```
3. Copy only the short Form ID at the end (for example, `xabcdefg`).

### 4. Configure `NEXT_PUBLIC_FORMSPREE_FORM_ID` Locally

Add the Form ID to `.env.local` (never commit `.env.local`):

```env
NEXT_PUBLIC_FORMSPREE_FORM_ID=xabcdefg
```

Restart the development server (`pnpm dev`) after updating `.env.local`.

### 5. Configure on Vercel

1. Open your project in the [Vercel Dashboard](https://vercel.com/dashboard).
2. Go to **Settings → Environment Variables**.
3. Add:
   - **Key**: `NEXT_PUBLIC_FORMSPREE_FORM_ID`
   - **Value**: your Formspree Form ID (for example, `xabcdefg`)
   - **Environments**: Production (and Preview/Development if desired)
4. Save and trigger a **Redeploy** so Next.js bundles the `NEXT_PUBLIC_*` variable into the build.

### 6. Verify Email Delivery

1. Open `/contact` on your running site.
2. Fill in **Email**, choose a **Subject**, enter a **Message** (at least 10 characters), and click **Send Message**.
3. Confirm the page displays the success confirmation and that the email arrives in your Formspree inbox (and check your Formspree **Submissions** tab if needed).

### 7. Free-Tier Limitations

- Formspree's free tier includes a monthly submission allowance (commonly 50 submissions/month — check Formspree's current pricing page for up-to-date limits) and standard spam filtering.
- File attachments, custom webhooks, and higher monthly quotas require a paid Formspree plan.

### 8. How Article-Specific Feedback Works

- Every English and Vietnamese article page renders a subtle **Found something incorrect?** (`Phát hiện nội dung chưa chính xác?`) card (`components/ArticleFeedback.tsx`) near the bottom of the article using metadata already fetched for that page (no extra Notion API requests).
- Clicking **Suggest a Correction** (`Đề xuất chỉnh sửa`) navigates to `/contact` with URL query parameters (`subject=article-correction`, `title`, `url`, and `lang=vi` on Vietnamese articles).
- The contact form (`components/ContactForm.tsx`) validates those query parameters, pre-selects **Article Correction**, and pre-fills the **Related Article** title and URL without overwriting anything the visitor has already edited manually.

---

## 🔍 Typecheck, Tests & CLI Scripts

```bash
# TypeScript typechecks
pnpm typecheck          # Next.js app, Knowledge Hub & shared modules (tsconfig.json)
pnpm typecheck:study    # Private Study Room & tests (tsconfig.study.json)
pnpm typecheck:worker   # Local AI Translation Worker (tsconfig.worker.json)

# Study Room unit & integration test suite
pnpm test:study

# Study Room developer CLI helpers
pnpm study:gen-key      # Generate access key + scrypt hash (scripts/study/generate-key.ts)
pnpm study:import       # Import exam HTML into Notion (scripts/study/import-exams.ts)

# Production build check
pnpm build
```

---

## 🛠️ Troubleshooting

| Symptom | Cause & Resolution |
|---|---|
| `Another translation worker instance is already running (PID ...)` | A worker process is already active. Stop the other terminal or, if it crashed hard, the worker will automatically clean up `.translation-worker.lock` once the old PID is no longer alive. |
| Source page switches to `Needs Review` with `[Duplicate Prevented]` | A Vietnamese page (`Locale = vi`) with the same `Translation Group ID` already exists in the database. Inspect the existing page ID listed in `Translation Error`. |
| Source page stays in `Processing` after a PC reboot | The worker automatically detects any job stuck in `Processing` for more than 30 minutes (`TRANSLATION_STALE_TIMEOUT_MS`), checks whether the target page was already created, and safely resumes or finalizes it without creating duplicates. |
| `Missing Notion API token` or `401 Unauthorized` | Verify `NOTION_TOKEN` (for Knowledge Hub / Translation Worker) or `STUDY_NOTION_TOKEN` (for Study Room) in `.env.local` and confirm the Notion integration is connected to the target database with the required capabilities. |
| `Translation Status` is `Needs Review` after completion | Check the `Translation Error` column on the English row — it lists any `synced_block`, `child_page`, `child_database`, unsupported block, or expired media asset that needs a quick manual check before publishing. |

---

## 📜 Build & Production

```bash
# Build production bundle
pnpm build

# Start production server
pnpm start
```
