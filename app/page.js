import CourseFilter from '../components/CourseFilter'
import { getAllPosts } from '../lib/notion'

// Revalidate homepage in background every 1 hour (3600 seconds)
export const revalidate = 3600

export const metadata = {
  title: 'Knowledge Hub · ServiceNow Space',
  description: 'Explore ServiceNow courses, labs, and reference cards — curated with Zen intention.',
}

export default async function Home() {
  const courses = await getAllPosts()

  // ── Extract filter options from live Notion data ──────────────────────────
  // Categories — category is now extracted in notion.js; fall back to tags[0] for safety
  const uniqueCategories = [...new Set(
    courses.map(c => c.category || c.Category || c.tags?.[0]).filter(Boolean)
  )].sort()

  // Tags — flatMap handles multi-select arrays
  const uniqueTags = [...new Set(
    courses.flatMap(c => c.tags || c.Tags || []).filter(Boolean)
  )].sort()

  return (
    <div className="max-w-screen-xl mx-auto px-4 md:px-8 py-10 md:py-14">

      {/* ── Hero */}
      <header className="mb-12 max-w-2xl animate-fade-in">
        <div className="flex items-center gap-2 mb-4">
          <span className="text-matcha-500 dark:text-matcha-400 font-semibold text-[0.75rem] uppercase tracking-widest">
            ✦ &nbsp;ServiceNow Space
          </span>
        </div>
        <h1 className="font-serif font-medium text-3xl md:text-4xl text-ink-700 dark:text-sage-100 leading-tight mb-4 text-balance">
          Master ServiceNow with{' '}
          <span className="text-matcha-500 dark:text-matcha-400">calm clarity</span>
        </h1>
        <p className="text-[1rem] leading-relaxed text-ink-400 dark:text-sage-400 max-w-prose">
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

