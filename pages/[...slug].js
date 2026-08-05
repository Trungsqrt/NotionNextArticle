import Layout from "../components/Layout"
import { getAllPosts, getPageBySlug } from "../lib/notion"

export async function getStaticPaths() {
  const posts = await getAllPosts()
  const paths = posts.map(post => ({ params: { slug: [post.slug] } }))
  return { paths, fallback: "blocking" }
}

export async function getStaticProps({ params }) {
  const param = Array.isArray(params.slug) ? params.slug.join('/') : params.slug || '';
  if (/\.(ico|png|jpg|jpeg|svg|css|js|txt|map|json|xml)$/i.test(param)) {
    return { notFound: true };
  }

  const slugArray = params.slug || []
  const lastSlug = slugArray[slugArray.length - 1]
  if (!lastSlug) return { notFound: true }

  try {
    const page = await getPageBySlug(lastSlug)

    if (!page || !page.html) return { notFound: true }

    return {
      props: {
        html: page.html,
        pageId: page.id,
        title: page.title || "Lesson",
        description: page.summary || "",
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
  html,
  pageId,
  title,
  description,
  modules,
  currentSlug,
}) {
  return (
    <Layout
      showSidebar
      pageTitle={title}
      pageDescription={description}
      modules={modules}
      currentSlug={currentSlug}
    >
      <div className="notion-viewport">
        {html ? (
          <div
            className="prose prose-neutral max-w-none wabi-sabi-theme px-6 py-10"
            dangerouslySetInnerHTML={{ __html: html }}
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