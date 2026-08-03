# Wabi-Sabi & Matcha Design System — Walkthrough

**Status:** ✅ Complete · Dev server running at `http://localhost:3000`

---

## What Was Built

### Task 1 — CSS Override System (`styles/wabi-sabi-theme.css`)

A 36 KB, 18-section stylesheet that fully transforms `react-notion-x` blocks without touching any JS data logic.

| § | Section | What it does |
|---|---|---|
| 1 | Design Tokens | 40+ CSS custom properties for light/dark — bg, text, matcha, borders |
| 2 | Page Wrapper | Rice-paper bg, max-width `72ch`, staggered fade-in animation |
| 3 | Typography | Noto Serif JP headings, Plus Jakarta Sans body, `1.85` line-height, matcha `::before` bar on H1 |
| 4 | Lists | Matcha-colored `::marker`, to-do checkbox `accent-color` |
| 5 | Toggle Blocks | Zen accordion — earthy border, animated `›` chevron, smooth open |
| 6 | Callout Blocks | Japanese note card — `4px` matcha left border, zero box-shadow |
| 7 | Code Blocks | Serene terminal — `#181916` bg, `●●●` dot header, pastel matcha Prism tokens |
| 8 | Quote Blocks | Serif italic, `"` ink-wash `::before`, soft left border |
| 9 | Dividers | Gradient fade `linear-gradient` rule, organic feel |
| 10 | Color Backgrounds | All 9 Notion colors → muted organic washes (e.g. yellow → `rgba(122,139,105,0.10)`) |
| 11 | Gallery / Cards | Bento grid, `hover:-translate-y-2` lift, matcha border on hover, cover zoom |
| 12 | Tables / Databases | Borderless cells, `UPPER` column headers in stone, row hover tint |
| 13 | Breadcrumbs | Minimal, muted, matcha on hover |
| 14 | Page Cover & Icon | Rounded cover, desaturated filter, oversized emoji icon |
| 15 | Collection Header | Serif title, matcha-underline active tab |
| 16 | Loading Skeleton | Shimmer animation in rice-paper tones |
| 17 | Paper Texture | Radial gradient overlay — subtle organic warmth |
| 18 | Responsive | Mobile breakpoints for `768px` and `480px` |

---

### Task 2 — Layout Components

#### [Header.js](file:///d:/Dev/Workspace/NotionNextArticle/components/Header.js)
- `backdrop-blur-md` frosted glass, `h-14`, scroll shadow
- Matcha leaf SVG brand mark + `SN Academy` serif wordmark
- Desktop nav with active matcha chip highlight
- Expanding search bar (click to open, Escape to close)
- 🌙/☀ dark mode toggle — persists to `localStorage`, no flash (via `_document.js` inline script)
- Mobile hamburger → full-screen drawer with nav + search

#### [Sidebar.js](file:///d:/Dev/Workspace/NotionNextArticle/components/Sidebar.js)
- Sticky `w-64`, `h-[calc(100vh-3.5rem)]`, scrollable interior
- **Module tree** — collapsible groups with `max-height` CSS animation
- **Active lesson** — `4px` matcha left bar + soft green tint background
- **Scroll-spy TOC** — `IntersectionObserver` highlights current heading while reading
- **Progress bar** — thin matcha gradient, `role="progressbar"` for a11y
- Mobile: slides in as drawer, backdrop tap-to-close
- Props: `tableOfContents`, `modules`, `currentSlug`, `completedLessons`, `totalLessons`

#### [CourseCard.js](file:///d:/Dev/Workspace/NotionNextArticle/components/CourseCard.js)
- `hover:-translate-y-[3px]` lift + matcha border transition
- **Cover fallback** — organic matcha gradient blob SVG when no image
- Matcha tag chips (`rounded-pill`, muted green)
- **Difficulty dots** — 1/2/3 filled dots (Beginner/Intermediate/Advanced)
- **Completed ribbon** — matcha badge top-right with checkmark
- Two-line clamped title in Noto Serif JP
- `Read →` CTA with arrow micro-animation
- Accepts all standard NotionNext page props + gracefully ignores extras

#### [Layout.js](file:///d:/Dev/Workspace/NotionNextArticle/components/Layout.js)
- Composes Header + Sidebar + `<main>` + Footer
- Full SEO `<Head>` — title, description, OG tags, theme-color meta
- Mobile sidebar fab button (bottom-left, matcha pill)
- Wabi-Sabi footer with `✦ Built with calm intention`

---

## File Structure

```
NotionNextArticle/
├── components/
│   ├── CourseCard.js     (10 KB)
│   ├── Header.js         (12 KB)
│   ├── Layout.js          (6 KB)
│   └── Sidebar.js        (14 KB)
├── pages/
│   ├── _app.js           ← CSS import order (notion → wabi-sabi)
│   ├── _document.js      ← dark mode FOUC prevention
│   ├── 404.js            ← Zen "無 Mu" not-found page
│   ├── index.js          ← Home with 6 CourseCards + filter bar
│   └── [slug].js         ← NotionRenderer wrapper (all props preserved)
├── styles/
│   ├── globals.css        (3 KB) ← Tailwind + Google Fonts + resets
│   └── wabi-sabi-theme.css (36 KB) ← ★ Main CSS override
├── tailwind.config.js    ← matcha-*, rice-paper-*, ink-*, sage-* palettes
├── next.config.js        ← remotePatterns for Notion images
├── .env.local.example    ← Notion token template
└── README.md             ← Props reference + connection guide
```

---

## How to Connect Your Notion Database

### 1. Copy and fill environment variables
```bash
cp .env.local.example .env.local
```
Edit `.env.local`:
```
NOTION_ROOT_PAGE_ID=your_32char_page_id
NOTION_TOKEN=secret_your_token
```

### 2. Wire the home page (`pages/index.js`)
Replace `MOCK_COURSES` in `getStaticProps`:
```js
const { getAllPosts } = require('../lib/notion')
const posts = await getAllPosts({ filter: 'Published' })
return {
  props: {
    courses: posts.map(p => ({
      slug: p.slug, title: p.title, tags: p.tags,
      cover: p.pageCoverThumbnail, icon: p.pageIcon,
      summary: p.summary, difficulty: p.difficulty,
      duration: p.duration, date: p.date,
    }))
  },
  revalidate: 60,
}
```

### 3. Wire the lesson page (`pages/[slug].js`)
Replace the stub in `getStaticProps`:
```js
const { getPageBySlug, getPageTableOfContents } = require('../lib/notion')
const page = await getPageBySlug(slug)
if (!page) return { notFound: true }
return {
  props: {
    recordMap: page.recordMap,   // ← passed directly to <NotionRenderer />
    pageId: page.id,
    title: page.title,
    tableOfContents: getPageTableOfContents(page.recordMap),
    modules: yourCourseModules,
    currentSlug: slug,
  },
  revalidate: 60,
}
```

---

## Dark Mode Architecture

```
_document.js  →  inline <script> reads localStorage 'ws-theme'
                 sets class="dark" on <html> before first paint (no flash)
                      ↓
Header.js     →  toggle button writes localStorage + toggles .dark class
                      ↓
wabi-sabi-theme.css  →  .dark { --ws-bg-primary: #1A1B18; ... }
tailwind.config.js   →  darkMode: 'class'  (all dark: variants)
```

---

## Verification Results

| Check | Result |
|---|---|
| `npm install` | ✅ 554 packages |
| Next.js version | ✅ 16.2.12 (auto-upgraded from 14.2.5) |
| `npm run dev` | ✅ Ready in 409ms (Turbopack) |
| Compilation errors | ✅ None |
| `images.domains` deprecation | ✅ Fixed → `remotePatterns` |
| Dark mode FOUC | ✅ Prevented via inline script in `_document.js` |
| NotionRenderer props | ✅ Untouched — all data bindings preserved |
