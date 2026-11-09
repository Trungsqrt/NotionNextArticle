# ServiceNow Knowledge Hub — Wabi-Sabi & Matcha Theme

> A serene, Japanese-inspired learning platform built on **Next.js (App Router)** and the **official Notion API**, styled with a calming **Matcha & Wabi-Sabi** aesthetic, featuring bilingual (EN/VI) support and a local AI translation worker.

---

## 🌿 Overview

**ServiceNow Knowledge Hub** is a documentation and learning portal designed for IT professionals and developers. Content is managed directly inside Notion and rendered seamlessly with rich typography, code highlighting, interactive diagrams, and smooth micro-interactions.

### Key Highlights
- ⚡ **Next.js App Router**: Built with Server Components (RSC), dynamic metadata generation, and Incremental Static Regeneration (ISR).
- 🍵 **Wabi-Sabi Design System**: Earthy, organic palette (`matcha`, `rice-paper`, `tea-slate`, `ink`, `sage`) with smooth dark mode.
- 📖 **Official Notion Engine**: Powered by `@notionhq/client` and a robust custom parser supporting 25+ block types, callouts, columns, databases, mermaid diagrams, and math equations.
- 🌐 **Bilingual Articles (EN / VI)**: Native locale-aware routing, `LanguageSwitcher` component, `hreflang` SEO metadata, and internal link localization.
- 🤖 **Local AI Translation Worker**: One-click Notion Database Button workflow that translates English Notion articles into structured Vietnamese Notion pages locally on Windows without requiring n8n, Make, Inngest, or paid Notion webhooks.
- 🚀 **Smart Caching**: In-memory caching with a 50-minute TTL to gracefully handle Notion's expiring AWS S3 asset URLs.
- 🛠️ **Interactive UI**: Custom dropdown filtering (Category & Tag), sticky scroll-spy Table of Contents, interactive code blocks with copy/expand, and async toggle blocks.

---

## 📂 Project Structure

```text
NotionNextArticle/
├── app/
│   ├── [...slug]/
│   │   └── page.js                 ← Dynamic article route (RSC + generateStaticParams + metadata)
│   ├── api/
│   │   └── notion/
│   │       └── children/
│   │           └── route.js        ← Dynamic API route to lazy-fetch toggle/child blocks
│   ├── layout.js                   ← Root layout, Google Fonts (Plus Jakarta Sans, Noto Serif JP, Fira Code)
│   ├── not-found.js                ← Zen "無 Mu" 404 page
│   ├── page.js                     ← Homepage with dynamic course filtering & category grid
│   └── sitemap.js                  ← Locale-aware dynamic sitemap
├── components/
│   ├── ArticleCover.js             ← Hero banner with fallback gradient, icon, and title
│   ├── CourseCard.js               ← Bento lesson card with difficulty rating, tags, and progress
│   ├── CourseFilter.js             ← Custom interactive dropdown filter & search bar
│   ├── Header.js                   ← Frosted glass navbar, search modal, and dark mode toggle
│   ├── ImageSlider.js              ← Interactive image carousel for [slider] toggle blocks
│   ├── LanguageSwitcher.js         ← Wabi-Sabi EN / VI article language control
│   ├── Layout.js                   ← Master layout wrapper, reading progress, and copy attribution
│   ├── NotionCodeBlock.js          ← Enhanced code block (syntax highlight, line numbers, copy, expand)
│   ├── NotionContent.js            ← Client component injecting React enhancements into parsed HTML
│   ├── NotionToggleBlock.js        ← Accordion toggle with lazy-load child block capability
│   ├── ReadingProgress.js          ← Top reading progress indicator + scroll-to-top button
│   ├── SiblingNavigation.js        ← Locale-aware Previous / Next lesson navigation
│   ├── Sidebar.js                  ← Course modules and lesson navigation sidebar
│   ├── TableOfContents.js          ← Sticky scroll-spy Table of Contents with active heading tracking
│   └── ZenStillLife.js             ← Atmospheric Zen illustration component
├── lib/
│   ├── locales.js                  ← Supported article locales (en, vi) & normalization helpers
│   ├── notion.js                   ← Website Notion API client, custom block-to-HTML parser, and caching
│   └── notion-translation/         ← Independent TypeScript AI translation engine for Notion pages
│       ├── block-classifier.ts     ← Classifies translatable vs non-translatable blocks, sliders & Mermaid
│       ├── builder.ts              ← Reconstructs Notion blocks, Mermaid labels, references, and VI slugs
│       ├── checkpoint-store.ts     ← Durable local JSON checkpoints & persistent resource mapping store
│       ├── config.ts               ← Environment config, timeouts/limits, and ServiceNow glossary
│       ├── discovery.ts            ← Recursive content hierarchy discovery (pages, child_page, child_database)
│       ├── extractor.ts            ← Extracts translatable rich_text runs & safe Mermaid display labels
│       ├── notion-client.ts        ← Notion SDK wrapper, schema caching, safe pagination, file uploads
│       ├── planner.ts              ← Hierarchical translation planner, group IDs, and reference resolution
│       ├── reader.ts               ← Independent recursive raw Notion block tree reader
│       ├── translator.ts           ← Multi-provider AI adapter, batching, and JSON schema validation
│       ├── types.ts                ← Shared TypeScript interfaces and discriminated unions
│       ├── validator.ts            ← Post-translation structural validator and report generator
│       ├── workflow.ts             ← Hierarchical orchestration, checkpoint resume, duplicate protection
│       └── writer.ts               ← Batched recursive Notion page, child_page & block writer
├── worker/
│   ├── index.ts                    ← CLI entry point (--once, --dry-run, --page / --page-id)
│   ├── logger.ts                   ← Structured Pino logger with automatic secret redaction
│   └── poller.ts                   ← Single-loop async poller, single-instance lock, graceful shutdown
├── styles/
│   ├── globals.css                 ← Tailwind CSS directives, typography utilities, and resets
│   └── wabi-sabi-theme.css         ← Wabi-sabi design tokens and rich Notion block overrides
├── .env.local.example              ← Environment variable template
├── next.config.js                  ← Image remotePatterns and bundler configuration
├── package.json
├── tsconfig.worker.json            ← TypeScript configuration scoped to the translation worker
└── tailwind.config.js              ← Custom color palette & design tokens
```

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

Edit `.env.local` with your Notion and AI credentials (never commit `.env.local`):
```env
# Root Notion database or page ID (32-character hex ID from your Notion URL)
NOTION_ROOT_PAGE_ID=your_notion_database_or_page_id

# Explicit Articles database ID for the local translation worker
# (Falls back to NOTION_ROOT_PAGE_ID if omitted)
NOTION_TRANSLATION_DATABASE_ID=your_articles_database_id_here

# Notion Integration Secret Token (from https://www.notion.so/my-integrations)
NOTION_TOKEN=secret_your_notion_integration_token

# Site metadata
NEXT_PUBLIC_SITE_NAME="ServiceNow Knowledge Hub"
NEXT_PUBLIC_SITE_DESCRIPTION="A serene learning space for mastering ServiceNow."
NEXT_PUBLIC_SITE_URL=http://localhost:3000

# AI translation configuration
# Supported AI_PROVIDER values: openai | openai-compatible | gemini | anthropic | openrouter | deepseek
AI_PROVIDER=openai
AI_API_KEY=your_ai_api_key_here
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4o-mini

# Local translation worker settings
TRANSLATION_POLL_INTERVAL_MS=60000
TRANSLATION_TARGET_LOCALE=vi
TRANSLATION_BATCH_SIZE=20
TRANSLATION_MAX_BATCH_CHARS=6000
TRANSLATION_CONCURRENCY=1
TRANSLATION_STALE_TIMEOUT_MS=1800000

# Request timeouts, media size limit, and pagination safety limits
TRANSLATION_AI_TIMEOUT_MS=120000
TRANSLATION_NOTION_TIMEOUT_MS=30000
TRANSLATION_ASSET_TIMEOUT_MS=60000
TRANSLATION_MAX_ASSET_BYTES=20971520
TRANSLATION_MAX_PAGINATION_PAGES=500
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

The worker automatically checks for and creates these properties on the database if they do not already exist:

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

The translation engine uses a provider adapter (`lib/notion-translation/translator.ts`) that supports multiple AI providers via `.env.local`:

- **Groq (Recommended for Free/Low-Cost Development Testing)**:
  ```env
  AI_PROVIDER=groq
  GROQ_API_KEY=gsk_...
  AI_BASE_URL=https://api.groq.com/openai/v1
  AI_MODEL=qwen/qwen3-32b
  ```
- **OpenRouter (Flexible Multi-Model Routing)**:
  ```env
  AI_PROVIDER=openrouter
  OPENROUTER_API_KEY=sk-or-...
  AI_BASE_URL=https://openrouter.ai/api/v1
  AI_MODEL=qwen/qwen3-32b
  ```
- **OpenAI**:
  ```env
  AI_PROVIDER=openai
  AI_API_KEY=sk-...
  AI_BASE_URL=https://api.openai.com/v1
  AI_MODEL=gpt-4o-mini
  ```
- **Google Gemini**:
  ```env
  AI_PROVIDER=gemini
  AI_API_KEY=AIza...
  AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta
  AI_MODEL=gemini-2.5-flash
  ```
- **Anthropic Claude**:
  ```env
  AI_PROVIDER=anthropic
  AI_API_KEY=sk-ant-...
  AI_BASE_URL=https://api.anthropic.com/v1
  AI_MODEL=claude-3-5-sonnet-latest
  ```

### 3b. ServiceNow Terminology Protection & Token Optimization

- **Deterministic Terminology Protection (`lib/notion-translation/terminology.ts`)**:
  - Official ServiceNow terms (`Catalog Item`, `Record Producer`, `Business Rule`, `Script Include`, `Flow Designer`, `Service Catalog`, `CMDB`, `CSDM`, `IRE`, `RITM`, `SCTASK`, `GlideRecord`, etc.), table/field identifiers (`sc_req_item`, `short_description`, `sys_id`), 32-char hex `sys_id`s, ticket numbers, API calls (`gs.*`, `g_form.*`), URLs, and custom object names are automatically protected with compact placeholders (`__SN0__`, `__SN1__`, ...) before sending text to the AI and restored verbatim after translation.
  - Customize protected terms without changing code by editing `lib/notion-translation/servicenow-glossary.json` (or setting `TRANSLATION_GLOSSARY_PATH` / `TRANSLATION_CUSTOM_TERMS` in `.env.local`).
- **Compact Batching & Persistent Segment Cache**:
  - Batches are sent as compact flat JSON maps (`{"a":"...","b":"..."}`) with short keys and a concise ServiceNow-specific system prompt.
  - Translated segments are cached in `.translation-worker-state/segment-cache.json` by SHA-256 fingerprint, so re-runs or incremental edits to an article reuse unchanged segments with zero AI token cost.
- **Rate-Limit Pacing & Daily Quota Pause/Resume**:
  - Configurable `TRANSLATION_RPM_LIMIT`, `TRANSLATION_TPM_LIMIT`, `TRANSLATION_RPD_LIMIT`, and `TRANSLATION_TPD_LIMIT`.
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
| `code` | **Never translates programming code**; preserves code text and language verbatim, translates `caption`, and safely translates human-readable display labels in `mermaid` diagrams | ✅ Full |
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

## 🔍 Typecheck & Verification

Verify TypeScript types for the translation worker:

```bash
pnpm run typecheck:worker
```

Run a production build check:

```bash
pnpm build
```

---

## 🛠️ Troubleshooting

| Symptom | Cause & Resolution |
|---|---|
| `Another translation worker instance is already running (PID ...)` | A worker process is already active. Stop the other terminal or, if it crashed hard, the worker will automatically clean up `.translation-worker.lock` once the old PID is no longer alive. |
| Source page switches to `Needs Review` with `[Duplicate Prevented]` | A Vietnamese page (`Locale = vi`) with the same `Translation Group ID` already exists in the database. Inspect the existing page ID listed in `Translation Error`. |
| Source page stays in `Processing` after a PC reboot | The worker automatically detects any job stuck in `Processing` for more than 30 minutes (`TRANSLATION_STALE_TIMEOUT_MS`), checks whether the target page was already created, and safely resumes or finalizes it without creating duplicates. |
| `Missing Notion API token` or `401 Unauthorized` | Verify `NOTION_TOKEN` in `.env.local` and confirm your Notion integration is connected to the Articles database with Read, Update, and Insert capabilities. |
| `Translation Status` is `Needs Review` after completion | Check the `Translation Error` column on the English row — it lists any `synced_block`, `child_page`, `child_database`, unsupported block, or expired media asset that needs a quick manual check before publishing. |

---

## 📜 Build & Production

```bash
# Build production bundle
pnpm build

# Start production server
pnpm start
```
