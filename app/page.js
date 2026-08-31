import CourseFilter from '../components/CourseFilter'
import { getAllPosts } from '../lib/notion'

// Revalidate homepage in background every 1 hour (3600 seconds)
export const revalidate = 3600

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://notion-next-article-pink.vercel.app'
const AUTHOR_NAME = 'Jun Mai - Trungsqrt'

export const metadata = {
  title: 'ServiceNow Space · Knowledge Hub',
  description: 'Explore curated ServiceNow architecture notes, CSDM/CMDB labs, and reference cards by Jun Mai - Trungsqrt.',
  alternates: {
    canonical: '/',
  },
  openGraph: {
    title: 'ServiceNow Knowledge Hub · Jun Mai - Trungsqrt',
    description: 'Master ServiceNow with calm clarity — curated lessons, labs, and reference notes.',
    url: SITE_URL,
    type: 'website',
  },
}

export default async function Home() {
  const allPosts = await getAllPosts()

  // ── Filter courses for homepage ──────────────────────────────────────────
  // 1. Only Published status (exclude Draft / Archived / Hidden)
  // 2. Only top-level courses (exclude child sub-lessons that have a parent course)
  const publishedCourses = allPosts.filter(c => {
    const status = (c.status || '').toLowerCase()
    if (status === 'draft' || status === 'archived' || status === 'hidden') return false
    if (c.parentTitle && c.parentTitle.trim() !== '') return false
    return true
  })

  // Fallback to allPosts if published filter yields nothing
  const courses = publishedCourses.length > 0 ? publishedCourses : allPosts

  // ── Extract filter options from live Notion data ──────────────────────────
  // Categories — category is now extracted in notion.js; fall back to tags[0] for safety
  const uniqueCategories = [...new Set(
    courses.map(c => c.category || c.Category || c.tags?.[0]).filter(Boolean)
  )].sort()

  // Tags — flatMap handles multi-select arrays
  const uniqueTags = [...new Set(
    courses.flatMap(c => c.tags || c.Tags || []).filter(Boolean)
  )].sort()

  // ── JSON-LD Structured Data for Course Catalog (ItemList Schema) ────────
  const catalogJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'ServiceNow Courses & Architecture Guides',
    description: 'Curated lessons and reference cards for ServiceNow professionals',
    numberOfItems: courses.length,
    itemListElement: courses.map((course, index) => {
      const slug = course.slug || course.id
      return {
        '@type': 'ListItem',
        position: index + 1,
        name: course.title,
        url: `${SITE_URL}/${slug}`,
        description: course.summary || undefined,
      }
    }),
  }

  return (
    <div className="max-w-screen-xl mx-auto px-4 md:px-8 py-10 md:py-14">
      {/* ── Structured Data Schema for Course Collection */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(catalogJsonLd) }}
      />

      {/* ── Hero */}
      <header className="mb-10 md:mb-14 max-w-2xl animate-fade-in relative">
        <div className="flex items-center gap-2.5 mb-3.5">
          <span className="w-3.5 h-px bg-matcha-400/60 dark:bg-matcha-600/60" aria-hidden="true" />
          <span className="text-[0.72rem] uppercase tracking-[0.2em] font-medium text-matcha-600 dark:text-matcha-400 select-none">
            ServiceNow Space
          </span>
        </div>
        <h1 className="font-serif font-medium text-3xl sm:text-4xl md:text-[2.6rem] text-ink-700 dark:text-sage-100 leading-[1.28] tracking-[-0.015em] mb-4 text-balance">
          Master ServiceNow with{' '}
          <span className="text-matcha-600 dark:text-matcha-400 font-normal">
            calm clarity
          </span>
        </h1>
        <p className="text-[0.98rem] md:text-[1.02rem] leading-[1.8] text-ink-500 dark:text-sage-400 max-w-prose">
          A serene knowledge space for IT professionals navigating ServiceNow's vast ecosystem.
          Curated lessons, labs, and reference notes — structured for deep learning.
        </p>
      </header>

      {/* ── Filter + Grid (client component) */}
      {courses.length > 0 ? (
        <CourseFilter
          initialCourses={courses}
          uniqueCategories={uniqueCategories}
          uniqueTags={uniqueTags}
        />
      ) : (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <span className="text-5xl mb-4 opacity-60">茶</span>
          <p className="text-ink-400 dark:text-sage-500 font-serif italic">
            No lessons found. Begin by connecting your Notion database.
          </p>
        </div>
      )}
    </div>
  )
}

