'use client'

/**
 * Header.js — Wabi-Sabi Matcha Navbar
 * ─────────────────────────────────────
 * A serene, uncluttered top navigation bar for the ServiceNow Knowledge Hub.
 * Props: none required — reads from Next.js router and site config env vars.
 *
 * IMPORTANT: Does NOT alter any NotionNext data props or recordMap.
 */

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

// ── Icon helpers (inline SVGs — no icon library dependency)
const SearchIcon = () => (
  <svg
    width="16" height="16" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.35-4.35" />
  </svg>
)

const SunIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </svg>
)

const MoonIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
)

const MenuIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true">
    <line x1="3" y1="6" x2="21" y2="6" />
    <line x1="3" y1="12" x2="21" y2="12" />
    <line x1="3" y1="18" x2="16" y2="18" />
  </svg>
)

const CloseIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
)

// ── Matcha Leaf brand mark
const MatchaLeaf = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M12 22C12 22 4 17 4 10C4 6 7.5 3 12 3C16.5 3 20 6 20 10C20 17 12 22 12 22Z"
      fill="rgba(122,139,105,0.85)"
      stroke="none"
    />
    <path d="M12 22L12 8" stroke="rgba(74,87,61,0.6)" strokeWidth="1.5" strokeLinecap="round"/>
    <path d="M12 14C12 14 9 12 8 9" stroke="rgba(74,87,61,0.4)" strokeWidth="1" strokeLinecap="round"/>
  </svg>
)

// ── Nav links definition
const NAV_LINKS = [
  { href: '/',           label: 'Home' },
  { href: '/modules',   label: 'Modules' },
  { href: '/labs',      label: 'Labs' },
  { href: '/resources', label: 'Resources' },
]

// ════════════════════════════════════════════════════════════
//  Header Component
// ════════════════════════════════════════════════════════════
export default function Header({ onMenuToggle, isMenuOpen }) {
  const pathname = usePathname() || ''

  // ── Dark mode state — persisted in localStorage
  const [isDark, setIsDark] = useState(false)
  const [isScrolled, setIsScrolled] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // Initialise dark mode from localStorage or system pref
  useEffect(() => {
    const saved = localStorage.getItem('ws-theme')
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    const dark = saved ? saved === 'dark' : systemDark
    setIsDark(dark)
    document.documentElement.classList.toggle('dark', dark)
  }, [])

  // Scroll shadow
  useEffect(() => {
    const handler = () => setIsScrolled(window.scrollY > 8)
    window.addEventListener('scroll', handler, { passive: true })
    return () => window.removeEventListener('scroll', handler)
  }, [])

  // Close search on route change
  useEffect(() => {
    setSearchOpen(false)
    setSearchQuery('')
  }, [pathname])

  // Close search on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') setSearchOpen(false) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const toggleDark = useCallback(() => {
    setIsDark(prev => {
      const next = !prev
      document.documentElement.classList.toggle('dark', next)
      localStorage.setItem('ws-theme', next ? 'dark' : 'light')
      return next
    })
  }, [])

  const isActive = (href) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href)

  return (
    <>
      {/* ── Main Navbar */}
      <header
        id="site-header"
        className={[
          'fixed top-0 inset-x-0 z-50 h-14',
          'bg-rice-paper-100/88 dark:bg-tea-slate-400/88',
          'backdrop-blur-md',
          'border-b border-rice-paper-400/60 dark:border-tea-slate-50/60',
          'transition-all duration-300',
          isScrolled ? 'shadow-zen-sm' : 'shadow-none',
        ].join(' ')}
      >
        <div className="max-w-screen-xl mx-auto h-full px-4 md:px-6 flex items-center gap-4">

          {/* ── Brand */}
          <Link
            href="/"
            id="header-brand-link"
            className="flex items-center gap-2.5 flex-shrink-0 group"
            aria-label="ServiceNow Knowledge Hub — Home"
          >
            <span className="transition-transform duration-300 group-hover:scale-110">
              <MatchaLeaf />
            </span>
            <span className="font-serif font-medium text-[0.92rem] tracking-wide text-ink-700 dark:text-sage-200 leading-none">
              <span className="text-matcha-500 dark:text-matcha-400">SN</span>
              {' '}Academy
            </span>
          </Link>

          {/* ── Desktop Nav Links */}
          <nav
            className="hidden md:flex items-center gap-1 ml-4"
            aria-label="Primary navigation"
          >
            {NAV_LINKS.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                id={`header-nav-${label.toLowerCase()}`}
                className={[
                  'px-3 py-1.5 rounded-zen text-[0.83rem] font-medium',
                  'transition-all duration-200',
                  isActive(href)
                    ? 'bg-matcha-100/80 dark:bg-matcha-700/30 text-matcha-500 dark:text-matcha-300'
                    : 'text-ink-500 dark:text-sage-300 hover:bg-rice-paper-300/70 dark:hover:bg-tea-slate-200/50 hover:text-ink-700 dark:hover:text-sage-100',
                ].join(' ')}
              >
                {label}
              </Link>
            ))}
          </nav>

          {/* ── Spacer */}
          <div className="flex-1" />

          {/* ── Search Bar */}
          <div className="relative hidden md:flex items-center">
            <div
              className={[
                'flex items-center gap-2 rounded-zen',
                'border border-rice-paper-400/80 dark:border-tea-slate-50/70',
                'bg-rice-paper-200/70 dark:bg-tea-slate-300/70',
                'transition-all duration-300',
                searchOpen ? 'w-52' : 'w-36',
              ].join(' ')}
            >
              <button
                id="header-search-toggle"
                type="button"
                onClick={() => setSearchOpen(v => !v)}
                className="p-2 text-ink-400 dark:text-sage-400 hover:text-matcha-500 dark:hover:text-matcha-300 transition-colors"
                aria-label="Toggle search"
              >
                <SearchIcon />
              </button>
              <input
                id="header-search-input"
                type="search"
                placeholder="Search…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className={[
                  'bg-transparent text-[0.82rem] text-ink-700 dark:text-sage-200',
                  'placeholder:text-ink-300 dark:placeholder:text-sage-500',
                  'outline-none border-none pr-2 w-full',
                  'transition-all duration-300',
                  searchOpen ? 'opacity-100' : 'opacity-0 pointer-events-none',
                ].join(' ')}
                aria-label="Search knowledge base"
              />
            </div>
          </div>

          {/* ── Dark Mode Toggle */}
          <button
            id="header-theme-toggle"
            type="button"
            onClick={toggleDark}
            className={[
              'w-8 h-8 flex items-center justify-center rounded-zen',
              'text-ink-400 dark:text-sage-400',
              'hover:bg-rice-paper-300/70 dark:hover:bg-tea-slate-200/50',
              'hover:text-matcha-500 dark:hover:text-matcha-300',
              'transition-all duration-200',
            ].join(' ')}
            aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            title={isDark ? 'Light mode' : 'Dark mode'}
          >
            <span
              className="transition-all duration-300"
              style={{ display: 'flex', alignItems: 'center' }}
            >
              {isDark ? <SunIcon /> : <MoonIcon />}
            </span>
          </button>

          {/* ── Mobile Menu Button */}
          <button
            id="header-menu-toggle"
            type="button"
            onClick={onMenuToggle}
            className={[
              'md:hidden w-8 h-8 flex items-center justify-center rounded-zen',
              'text-ink-500 dark:text-sage-400',
              'hover:bg-rice-paper-300/70 dark:hover:bg-tea-slate-200/50',
              'transition-colors duration-200',
            ].join(' ')}
            aria-label={isMenuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={isMenuOpen}
          >
            {isMenuOpen ? <CloseIcon /> : <MenuIcon />}
          </button>
        </div>
      </header>

      {/* ── Mobile Menu Drawer */}
      <div
        id="header-mobile-menu"
        className={[
          'fixed inset-0 z-40 md:hidden',
          'transition-all duration-300',
          isMenuOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
        ].join(' ')}
        aria-hidden={!isMenuOpen}
      >
        {/* Backdrop */}
        <div
          className="absolute inset-0 bg-ink-700/20 dark:bg-black/40 backdrop-blur-sm"
          onClick={onMenuToggle}
        />

        {/* Drawer panel */}
        <nav
          className={[
            'absolute top-14 left-0 right-0',
            'bg-rice-paper-100/98 dark:bg-tea-slate-300/98',
            'border-b border-rice-paper-400/60 dark:border-tea-slate-50/60',
            'px-4 py-3 flex flex-col gap-1',
            'transition-transform duration-300 ease-out',
            isMenuOpen ? 'translate-y-0' : '-translate-y-2',
          ].join(' ')}
          aria-label="Mobile navigation"
        >
          {/* Mobile search */}
          <div className="flex items-center gap-2 mb-2 px-2 py-2 rounded-zen border border-rice-paper-400/70 dark:border-tea-slate-50/60 bg-rice-paper-200/60 dark:bg-tea-slate-400/60">
            <SearchIcon />
            <input
              id="header-mobile-search"
              type="search"
              placeholder="Search knowledge base…"
              className="flex-1 bg-transparent text-[0.85rem] text-ink-700 dark:text-sage-200 placeholder:text-ink-300 dark:placeholder:text-sage-500 outline-none"
            />
          </div>

          {NAV_LINKS.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              onClick={onMenuToggle}
              className={[
                'px-3 py-2.5 rounded-zen text-[0.9rem] font-medium',
                'transition-colors duration-200',
                isActive(href)
                  ? 'bg-matcha-100/80 dark:bg-matcha-700/30 text-matcha-500 dark:text-matcha-300'
                  : 'text-ink-600 dark:text-sage-300 hover:bg-rice-paper-300/70 dark:hover:bg-tea-slate-200/50',
              ].join(' ')}
            >
              {label}
            </Link>
          ))}
        </nav>
      </div>
    </>
  )
}
