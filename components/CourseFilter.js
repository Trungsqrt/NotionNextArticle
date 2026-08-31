'use client'

/**
 * CourseFilter.js — Editorial Knowledge Archive Filter Controls
 * ─────────────────────────────────────────────────────────────
 * Fully custom div/ul/li dropdowns — no native <select>.
 * Single shared click-outside handler via container refs.
 */

import { useState, useEffect, useRef, useMemo } from 'react'
import CourseCard from './CourseCard'

export default function CourseFilter({ initialCourses, uniqueCategories, uniqueTags }) {
  const [selectedCategory, setSelectedCategory] = useState('')
  const [selectedTag,      setSelectedTag]      = useState('')
  const [openDropdown,     setOpenDropdown]      = useState(null) // 'category' | 'tag' | null

  const categoryRef = useRef(null)
  const tagRef      = useRef(null)

  // ── Close on outside click ───────────────────────────────────────────────
  useEffect(() => {
    function handleClickOutside(e) {
      const clickedOutsideCategory = categoryRef.current && !categoryRef.current.contains(e.target)
      const clickedOutsideTag      = tagRef.current      && !tagRef.current.contains(e.target)
      if (clickedOutsideCategory && clickedOutsideTag) setOpenDropdown(null)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // ── Close on Escape ──────────────────────────────────────────────────────
  useEffect(() => {
    function handleEsc(e) { if (e.key === 'Escape') setOpenDropdown(null) }
    document.addEventListener('keydown', handleEsc)
    return () => document.removeEventListener('keydown', handleEsc)
  }, [])

  // ── Filtered results ─────────────────────────────────────────────────────
  const filteredCourses = useMemo(() => {
    return initialCourses.filter(course => {
      if (selectedCategory && course.category !== selectedCategory) return false
      if (selectedTag && !(course.tags || []).includes(selectedTag)) return false
      return true
    })
  }, [initialCourses, selectedCategory, selectedTag])

  const hasActiveFilter = selectedCategory || selectedTag

  function clearAll() {
    setSelectedCategory('')
    setSelectedTag('')
    setOpenDropdown(null)
  }

  // ── Shared dropdown classes ──────────────────────────────────────────────
  function triggerCls(active) {
    return [
      'flex items-center justify-between w-full sm:w-48 pl-3.5 pr-2.5 py-2 rounded-[6px]',
      'text-[0.83rem] font-medium transition-all duration-200 ease-out outline-none select-none cursor-pointer',
      'focus-visible:ring-2 focus-visible:ring-matcha-500/50 dark:focus-visible:ring-matcha-400/60',
      active
        ? 'bg-matcha-100/90 text-matcha-700 border border-matcha-400/70 shadow-sm dark:bg-matcha-700/25 dark:text-matcha-300 dark:border-matcha-600/50 dark:shadow-none'
        : 'bg-rice-paper-200/70 text-ink-600 border border-rice-paper-400/80 hover:bg-rice-paper-300/80 hover:text-ink-700 dark:bg-tea-slate-200 dark:text-sage-200 dark:border-tea-slate-50/50 dark:hover:bg-tea-slate-100/70 dark:hover:border-tea-slate-50/70 dark:hover:text-sage-100',
    ].join(' ')
  }

  function itemCls(selected) {
    return [
      'px-3.5 py-2 text-[0.82rem] cursor-pointer transition-colors duration-150 ease-out flex items-center justify-between',
      selected
        ? 'bg-matcha-100/70 dark:bg-matcha-700/25 font-medium text-matcha-700 dark:text-matcha-300'
        : 'text-ink-600 dark:text-sage-300 hover:bg-rice-paper-300/60 dark:hover:bg-tea-slate-200/70 hover:text-ink-700 dark:hover:text-sage-100',
    ].join(' ')
  }

  const menuCls = 'animate-dropdown absolute top-full left-0 mt-1.5 w-full sm:w-56 bg-rice-paper-100 dark:bg-tea-slate-50 border border-rice-paper-400/80 dark:border-tea-slate-50/60 rounded-[6px] shadow-zen-md dark:shadow-[0_4px_16px_rgba(18,19,16,0.5)] z-50 py-1 overflow-hidden'

  function ChevronIcon({ open }) {
    return (
      <svg
        className={`w-3.5 h-3.5 ml-2 shrink-0 transition-transform duration-250 ease-out text-ink-400 dark:text-sage-400 ${open ? 'rotate-180 text-matcha-500 dark:text-matcha-400' : ''}`}
        fill="none" strokeWidth="2" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
      </svg>
    )
  }

  return (
    <>
      {/* ── Filter bar — no overflow-hidden so menus float freely ─────────── */}
      <div className="flex flex-wrap gap-3 mb-8 items-center">

        {/* ── Category dropdown ─────────────────────────────────────────── */}
        <div className="relative w-full sm:w-auto" ref={categoryRef}>
          <button
            type="button"
            id="filter-category"
            onClick={() => setOpenDropdown(openDropdown === 'category' ? null : 'category')}
            aria-haspopup="listbox"
            aria-expanded={openDropdown === 'category'}
            className={triggerCls(!!selectedCategory)}
          >
            <span className="truncate">{selectedCategory || 'Category: All'}</span>
            <ChevronIcon open={openDropdown === 'category'} />
          </button>

          {openDropdown === 'category' && (
            <ul role="listbox" aria-label="Category" className={menuCls}>
              <li
                role="option" aria-selected={!selectedCategory}
                onClick={() => { setSelectedCategory(''); setOpenDropdown(null) }}
                className={itemCls(!selectedCategory)}
              >
                <span>Category: All</span>
                {!selectedCategory && (
                  <span className="w-1.5 h-1.5 rounded-full bg-matcha-500 dark:bg-matcha-400" aria-hidden="true" />
                )}
              </li>
              {uniqueCategories.map(cat => (
                <li
                  key={cat} role="option" aria-selected={selectedCategory === cat}
                  onClick={() => { setSelectedCategory(cat); setSelectedTag(''); setOpenDropdown(null) }}
                  className={itemCls(selectedCategory === cat)}
                >
                  <span className="truncate">{cat}</span>
                  {selectedCategory === cat && (
                    <span className="w-1.5 h-1.5 rounded-full bg-matcha-500 dark:bg-matcha-400" aria-hidden="true" />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ── Tag dropdown ──────────────────────────────────────────────── */}
        <div className="relative w-full sm:w-auto" ref={tagRef}>
          <button
            type="button"
            id="filter-tag"
            onClick={() => setOpenDropdown(openDropdown === 'tag' ? null : 'tag')}
            aria-haspopup="listbox"
            aria-expanded={openDropdown === 'tag'}
            className={triggerCls(!!selectedTag)}
          >
            <span className="truncate">{selectedTag || 'Tag: All'}</span>
            <ChevronIcon open={openDropdown === 'tag'} />
          </button>

          {openDropdown === 'tag' && (
            <ul role="listbox" aria-label="Tag" className={menuCls}>
              <li
                role="option" aria-selected={!selectedTag}
                onClick={() => { setSelectedTag(''); setOpenDropdown(null) }}
                className={itemCls(!selectedTag)}
              >
                <span>Tag: All</span>
                {!selectedTag && (
                  <span className="w-1.5 h-1.5 rounded-full bg-matcha-500 dark:bg-matcha-400" aria-hidden="true" />
                )}
              </li>
              {uniqueTags.map(tag => (
                <li
                  key={tag} role="option" aria-selected={selectedTag === tag}
                  onClick={() => { setSelectedTag(tag); setOpenDropdown(null) }}
                  className={itemCls(selectedTag === tag)}
                >
                  <span className="truncate">{tag}</span>
                  {selectedTag === tag && (
                    <span className="w-1.5 h-1.5 rounded-full bg-matcha-500 dark:bg-matcha-400" aria-hidden="true" />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ── Clear button ──────────────────────────────────────────────── */}
        {hasActiveFilter && (
          <button
            type="button"
            onClick={clearAll}
            aria-label="Clear all filters"
            className="flex items-center gap-1.5 py-1.5 px-2.5 rounded-[4px] text-[0.78rem] font-medium text-ink-400 dark:text-sage-400 hover:text-matcha-600 dark:hover:text-matcha-300 hover:bg-rice-paper-300/40 dark:hover:bg-tea-slate-200/50 transition-all duration-200 ease-out focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-matcha-500/50 dark:focus-visible:ring-matcha-400/60"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
            Clear
          </button>
        )}

        {/* ── Live result count ─────────────────────────────────────────── */}
        <span className="ml-auto text-[0.75rem] text-ink-400 dark:text-sage-500 tabular-nums select-none tracking-wide">
          {filteredCourses.length} {filteredCourses.length === 1 ? 'result' : 'results'}
        </span>
      </div>

      {/* ── Course grid ───────────────────────────────────────────────────── */}
      <section aria-label="Course catalog">
        {filteredCourses.length > 0 ? (
          <div
            className="grid gap-5"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 280px), 1fr))' }}
          >
            {filteredCourses.map((course, index) => (
              <div key={course.id || `${course.slug}-${index}`} style={{ animationDelay: `${index * 50 + 60}ms` }}>
                <CourseCard {...course} />
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-24 text-center animate-fade-in">
            <span className="text-4xl mb-4 opacity-50 select-none">茶</span>
            <p className="text-ink-400 dark:text-sage-400 font-serif italic text-[0.95rem]">
              No lessons match the selected filters.
            </p>
            <button
              type="button"
              onClick={clearAll}
              className="mt-3 text-[0.78rem] text-matcha-500 dark:text-matcha-400 hover:text-matcha-600 dark:hover:text-matcha-300 transition-colors duration-200 ease-out focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-matcha-500/50 dark:focus-visible:ring-matcha-400/60 rounded-[4px] px-2 py-1"
            >
              Clear filters
            </button>
          </div>
        )}
      </section>
    </>
  )
}

