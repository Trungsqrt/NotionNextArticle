'use client'

/**
 * CourseFilter.js — Custom dropdown filter for the course grid
 * ─────────────────────────────────────────────────────────────
 * Fully custom div/ul/li dropdowns — no native <select>.
 * Single shared click-outside handler via one container ref.
 */

import { useState, useEffect, useRef, useMemo } from 'react'
import CourseCard from './CourseCard'

// ── Dropdown enter animation ──────────────────────────────────────────────────
const DROPDOWN_STYLE = `
  @keyframes dropdownIn {
    from { opacity: 0; transform: translateY(-6px) scale(0.97); }
    to   { opacity: 1; transform: translateY(0)    scale(1);    }
  }
  .animate-dropdown {
    animation: dropdownIn 0.15s cubic-bezier(0.16, 1, 0.3, 1) both;
    transform-origin: top center;
  }
`

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
      'flex items-center justify-between w-48 pl-4 pr-3 py-2 rounded-xl',
      'text-sm font-medium transition-colors duration-150 outline-none select-none cursor-pointer',
      active
        ? 'bg-neutral-600 dark:bg-neutral-500 text-white border border-transparent shadow-sm'
        : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 border border-neutral-200/60 dark:border-neutral-700 hover:bg-neutral-200/60 dark:hover:bg-neutral-700/70',
    ].join(' ')
  }

  function itemCls(selected) {
    return [
      'px-4 py-2 text-sm cursor-pointer transition-colors duration-100',
      selected
        ? 'bg-neutral-100 dark:bg-neutral-700 font-semibold text-neutral-900 dark:text-neutral-100'
        : 'text-neutral-600 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-700/50',
    ].join(' ')
  }

  const menuCls = 'animate-dropdown absolute top-full left-0 mt-2 w-56 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-xl shadow-lg z-50 py-1 overflow-hidden'

  function ChevronIcon({ open }) {
    return (
      <svg
        className={`w-4 h-4 ml-2 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        fill="none" strokeWidth="2" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
      </svg>
    )
  }

  return (
    <>
      {/* Animation keyframes — injected once */}
      <style dangerouslySetInnerHTML={{ __html: DROPDOWN_STYLE }} />

      {/* ── Filter bar — no overflow-hidden so menus float freely ─────────── */}
      <div className="flex flex-wrap gap-3 mb-8 items-center">

        {/* ── Category dropdown ─────────────────────────────────────────── */}
        <div className="relative" ref={categoryRef}>
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
                className="px-4 py-2 text-sm text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700 cursor-pointer transition-colors"
              >
                Category: All
              </li>
              {uniqueCategories.map(cat => (
                <li
                  key={cat} role="option" aria-selected={selectedCategory === cat}
                  onClick={() => { setSelectedCategory(cat); setSelectedTag(''); setOpenDropdown(null) }}
                  className={itemCls(selectedCategory === cat)}
                >
                  {cat}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ── Tag dropdown ──────────────────────────────────────────────── */}
        <div className="relative" ref={tagRef}>
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
                className="px-4 py-2 text-sm text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700 cursor-pointer transition-colors"
              >
                Tag: All
              </li>
              {uniqueTags.map(tag => (
                <li
                  key={tag} role="option" aria-selected={selectedTag === tag}
                  onClick={() => { setSelectedTag(tag); setOpenDropdown(null) }}
                  className={itemCls(selectedTag === tag)}
                >
                  {tag}
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
            className="flex items-center gap-1.5 py-2 px-3 rounded-xl text-sm font-medium text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors duration-150"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
            Clear
          </button>
        )}

        {/* ── Live result count ─────────────────────────────────────────── */}
        <span className="ml-auto text-xs text-neutral-400 dark:text-neutral-500 tabular-nums select-none">
          {filteredCourses.length} {filteredCourses.length === 1 ? 'result' : 'results'}
        </span>
      </div>

      {/* ── Course grid ───────────────────────────────────────────────────── */}
      <section aria-label="Course catalog">
        {filteredCourses.length > 0 ? (
          <div
            className="grid gap-5"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}
          >
            {filteredCourses.map((course, index) => (
              <div key={course.slug} style={{ animationDelay: `${index * 50 + 60}ms` }}>
                <CourseCard {...course} />
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-24 text-center animate-fade-in">
            <span className="text-4xl mb-4 opacity-50 select-none">茶</span>
            <p className="text-ink-400 dark:text-sage-500 font-serif italic text-[0.95rem]">
              No lessons match the selected filters.
            </p>
            <button
              type="button"
              onClick={clearAll}
              className="mt-4 text-[0.78rem] text-matcha-500 dark:text-matcha-400 hover:underline underline-offset-2 transition-colors duration-150"
            >
              Clear filters
            </button>
          </div>
        )}
      </section>
    </>
  )
}
