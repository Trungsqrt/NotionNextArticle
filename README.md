# ServiceNow Knowledge Hub — Wabi-Sabi & Matcha Theme

> A serene, Japanese-inspired learning platform built on **Next.js (App Router)** and the **official Notion API**, styled with a calming **Matcha & Wabi-Sabi** aesthetic.

---

## 🌿 Overview

**ServiceNow Knowledge Hub** is a documentation and learning portal designed for IT professionals and developers. Content is managed directly inside Notion and rendered seamlessly with rich typography, code highlighting, interactive diagrams, and smooth micro-interactions.

### Key Highlights
- ⚡ **Next.js App Router**: Built with Server Components (RSC), dynamic metadata generation, and Incremental Static Regeneration (ISR).
- 🍵 **Wabi-Sabi Design System**: Earthy, organic palette (`matcha`, `rice-paper`, `tea-slate`, `ink`, `sage`) with smooth dark mode.
- 📖 **Official Notion Engine**: Powered by `@notionhq/client` and a robust custom parser supporting 25+ block types, callouts, columns, databases, mermaid diagrams, and math equations.
- 🚀 **Smart Caching**: In-memory caching with a 50-minute TTL to gracefully handle Notion's expiring AWS S3 asset URLs.
- 🛠️ **Interactive UI**: Custom dropdown filtering (Category & Tag), sticky scroll-spy Table of Contents, interactive code blocks with copy/expand, and async toggle blocks.

---

## 📂 Project Structure

```
NotionNextArticle/
├── app/
│   ├── [...slug]/
│   │   └── page.js           ← Dynamic article route (RSC + generateStaticParams + metadata)
│   ├── api/
│   │   └── notion/
│   │       └── children/
│   │           └── route.js  ← Dynamic API route to lazy-fetch toggle/child blocks
│   ├── layout.js             ← Root layout, Google Fonts (Plus Jakarta Sans, Noto Serif JP, Fira Code)
│   ├── not-found.js          ← Zen "無 Mu" 404 page
│   └── page.js               ← Homepage with dynamic course filtering & category grid
├── components/
│   ├── ArticleCover.js       ← Hero banner with fallback gradient, icon, and title
│   ├── CourseCard.js         ← Bento lesson card with difficulty rating, tags, and progress
│   ├── CourseFilter.js       ← Custom interactive dropdown filter & search bar
│   ├── Header.js             ← Frosted glass navbar, search modal, and dark mode toggle
│   ├── Layout.js             ← Master layout wrapper, reading progress, and copy attribution
│   ├── NotionCodeBlock.js    ← Enhanced code block (syntax highlight, line numbers, copy, expand)
│   ├── NotionContent.js      ← Client component injecting React enhancements into parsed HTML
│   ├── NotionToggleBlock.js  ← Accordion toggle with lazy-load child block capability
│   ├── ReadingProgress.js    ← Top reading progress indicator + scroll-to-top button
│   ├── Sidebar.js            ← Course modules and lesson navigation sidebar
│   ├── TableOfContents.js    ← Sticky scroll-spy Table of Contents with active heading tracking
│   └── ZenStillLife.js       ← Atmospheric Zen illustration component
├── lib/
│   └── notion.js             ← Complete Notion API client, custom block-to-HTML parser, and caching
├── styles/
│   ├── globals.css           ← Tailwind CSS directives, typography utilities, and resets
│   └── wabi-sabi-theme.css   ← Wabi-sabi design tokens and rich Notion block overrides
├── .env.local.example        ← Environment variable template
├── next.config.js            ← Image remotePatterns and bundler configuration
├── package.json
└── tailwind.config.js        ← Custom color palette & design tokens
```

---

## 🚀 Quick Start

### 1. Clone & Install Dependencies

```bash
# Using npm
npm install

# Or using pnpm
pnpm install
```

### 2. Configure Environment Variables

Copy the template file:
```bash
cp .env.local.example .env.local
```

Edit `.env.local` with your Notion credentials:
```env
# Root Notion database or page ID (32-character hex ID from your Notion URL)
NOTION_ROOT_PAGE_ID=your_notion_database_or_page_id

# Notion Integration Secret Token (from https://www.notion.so/my-integrations)
NOTION_TOKEN=secret_your_notion_integration_token

# Optional: Site metadata
NEXT_PUBLIC_SITE_NAME="ServiceNow Knowledge Hub"
NEXT_PUBLIC_SITE_DESCRIPTION="A serene learning space for mastering ServiceNow."
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

### 3. Run Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## ⚙️ Notion Database Schema

To make full use of the Course Cards and filtering system, your Notion Database should contain the following properties:

| Property | Notion Type | Description |
|---|---|---|
| `Name` / `Title` | `title` | Article / Lesson title |
| `Slug` | `rich_text` | Custom URL slug (falls back to auto-slugified title or Page ID) |
| `Status` | `status` / `select` | `Published` (only published articles are shown), `Draft`, `Archived` |
| `Category` | `select` | High-level topic (e.g., `ITSM`, `Discovery`, `Scripting`, `Architect`) |
| `Tags` | `multi_select` | Keyword tags for secondary filtering |
| `Summary` | `rich_text` | Short description displayed on cards and article headers |
| `Difficulty` | `select` | `Beginner`, `Intermediate`, `Advanced` (renders 1–3 dots) |
| `Duration` | `rich_text` / `number` | Estimated read/completion time (e.g. `20 min`) |
| `Parent Course` | `relation` / `select` | Optional parent course title to group sub-lessons |

---

## 🎨 Theme & Styling

### Color Palette (CSS Variables)

All color tokens are declared in `styles/wabi-sabi-theme.css`:

| Token | Light Theme | Dark Theme | Purpose |
|---|---|---|---|
| `--ws-bg-primary` | `#FAF8F5` | `#1A1B18` | Primary page background |
| `--ws-bg-secondary` | `#F3EFE8` | `#232420` | Cards, sidebars, and elevated surfaces |
| `--ws-matcha-primary`| `#7A8B69` | `#6A7B5A` | Brand accent & interactive elements |
| `--ws-matcha-light`  | `#A8B898` | `#8C9C7B` | Sub-accents and badges |
| `--ws-text-primary`  | `#2C2A29` | `#D8DAD3` | Main body text |
| `--ws-text-muted`    | `#7A7870` | `#8A8C84` | Captions, dates, and secondary text |
| `--ws-border-soft`   | `#EAE6DF` | `#292A27` | Subtle dividers and card borders |

### Dark Mode Behavior
- Toggled via header control and stored in `localStorage` under `ws-theme`.
- Respects system preferences on first load.
- Seamlessly styled across all custom components and rendered Notion blocks.

---

## 📜 Build & Production

```bash
# Build production bundle
npm run build

# Start production server
npm run start
```
