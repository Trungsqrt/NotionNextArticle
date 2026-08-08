import Link from "next/link"
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

    const coverUrl = typeof page.cover === 'string'
      ? page.cover
      : (page.cover?.external?.url || page.cover?.file?.url || null)

    return {
      props: {
        html: page.html,
        pageId: page.id,
        title: page.title || "Lesson",
        description: page.summary || "",
        cover: coverUrl,
        category: page.category || "Documentation",
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
  cover,
  category,
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
      {cover && (
        <div className="w-full h-[30vh] min-h-[250px] overflow-hidden relative">
          <img
            src={cover}
            alt={title || "Cover Image"}
            className="w-full h-full object-cover"
          />
        </div>
      )}
      <div className="notion-viewport max-w-4xl mx-auto px-4 sm:px-6 md:px-8 py-8 md:py-12">
        {/* Page Header */}
        <header className="mb-8 pb-6 border-b border-rice-paper-400/60 dark:border-tea-slate-50/40">
          {/* Breadcrumbs */}
          <nav aria-label="Breadcrumb" className="text-sm text-neutral-400 dark:text-neutral-500 mb-6 flex items-center gap-2 flex-wrap">
            <Link href="/" className="hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors">
              Home
            </Link>
            <span>/</span>
            {category && (
              <>
                <span className="hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors">
                  {category}
                </span>
                <span>/</span>
              </>
            )}
            <span className="text-neutral-700 dark:text-neutral-200 font-medium truncate max-w-[250px]">
              {title}
            </span>
          </nav>

          <h1 className="font-serif font-medium text-2xl sm:text-3xl md:text-4xl text-ink-700 dark:text-sage-100 leading-tight mb-3">
            {title}
          </h1>
          {description && (
            <p className="text-[1rem] leading-relaxed text-ink-400 dark:text-sage-400 max-w-prose">
              {description}
            </p>
          )}
        </header>

        {/* Content Body */}
        {html ? (
          <div
            className={[
              'prose prose-neutral dark:prose-invert max-w-none wabi-sabi-theme',
              'prose-headings:font-serif prose-headings:font-medium prose-headings:text-ink-700 dark:prose-headings:text-sage-100',
              'prose-h1:text-2xl md:prose-h1:text-3xl prose-h1:border-b prose-h1:border-rice-paper-400/60 dark:prose-h1:border-tea-slate-50/40 prose-h1:pb-3 prose-h1:mb-6 prose-h1:mt-8',
              'prose-h2:text-xl md:prose-h2:text-2xl prose-h2:mt-8 prose-h2:mb-4',
              'prose-h3:text-lg prose-h3:mt-6 prose-h3:mb-3',
              'prose-p:text-ink-700 dark:prose-p:text-sage-200 prose-p:leading-relaxed prose-p:my-4 prose-p:text-[0.98rem]',
              'prose-a:text-matcha-600 dark:prose-a:text-matcha-300 prose-a:no-underline hover:prose-a:underline',
              'prose-strong:text-ink-700 dark:prose-strong:text-sage-100 prose-strong:font-semibold',
              'prose-ul:my-4 prose-ol:my-4 prose-li:my-1.5 prose-li:text-ink-700 dark:prose-li:text-sage-200 prose-li:text-[0.98rem]',
              'prose-code:text-matcha-700 dark:prose-code:text-matcha-300 prose-code:bg-rice-paper-300/50 dark:prose-code:bg-tea-slate-200/50 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none',
              'prose-blockquote:border-l-3 prose-blockquote:border-matcha-500 prose-blockquote:pl-4 prose-blockquote:italic prose-blockquote:text-ink-500 dark:prose-blockquote:text-sage-300',
            ].join(' ')}
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