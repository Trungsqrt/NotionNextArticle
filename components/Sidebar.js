'use client'

/**
 * Sidebar.js — Wabi-Sabi Course Navigation Sidebar
 * ──────────────────────────────────────────────────
 * Sticky left-hand sidebar showing the course module / lesson tree.
 * Receives standard NotionNext table-of-contents data as props.
 *
 * Props:
 *   tableOfContents  — Array of { id, title, level, slug? } TOC entries
 *                      from react-notion-x's getPageTableOfContents() util.
 *   modules          — Optional Array of { title, items: [{slug,title}] }
 *                      for a multi-module course structure.
 *   currentSlug      — String: the slug/id of the currently viewed page.
 *   onClose          — Fn: called when mobile sidebar closes (optional).
 *   isOpen           — Bool: controls mobile visibility.
 *
 * IMPORTANT: Does NOT modify any data-fetching or recordMap logic.
 */

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

// ── Icon helpers
const ChevronIcon = ({ open }) => (
  <svg
    width="14" height="14" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth="2.5"
    strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true"
    style={{
      transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
      transition: 'transform 250ms cubic-bezier(0.4,0,0.2,1)',
    }}
  >
    <polyline points="9 18 15 12 9 6" />
  </svg>
)

const BookIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true">
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
  </svg>
)

const FileIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true">
    <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
    <polyline points="13 2 13 9 20 9" />
  </svg>
)

// ── Single TOC heading item (from getPageTableOfContents)
function TocItem({ item, currentId }) {
  const isActive = currentId === item.id
  const indentClass = item.level === 2
    ? 'pl-4'
    : item.level === 3
      ? 'pl-7'
      : 'pl-2'

  return (
    <a
      href={`#${item.id}`}
      id={`sidebar-toc-${item.id}`}
      className={[
        'block py-1 pr-3 text-[0.8rem] rounded-r-zen leading-snug',
        'transition-all duration-200',
        'hover:text-ink-700 dark:hover:text-sage-100',
        indentClass,
        isActive
          ? 'text-matcha-500 dark:text-matcha-300 font-medium bg-matcha-50/60 dark:bg-matcha-700/20 border-l-2 border-matcha-500 dark:border-matcha-700'
          : 'text-ink-400 dark:text-sage-500 hover:bg-rice-paper-300/50 dark:hover:bg-tea-slate-200/30 border-l-2 border-transparent',
      ].join(' ')}
    >
      {item.text}
    </a>
  )
}

// ── Module group (collapsible section with lessons)
function ModuleGroup({ module, currentSlug, defaultOpen }) {
  const isModuleActive = module.items?.some(item => item.slug === currentSlug)
  const [open, setOpen] = useState(defaultOpen || isModuleActive)

  return (
    <div className="mb-1">
      {/* Module header button */}
      <button
        type="button"
        id={`sidebar-module-${module.title.toLowerCase().replace(/\s+/g, '-')}`}
        onClick={() => setOpen(v => !v)}
        className={[
          'w-full flex items-center justify-between gap-2',
          'px-3 py-2 rounded-zen text-left',
          'transition-colors duration-200',
          'group',
          open
            ? 'text-ink-700 dark:text-sage-200'
            : 'text-ink-500 dark:text-sage-400',
          'hover:bg-rice-paper-300/60 dark:hover:bg-tea-slate-200/40',
        ].join(' ')}
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-matcha-400 dark:text-matcha-700 flex-shrink-0">
            <BookIcon />
          </span>
          <span className="text-[0.8rem] font-semibold uppercase tracking-wider truncate">
            {module.title}
          </span>
        </span>
        <span className={[
          'flex-shrink-0 transition-colors',
          open ? 'text-matcha-400 dark:text-matcha-700' : 'text-ink-300 dark:text-sage-600',
        ].join(' ')}>
          <ChevronIcon open={open} />
        </span>
      </button>

      {/* Lesson list */}
      <div
        className="overflow-hidden transition-all duration-300 ease-in-out"
        style={{
          maxHeight: open ? `${(module.items?.length || 0) * 44}px` : '0px',
          opacity: open ? 1 : 0,
        }}
      >
        <ul className="mt-0.5 space-y-0.5" role="list">
          {module.items?.map((lesson) => {
            const isActive = lesson.slug === currentSlug
            return (
              <li key={lesson.slug} role="listitem">
                <Link
                  href={`/${lesson.slug}`}
                  id={`sidebar-lesson-${lesson.slug}`}
                  className={[
                    'flex items-center gap-2.5 pl-7 pr-3 py-2',
                    'text-[0.82rem] leading-snug rounded-r-zen',
                    'transition-all duration-200 no-underline',
                    'border-l-2',
                    isActive
                      ? [
                          'border-matcha-500 dark:border-matcha-700',
                          'bg-matcha-50/70 dark:bg-matcha-700/20',
                          'text-matcha-500 dark:text-matcha-300 font-medium',
                        ].join(' ')
                      : [
                          'border-rice-paper-400/50 dark:border-tea-slate-50/30',
                          'text-ink-500 dark:text-sage-400',
                          'hover:bg-rice-paper-300/50 dark:hover:bg-tea-slate-200/30',
                          'hover:text-ink-700 dark:hover:text-sage-200',
                          'hover:border-matcha-300 dark:hover:border-matcha-800',
                        ].join(' '),
                  ].join(' ')}
                  aria-current={isActive ? 'page' : undefined}
                >
                  <span className={[
                    'flex-shrink-0 transition-colors',
                    isActive
                      ? 'text-matcha-400 dark:text-matcha-600'
                      : 'text-ink-300 dark:text-sage-600',
                  ].join(' ')}>
                    <FileIcon />
                  </span>
                  <span className="truncate">{lesson.title}</span>
                  {lesson.isNew && (
                    <span className="ml-auto flex-shrink-0 text-[0.65rem] px-1.5 py-0.5 rounded-pill bg-matcha-100 dark:bg-matcha-700/30 text-matcha-500 dark:text-matcha-300 font-medium">
                      New
                    </span>
                  )}
                </Link>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

// ── Thin progress bar
function ModuleProgress({ completed, total }) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0
  return (
    <div className="px-3 py-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[0.7rem] text-ink-400 dark:text-sage-500 font-medium">Progress</span>
        <span className="text-[0.7rem] text-matcha-500 dark:text-matcha-400 font-semibold">{pct}%</span>
      </div>
      <div className="h-1 w-full bg-rice-paper-400/60 dark:bg-tea-slate-200/40 rounded-pill overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-matcha-500 to-matcha-400 rounded-pill transition-all duration-700 ease-out"
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════
//  Sidebar Component
// ════════════════════════════════════════════════════════════
export default function Sidebar({
  tableOfContents = [],   // react-notion-x TOC entries for current page
  modules = [],           // multi-module course structure
  currentSlug = '',
  onClose,
  isOpen = true,
  completedLessons = 0,
  totalLessons = 0,
}) {
  const pathname = usePathname() || ''
  const [activeId, setActiveId] = useState('')

  // Intersection Observer — highlight TOC item on scroll
  useEffect(() => {
    if (tableOfContents.length === 0) return

    const headingIds = tableOfContents.map(item => item.id)
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id)
          }
        })
      },
      { rootMargin: '-80px 0px -60% 0px', threshold: 0 }
    )

    headingIds.forEach(id => {
      const el = document.getElementById(id)
      if (el) observer.observe(el)
    })

    return () => observer.disconnect()
  }, [tableOfContents, pathname])

  const totalItems = modules.reduce((acc, m) => acc + (m.items?.length || 0), 0)
  const effectiveTotalLessons = totalLessons || totalItems

  return (
    <>
      {/* ── Mobile overlay backdrop */}
      {onClose && (
        <div
          className={[
            'fixed inset-0 z-30 md:hidden bg-ink-700/15 dark:bg-black/35 backdrop-blur-sm',
            'transition-opacity duration-300',
            isOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
          ].join(' ')}
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      {/* ── Sidebar panel */}
      <aside
        id="course-sidebar"
        role="complementary"
        aria-label="Course navigation"
        className={[
          // Base layout
          'fixed md:sticky top-14 z-30',
          'h-[calc(100vh-3.5rem)] md:h-[calc(100vh-3.5rem)]',
          'w-64 flex-shrink-0 flex flex-col',
          // Appearance
          'bg-rice-paper-100/98 dark:bg-tea-slate-300/98',
          'border-r border-rice-paper-400/60 dark:border-tea-slate-50/60',
          'overflow-hidden',
          // Mobile slide-in
          'transition-transform duration-300 ease-out',
          isOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
        ].join(' ')}
      >
        {/* ── Header strip */}
        <div className="px-3 pt-5 pb-3 border-b border-rice-paper-400/50 dark:border-tea-slate-50/40 flex-shrink-0">
          <h2 className="text-[0.7rem] font-semibold uppercase tracking-widest text-matcha-500 dark:text-matcha-700 mb-0.5">
            ServiceNow Academy
          </h2>
          <p className="text-[0.78rem] text-ink-500 dark:text-sage-400 leading-tight">
            Knowledge Hub
          </p>
        </div>

        {/* ── Progress bar (shown when course modules are provided) */}
        {effectiveTotalLessons > 0 && (
          <div className="flex-shrink-0 border-b border-rice-paper-400/40 dark:border-tea-slate-50/30">
            <ModuleProgress
              completed={completedLessons}
              total={effectiveTotalLessons}
            />
          </div>
        )}

        {/* ── Scrollable content */}
        <div className="flex-1 overflow-y-auto overscroll-contain py-3 px-1.5">

          {/* Module tree (primary course nav) */}
          {modules.length > 0 && (
            <section aria-labelledby="sidebar-modules-heading">
              <h3
                id="sidebar-modules-heading"
                className="px-3 mb-2 text-[0.68rem] font-semibold uppercase tracking-widest text-ink-300 dark:text-sage-600"
              >
                Modules
              </h3>
              {modules.map((mod, index) => (
                <ModuleGroup
                  key={mod.title}
                  module={mod}
                  currentSlug={currentSlug}
                  defaultOpen={index === 0}
                />
              ))}
            </section>
          )}

          {/* Page TOC (in-page headings for current lesson) */}
          {tableOfContents.length > 0 && (
            <>
              {modules.length > 0 && (
                <div className="my-3 mx-3 h-px bg-rice-paper-400/50 dark:bg-tea-slate-50/30" />
              )}
              <section aria-labelledby="sidebar-toc-heading">
                <h3
                  id="sidebar-toc-heading"
                  className="px-3 mb-2 text-[0.68rem] font-semibold uppercase tracking-widest text-ink-300 dark:text-sage-600"
                >
                  On This Page
                </h3>
                <nav aria-label="Table of contents">
                  <ul className="space-y-0.5 pl-1" role="list">
                    {tableOfContents.map((item) => (
                      <li key={item.id} role="listitem">
                        <TocItem item={item} currentId={activeId} />
                      </li>
                    ))}
                  </ul>
                </nav>
              </section>
            </>
          )}
        </div>

        {/* ── Footer strip */}
        <div className="flex-shrink-0 px-3 py-3 border-t border-rice-paper-400/50 dark:border-tea-slate-50/40">
          <p className="text-[0.68rem] text-ink-300 dark:text-sage-600 text-center">
            ✦ &nbsp;Study with intention
          </p>
        </div>
      </aside>
    </>
  )
}
