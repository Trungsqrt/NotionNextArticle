# ServiceNow Knowledge Hub — Wabi-Sabi Theme

> A serene, Japanese-inspired learning platform built on **Next.js** + **react-notion-x**, styled with a **Matcha & Wabi-Sabi** aesthetic.

---

## Project Structure

```
NotionNextArticle/
├── components/
│   ├── CourseCard.js      ← Minimalist bento lesson card
│   ├── Header.js          ← Frosted glass navbar with dark mode
│   ├── Layout.js          ← Master layout wrapper
│   └── Sidebar.js         ← Sticky TOC + module tree sidebar
├── pages/
│   ├── _app.js            ← Global CSS imports (order matters!)
│   ├── _document.js       ← Dark mode FOUC prevention
│   ├── 404.js             ← Wabi-Sabi "not found" page
│   ├── index.js           ← Home page — CourseCard grid
│   └── [slug].js          ← Lesson page — NotionRenderer wrapper
├── styles/
│   ├── globals.css        ← Tailwind directives + base resets
│   └── wabi-sabi-theme.css  ← ★ Main CSS override for react-notion-x
├── .env.local.example     ← Environment variable template
├── next.config.js
├── postcss.config.js
└── tailwind.config.js
```

---

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Configure Notion
```bash
cp .env.local.example .env.local
# Edit .env.local and fill in your NOTION_ROOT_PAGE_ID
```

### 3. Run dev server
```bash
npm run dev
# → http://localhost:3000
```

---

## Connecting to Notion

The pages have clearly marked `TODO` comments showing exactly where to wire in your Notion data:

**`pages/index.js`** — replace `MOCK_COURSES` with:
```js
const { getAllPosts } = require('../lib/notion')
const posts = await getAllPosts({ filter: 'Published' })
```

**`pages/[slug].js`** — replace the stub `getStaticProps` with:
```js
const { getPageBySlug } = require('../lib/notion')
const page = await getPageBySlug(slug)
return { props: { recordMap: page.recordMap, ... } }
```

---

## Theme Architecture

### CSS Override Order (in `_app.js`)
```
1. react-notion-x/build/third-party/collection.css  ← notion defaults first
2. react-notion-x/build/third-party/equation.css
3. styles/globals.css → @import './wabi-sabi-theme.css'  ← our overrides last
```

### Dark Mode
- Toggled via `document.documentElement.classList.toggle('dark')`
- Persisted in `localStorage` under key `ws-theme`
- Prevented from flashing via inline script in `_document.js`
- All CSS uses `.dark` selector prefix on design tokens

### Color Tokens (CSS Variables)
All colors are defined as CSS custom properties in `styles/wabi-sabi-theme.css §1`:

| Token | Light | Dark |
|---|---|---|
| `--ws-bg-primary` | `#FAF8F5` | `#1A1B18` |
| `--ws-matcha-primary` | `#7A8B69` | `#6A7B5A` |
| `--ws-text-primary` | `#2C2A29` | `#D8DAD3` |
| `--ws-border-soft` | `#EAE6DF` | `#292A27` |

---

## Sidebar Props Reference

```jsx
<Sidebar
  tableOfContents={[]}   // from react-notion-x getPageTableOfContents()
  modules={[             // your course structure
    {
      title: 'Module 1',
      items: [{ slug: 'lesson-1', title: 'Intro', isNew: true }]
    }
  ]}
  currentSlug="lesson-1"
  completedLessons={3}
  totalLessons={12}
/>
```

## CourseCard Props Reference

```jsx
<CourseCard
  title="Introduction to ServiceNow"
  slug="introduction-to-servicenow"
  tags={['Platform', 'Fundamentals']}
  cover="/path/to/cover.jpg"   // or null for gradient fallback
  icon="🏛️"
  summary="A foundational overview..."
  date="2024-06-01"
  difficulty="Beginner"        // 'Beginner' | 'Intermediate' | 'Advanced'
  duration="30 min"
  completedAt={new Date()}     // or null
/>
```
