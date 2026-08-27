# ServiceNow Knowledge Hub — Architecture & Implementation Walkthrough

**Status:** ✅ Complete & Production Ready · Built on **Next.js App Router** with **Official Notion API**

---

## 🍵 Executive Summary

The **ServiceNow Knowledge Hub** has been engineered from the ground up as a high-performance, serene knowledge base combining the **Wabi-Sabi & Matcha** aesthetic with enterprise-grade Notion content rendering.

Content is authored and organized directly in Notion (as Databases or hierarchical Pages) and fetched dynamically with Server-Side Generation (SSG), Incremental Static Regeneration (ISR), and custom client-side micro-interactions.

---

## 🏛️ System Architecture

```
                                  ┌───────────────────────────┐
                                  │   Official Notion API     │
                                  │  (@notionhq/client)       │
                                  └─────────────┬─────────────┘
                                                │
                                                ▼
                                  ┌───────────────────────────┐
                                  │      lib/notion.js        │
                                  │  • 50-min In-Memory Cache │
                                  │  • 25+ Block Parsers      │
                                  │  • Database Query & Search│
                                  └─────────────┬─────────────┘
                                                │
                 ┌──────────────────────────────┴──────────────────────────────┐
                 ▼                                                             ▼
  ┌─────────────────────────────┐                               ┌─────────────────────────────┐
  │      app/page.js            │                               │    app/[...slug]/page.js    │
  │  (Homepage Server Component)│                               │ (Article Server Component)  │
  └──────────────┬──────────────┘                               └──────────────┬──────────────┘
                 │                                                             │
                 ▼                                                             ▼
  ┌─────────────────────────────┐                               ┌─────────────────────────────┐
  │ components/CourseFilter.js  │                               │ components/NotionContent.js │
  │ • Category & Tag Dropdowns  │                               │ • NotionCodeBlock           │
  │ • Search Filter & Bento Grid│                               │ • NotionToggleBlock (Async) │
  │ • CourseCard.js             │                               │ • TableOfContents.js (TOC)  │
  └─────────────────────────────┘                               └─────────────────────────────┘
```

---

## 📦 Detailed Component Breakdown

### 1. Core Server Pages & Routing

#### [app/layout.js](file:///d:/Dev/Workspace/NotionNextArticle/app/layout.js)
- Global `RootLayout` configuring Google Fonts via `next/font/google`:
  - **Noto Serif JP** (`--font-serif`) for headers and Japanese aesthetic accents.
  - **Plus Jakarta Sans** (`--font-sans`) for crisp UI and body typography.
  - **Fira Code** (`--font-mono`) for terminal and code blocks.
- Wraps application inside `<Layout>` with theme persistence and hydration-mismatch protection (`suppressHydrationWarning`).

#### [app/page.js](file:///d:/Dev/Workspace/NotionNextArticle/app/page.js)
- Server Component fetching all published articles via `getAllPosts()` with ISR (`revalidate = 3600`).
- Dynamically extracts unique categories and tags for real-time client filtering.
- Renders the Zen Hero section and hydrates [`<CourseFilter />`](file:///d:/Dev/Workspace/NotionNextArticle/components/CourseFilter.js).

#### [app/[...slug]/page.js](file:///d:/Dev/Workspace/NotionNextArticle/app/[...slug]/page.js)
- Dynamic Catch-All Route supporting clean slugs (`/introduction-to-servicenow`) or raw Notion IDs.
- Implements `generateStaticParams()` for pre-rendering top pages and `generateMetadata()` for dynamic SEO tags.
- Renders [`<ArticleCover />`](file:///d:/Dev/Workspace/NotionNextArticle/components/ArticleCover.js), sanitized HTML via [`<NotionContent />`](file:///d:/Dev/Workspace/NotionNextArticle/components/NotionContent.js), and sticky [`<TableOfContents />`](file:///d:/Dev/Workspace/NotionNextArticle/components/TableOfContents.js).

#### [app/api/notion/children/route.js](file:///d:/Dev/Workspace/NotionNextArticle/app/api/notion/children/route.js)
- Dedicated API endpoint allowing toggle lists and nested pages to fetch child blocks lazily on demand.

---

### 2. Notion Integration & Parser Engine

#### [lib/notion.js](file:///d:/Dev/Workspace/NotionNextArticle/lib/notion.js)
- **Multi-Level Discovery**: Automatically queries Notion databases, lists child blocks from root pages, or runs workspace searches to find matching articles.
- **Smart Memory Caching**: 50-minute cache TTL (`CACHE_TTL = 50 * 60 * 1000`) prevents expired AWS S3 signed image/file URLs without sacrificing fresh data.
- **Full Block Type Support**:
  - Headings (H1, H2, H3) with automatic anchor ID generation.
  - Callouts with custom icon rendering and muted matcha/stone borders.
  - Synced blocks, Column lists & Column layouts.
  - Numbered and bulleted lists, To-do task lists with custom checkbox styling.
  - Code blocks with language detection and syntax highlighting tokens.
  - Equations (LaTeX math), Bookmarks, Video/Audio embeds, and PDF viewers.
  - Mermaid diagram generation.
  - Native Notion Database table views with clickable rows and colored badge pills.

---

### 3. Interactive UI Components

#### [components/Header.js](file:///d:/Dev/Workspace/NotionNextArticle/components/Header.js)
- Frosted glass navbar with scroll-based shadow elevation.
- Instant search bar with modal keyboard shortcut navigation (`Escape` to close).
- Dark/Light mode switcher with persistence in `localStorage` under key `ws-theme`.
- Responsive mobile menu drawer.

#### [components/CourseFilter.js](file:///d:/Dev/Workspace/NotionNextArticle/components/CourseFilter.js) & [components/CourseCard.js](file:///d:/Dev/Workspace/NotionNextArticle/components/CourseCard.js)
- Fully custom interactive dropdowns with outside-click detection and active indicator badges.
- Bento grid layout with subtle lift micro-animation (`hover:-translate-y-1`).
- Difficulty rating dots (1 for Beginner, 2 for Intermediate, 3 for Advanced).
- Fallback SVG gradient covers for articles without cover images.

#### [components/NotionContent.js](file:///d:/Dev/Workspace/NotionNextArticle/components/NotionContent.js) & [components/NotionCodeBlock.js](file:///d:/Dev/Workspace/NotionNextArticle/components/NotionCodeBlock.js)
- Ingests server-rendered Notion HTML via `html-react-parser` and seamlessly replaces raw `<pre><code>` and `<details>` tags with full-featured React components.
- Code blocks support:
  - Copy to clipboard with tooltip confirmation.
  - Line numbers and language badges.
  - Expand/collapse for snippets exceeding 20 lines.

#### [components/TableOfContents.js](file:///d:/Dev/Workspace/NotionNextArticle/components/TableOfContents.js)
- Sticky side navigation tracking heading visibility via `IntersectionObserver`.
- Smooth auto-scroll on click with offset for the fixed navbar.

#### [components/Layout.js](file:///d:/Dev/Workspace/NotionNextArticle/components/Layout.js) & [components/ReadingProgress.js](file:///d:/Dev/Workspace/NotionNextArticle/components/ReadingProgress.js)
- Dynamic scroll progress bar anchored to the top of the viewport.
- Floating back-to-top button with smooth return.
- Automatic copy attribution for text selections (`— Trungsqrt · ServiceNow Knowledge Hub`), preserving clean copy for code blocks.

---

## 🎨 Design System & Theme Specs

### Design Tokens (`styles/wabi-sabi-theme.css`)

```css
:root {
  --ws-bg-primary: #FAF8F5;       /* Warm rice paper */
  --ws-bg-secondary: #F3EFE8;     /* Muted sand */
  --ws-matcha-primary: #7A8B69;   /* Ground matcha green */
  --ws-matcha-light: #A8B898;     /* Fresh tea leaf */
  --ws-text-primary: #2C2A29;     /* Deep sumi ink */
  --ws-text-muted: #7A7870;       /* Stone grey */
  --ws-border-soft: #EAE6DF;      /* Organic border */
}

.dark {
  --ws-bg-primary: #1A1B18;       /* Deep charcoal slate */
  --ws-bg-secondary: #232420;     /* Dark moss stone */
  --ws-matcha-primary: #6A7B5A;   /* Muted matcha */
  --ws-text-primary: #D8DAD3;     /* Soft ash */
  --ws-border-soft: #292A27;      /* Subtle dark line */
}
```

---

## 🧪 Verification Matrix

| Area | Feature | Status | Verification Note |
|---|---|---|---|
| **Routing** | App Router (`app/`) | ✅ Verified | Server components and dynamic `[...slug]` routing operational |
| **Data Fetching** | Notion Official API | ✅ Verified | Database queries, page extraction, and fallbacks in `lib/notion.js` |
| **Caching** | 50-min S3 Protection | ✅ Verified | Prevents expired image links from AWS S3 |
| **Search & Filter** | CourseFilter Component | ✅ Verified | Real-time Category/Tag filters and text search |
| **Rich Blocks** | Code / Toggle / TOC | ✅ Verified | Syntax highlight, copy button, dynamic child toggle loading |
| **Responsiveness** | Mobile / Tablet / Desktop | ✅ Verified | Flexible bento grid, mobile drawer, floating table of contents |
| **Dark Mode** | Class-based CSS Tokens | ✅ Verified | Fast toggle, no hydration flash, stored in `localStorage` |
