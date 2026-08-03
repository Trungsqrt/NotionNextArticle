/**
 * Layout.js — Master page layout wrapper
 * ────────────────────────────────────────
 * Composes Header + optional Sidebar + main content area.
 * Used as a wrapper in every page that renders Notion content.
 *
 * Props:
 *   children         — React children (e.g. <NotionRenderer />)
 *   showSidebar      — Bool: show the sidebar (default: true)
 *   tableOfContents  — Array: passed through to <Sidebar />
 *   modules          — Array: passed through to <Sidebar />
 *   currentSlug      — String: passed through to <Sidebar />
 *   completedLessons — Number
 *   totalLessons     — Number
 *   pageTitle        — String: for <head> title tag
 *   pageDescription  — String: for <head> meta description
 *
 * IMPORTANT: Does NOT modify any NotionNext data props or recordMap.
 */

import { useState } from 'react'
import Head from 'next/head'
import Header from './Header'
import Sidebar from './Sidebar'

const SITE_NAME = process.env.NEXT_PUBLIC_SITE_NAME || 'ServiceNow Knowledge Hub'
const SITE_DESCRIPTION = process.env.NEXT_PUBLIC_SITE_DESCRIPTION || 'A serene learning space for mastering ServiceNow.'

export default function Layout({
  children,
  showSidebar = true,
  tableOfContents = [],
  modules = [],
  currentSlug = '',
  completedLessons = 0,
  totalLessons = 0,
  pageTitle = '',
  pageDescription = '',
}) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)

  const headTitle = pageTitle
    ? `${pageTitle} · ${SITE_NAME}`
    : SITE_NAME

  const headDescription = pageDescription || SITE_DESCRIPTION

  return (
    <>
      {/* ── SEO Head */}
      <Head>
        <title>{headTitle}</title>
        <meta name="description" content={headDescription} />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta charSet="utf-8" />
        {/* Open Graph */}
        <meta property="og:title" content={headTitle} />
        <meta property="og:description" content={headDescription} />
        <meta property="og:type" content="website" />
        {/* Theme color for browser chrome */}
        <meta name="theme-color" content="#FAF8F5" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#1A1B18" media="(prefers-color-scheme: dark)" />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      {/* ── Outermost shell */}
      <div className="min-h-screen bg-rice-paper-100 dark:bg-tea-slate-300 text-ink-700 dark:text-sage-200 transition-colors duration-300">

        {/* ── Fixed Header (always visible) */}
        <Header
          onMenuToggle={() => setMobileMenuOpen(v => !v)}
          isMenuOpen={mobileMenuOpen}
        />

        {/* ── Below-header layout: Sidebar + Main */}
        <div className="flex pt-14 min-h-[calc(100vh-3.5rem)]">

          {/* ── Left Sidebar */}
          {showSidebar && (
            <Sidebar
              tableOfContents={tableOfContents}
              modules={modules}
              currentSlug={currentSlug}
              completedLessons={completedLessons}
              totalLessons={totalLessons}
              isOpen={mobileSidebarOpen}
              onClose={() => setMobileSidebarOpen(false)}
            />
          )}

          {/* ── Main content area */}
          <main
            id="main-content"
            className={[
              'flex-1 min-w-0 w-full',
              'transition-all duration-300',
            ].join(' ')}
            // Skip-to-main landmark for a11y
            tabIndex={-1}
          >
            {/* Mobile sidebar toggle button (shown when sidebar exists) */}
            {showSidebar && (
              <button
                id="mobile-sidebar-toggle"
                type="button"
                onClick={() => setMobileSidebarOpen(v => !v)}
                className={[
                  'fixed bottom-6 left-4 z-20 md:hidden',
                  'flex items-center gap-2 px-3 py-2.5 rounded-pill',
                  'bg-matcha-500 dark:bg-matcha-700 text-white',
                  'shadow-matcha text-[0.78rem] font-medium',
                  'transition-transform duration-200 hover:scale-105 active:scale-95',
                ].join(' ')}
                aria-label="Toggle sidebar navigation"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
                  aria-hidden="true">
                  <rect x="3" y="3" width="7" height="18" rx="1" />
                  <path d="M14 7h7M14 12h7M14 17h7" />
                </svg>
                Contents
              </button>
            )}

            {/* ── Page content */}
            <div className="animate-fade-in">
              {children}
            </div>
          </main>
        </div>

        {/* ── Footer */}
        <footer
          id="site-footer"
          className="border-t border-rice-paper-400/60 dark:border-tea-slate-50/40 py-8 px-6 mt-auto"
        >
          <div className="max-w-screen-xl mx-auto flex flex-col md:flex-row items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[0.78rem] text-ink-400 dark:text-sage-500">
              <span className="text-matcha-400">✦</span>
              <span>{SITE_NAME}</span>
              <span className="text-rice-paper-500 dark:text-tea-slate-50">·</span>
              <span>Built with calm intention</span>
            </div>
            <p className="text-[0.72rem] text-ink-300 dark:text-sage-600">
              Powered by Notion & Next.js · Wabi-Sabi theme
            </p>
          </div>
        </footer>
      </div>
    </>
  )
}
