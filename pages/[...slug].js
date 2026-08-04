/**
 * [...slug].js - Catch-all Article/Lesson Page
 * Handles both flat (/cis-df) and hierarchical (/cis-df/introduction-to-cmdb) routes.
 */

import dynamic from "next/dynamic"
import Layout from "../components/Layout"

const NotionRenderer = dynamic(
  () => import("react-notion-x").then(m => m.NotionRenderer),
  { ssr: false }
)

const Code = dynamic(
  () => import("react-notion-x/build/third-party/code").then(m => m.Code),
  { ssr: false }
)

const Collection = dynamic(
  () => import("react-notion-x/build/third-party/collection").then(m => m.Collection),
  { ssr: false, loading: () => null }
)

const Equation = dynamic(
  () => import("react-notion-x/build/third-party/equation").then(m => m.Equation),
  { ssr: false }
)

const Pdf = dynamic(
  () => import("react-notion-x/build/third-party/pdf").then(m => m.Pdf),
  { ssr: false }
)

const Modal = dynamic(
  () => import("react-notion-x/build/third-party/modal").then(m => m.Modal),
  { ssr: false }
)

export async function getStaticPaths() {
  const { getAllPosts } = require("../lib/notion")
  const posts = await getAllPosts()
  const paths = posts.map(post => ({ params: { slug: [post.slug] } }))
  return { paths, fallback: "blocking" }
}

export async function getStaticProps({ params }) {
  const slugArray = params.slug || []
  const lastSlug = slugArray[slugArray.length - 1]
  if (!lastSlug) return { notFound: true }

  try {
    const { getPageBySlug } = require("../lib/notion")
    const page = await getPageBySlug(lastSlug)

    if (!page || !page.recordMap) return { notFound: true }

    let tableOfContents = []
    try {
      const { getPageTableOfContents } = await import("notion-utils")
      const block = Object.values(page.recordMap.block).find(b => b.value?.type === "page")
      if (block) tableOfContents = getPageTableOfContents(block.value, page.recordMap)
    } catch (tocErr) {
      console.warn("Could not extract TOC:", tocErr.message)
    }

    return {
      props: {
        recordMap: page.recordMap,
        pageId: page.id,
        title: page.title || "Lesson",
        description: page.summary || "",
        tableOfContents,
        modules: [],
        currentSlug: slugArray.join("/"),
      },
      revalidate: 60,
    }
  } catch (err) {
    console.error("Failed to fetch page for slug:", params.slug, err)
    return { notFound: true }
  }
}

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
      <div className="notion-viewport">
        {recordMap && Object.keys(recordMap).length > 0 ? (
          <NotionRenderer
            recordMap={recordMap}
            fullPage
            darkMode={false}
            rootPageId={pageId}
            previewImages
            showTableOfContents={false}
            minTableOfContentsItems={3}
            mapPageUrl={(notionPageId) => {
              const id = (notionPageId || "").replace(/-/g, "")
              return id ? `/${id}` : "/"
            }}
            components={{ Code, Collection, Equation, Pdf, Modal }}
          />
        ) : (
          <div className="max-w-content mx-auto px-6 py-16 text-center">
            <span className="block text-5xl mb-6 opacity-50">📖</span>
            <h1 className="font-serif text-2xl text-ink-600 dark:text-sage-200 mb-3">
              {title || "Lesson"}
            </h1>
            <p className="text-ink-400 dark:text-sage-500 text-[0.9rem] leading-relaxed">
              Connect your Notion database via{" "}
              <code className="notion-inline-code">.env.local</code> to render content here.
            </p>
          </div>
        )}
      </div>
    </Layout>
  )
}