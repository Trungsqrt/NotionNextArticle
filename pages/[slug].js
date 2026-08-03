/**
 * [slug].js — Individual Lesson / Article Page
 * ──────────────────────────────────────────────
 * Renders Notion page content using react-notion-x's <NotionRenderer />.
 * The Wabi-Sabi theme CSS overrides are applied automatically via _app.js.
 *
 * CRITICAL: All data-fetching (getStaticProps / getStaticPaths) and
 * NotionRenderer props are preserved exactly as NotionNext requires.
 * Only the wrapping layout and import structure change.
 *
 * TODO: Replace the stub implementations below with your actual
 *       NotionNext lib calls (e.g. from lib/notion.js or lib/db.js).
 */

import dynamic from 'next/dynamic'
import Layout from '../components/Layout'

// ── react-notion-x core renderer
// Loaded client-side only to avoid SSR issues with heavy Notion blocks
const NotionRenderer = dynamic(
  () => import('react-notion-x').then(m => m.NotionRenderer),
  { ssr: false }
)

// ── Optional heavy block components (lazy-loaded to keep bundle lean)
const Code = dynamic(() =>
  import('react-notion-x/build/third-party/code').then(m => m.Code),
  { ssr: false }
)

const Collection = dynamic(() =>
  import('react-notion-x/build/third-party/collection').then(m => m.Collection),
  { ssr: false }
)

const Equation = dynamic(() =>
  import('react-notion-x/build/third-party/equation').then(m => m.Equation),
  { ssr: false }
)

const Pdf = dynamic(() =>
  import('react-notion-x/build/third-party/pdf').then(m => m.Pdf),
  { ssr: false }
)

const Modal = dynamic(() =>
  import('react-notion-x/build/third-party/modal').then(m => m.Modal),
  { ssr: false }
)

// ─────────────────────────────────────────────────────────────
//  getStaticPaths — TODO: replace with real Notion page slugs
// ─────────────────────────────────────────────────────────────
export async function getStaticPaths() {
  // In production, fetch all published page slugs from Notion:
  //
  // const { getAllPosts } = require('../lib/notion')
  // const posts = await getAllPosts({ filter: 'Published' })
  // const paths = posts.map(post => ({ params: { slug: post.slug } }))
  //
  // return { paths, fallback: 'blocking' }

  return {
    paths: [],
    fallback: 'blocking',
  }
}

// ─────────────────────────────────────────────────────────────
//  getStaticProps — TODO: replace with real Notion data fetch
// ─────────────────────────────────────────────────────────────
export async function getStaticProps({ params }) {
  const { slug } = params

  try {
    // In production, use NotionNext's lib to fetch recordMap:
    //
    // const { getPageBySlug, getTableOfContents } = require('../lib/notion')
    // const page = await getPageBySlug(slug)
    // if (!page) return { notFound: true }
    //
    // return {
    //   props: {
    //     recordMap:       page.recordMap,        // ← required by NotionRenderer
    //     pageId:          page.id,
    //     title:           page.title,
    //     description:     page.summary,
    //     tableOfContents: page.tableOfContents,  // from getPageTableOfContents()
    //     modules:         [],                    // pass your course module array
    //     currentSlug:     slug,
    //   },
    //   revalidate: 60,
    // }

    // ── Stub: return empty recordMap so the page renders without crashing
    return {
      props: {
        recordMap:       {},
        pageId:          slug,
        title:           'Lesson',
        description:     '',
        tableOfContents: [],
        modules:         [],
        currentSlug:     slug,
      },
      revalidate: 60,
    }
  } catch (err) {
    console.error(`Failed to fetch page for slug: ${slug}`, err)
    return { notFound: true }
  }
}

// ═══════════════════════════════════════════════════════════
//  Page Component
// ═══════════════════════════════════════════════════════════
export default function LessonPage({
  recordMap,
  pageId,
  title,
  description,
  tableOfContents,
  modules,
  currentSlug,
}) {
  return (
    <Layout
      showSidebar
      pageTitle={title}
      pageDescription={description}
      tableOfContents={tableOfContents}
      modules={modules}
      currentSlug={currentSlug}
    >
      {/*
        ── NotionRenderer: the core content engine.
        All Wabi-Sabi styles apply automatically via CSS class overrides
        in styles/wabi-sabi-theme.css — no changes to these props needed.

        IMPORTANT: Do NOT remove or rename these props. They are required
        by react-notion-x to correctly render all Notion block types.
      */}
      <div className="notion-viewport">
        {recordMap && Object.keys(recordMap).length > 0 ? (
          <NotionRenderer
            recordMap={recordMap}
            fullPage
            darkMode={false}         // ← Controlled by our own CSS .dark class
            rootPageId={pageId}
            previewImages
            showTableOfContents={false}  // ← We render our own TOC in Sidebar
            minTableOfContentsItems={3}
            components={{
              Code,
              Collection,
              Equation,
              Pdf,
              Modal,
            }}
          />
        ) : (
          /* Rendered when no Notion data is available (dev stub) */
          <div className="max-w-content mx-auto px-6 py-16 text-center">
            <span className="block text-5xl mb-6 opacity-50">📖</span>
            <h1 className="font-serif text-2xl text-ink-600 dark:text-sage-200 mb-3">
              {title || 'Lesson'}
            </h1>
            <p className="text-ink-400 dark:text-sage-500 text-[0.9rem] leading-relaxed">
              Connect your Notion database via{' '}
              <code className="notion-inline-code">.env.local</code> to render content here.
            </p>
            <p className="mt-6 text-[0.78rem] text-ink-300 dark:text-sage-600 font-serif italic">
              ✦ &nbsp;空 — The space is ready. Fill it with knowledge.
            </p>
          </div>
        )}
      </div>
    </Layout>
  )
}
