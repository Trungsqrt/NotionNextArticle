import CourseCard from '../components/CourseCard'
import { getAllPosts } from '../lib/notion'

export const revalidate = 60

export const metadata = {
  title: 'Knowledge Hub · ServiceNow Academy',
  description: 'Explore ServiceNow courses, labs, and reference cards — curated with Zen intention.',
}

export default async function Home() {
  const courses = await getAllPosts()

  return (
    <div className="max-w-screen-xl mx-auto px-4 md:px-8 py-10 md:py-14">

      {/* ── Hero */}
      <header className="mb-12 max-w-2xl animate-fade-in">
        <div className="flex items-center gap-2 mb-4">
          <span className="text-matcha-500 dark:text-matcha-400 font-semibold text-[0.75rem] uppercase tracking-widest">
            ✦ &nbsp;ServiceNow Academy
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

      {/* ── Filter bar */}
      <div
        className="flex flex-wrap items-center gap-2 mb-8 animate-fade-in"
        style={{ animationDelay: '80ms' }}
        role="group"
        aria-label="Filter by category"
      >
        {['All', 'Fundamentals', 'ITSM', 'Development', 'Integration', 'Analytics', 'Automation'].map((filter, i) => (
          <button
            key={filter}
            id={`home-filter-${filter.toLowerCase()}`}
            type="button"
            className={[
              'px-3 py-1.5 rounded-pill text-[0.78rem] font-medium',
              'border transition-all duration-200',
              i === 0
                ? 'bg-matcha-500 dark:bg-matcha-700 text-white border-matcha-500 dark:border-matcha-700'
                : 'bg-rice-paper-200/80 dark:bg-tea-slate-200/50 text-ink-500 dark:text-sage-400 border-rice-paper-400/70 dark:border-tea-slate-50/60 hover:border-matcha-400/60 dark:hover:border-matcha-700/60 hover:text-matcha-500 dark:hover:text-matcha-300',
            ].join(' ')}
          >
            {filter}
          </button>
        ))}
      </div>

      {/* ── Course Grid */}
      <section aria-label="Course catalog">
        <div
          className="grid gap-5"
          style={{
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          }}
        >
          {courses.map((course, index) => (
            <div
              key={course.slug}
              style={{ animationDelay: `${index * 60 + 120}ms` }}
            >
              <CourseCard {...course} />
            </div>
          ))}
        </div>
      </section>

      {/* ── Empty state */}
      {courses.length === 0 && (
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
