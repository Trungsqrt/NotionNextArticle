'use client'

/**
 * Layout.tsx — Master page layout wrapper
 * ────────────────────────────────────────
 * Composes Header + optional Sidebar + main content area.
 */

import { useState, useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import Header from './Header'
import Sidebar, { type SidebarModule, type SidebarTocEntry } from './Sidebar'
import ReadingProgress from './ReadingProgress'

export interface LayoutProps {
  children: ReactNode
  showSidebar?: boolean
  tableOfContents?: SidebarTocEntry[]
  modules?: SidebarModule[]
  currentSlug?: string
  completedLessons?: number
  totalLessons?: number
}

const SITE_NAME = process.env.NEXT_PUBLIC_SITE_NAME || 'ServiceNow Knowledge Hub'

export default function Layout({
  children,
  showSidebar = true,
  tableOfContents = [],
  modules = [],
  currentSlug = '',
  completedLessons = 0,
  totalLessons = 0,
}: LayoutProps) {
  const pathname = usePathname() || ''
  const isHomePage = pathname === '/'
  const isContactPage = pathname === '/contact'
  const isStudyPage = pathname === '/study' || pathname.startsWith('/study/')
  const shouldShowSidebar = showSidebar && !isHomePage && !isContactPage && !isStudyPage

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)

  // ── Auto-append source attribution when copying non-code text ──────────────
  useEffect(() => {
    function handleCopy(e: ClipboardEvent) {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed) return

      const isInsideCode = (node: Node | null): boolean => {
        if (!node) return false
        const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
        return Boolean(
          el?.closest('pre, code, .notion-code-block, [data-notion-component="NotionCodeBlock"], .notion-inline-code')
        )
      }

      if (isInsideCode(selection.anchorNode) || isInsideCode(selection.focusNode)) {
        return
      }

      const text = selection.toString().trim()
      if (!text) return

      const fullText = selection.toString() + '\n\n— Jun Mai - Trungsqrt · ServiceNow Knowledge Hub'

      if (e.clipboardData) {
        e.preventDefault()
        e.clipboardData.setData('text/plain', fullText)
      }
    }

    document.addEventListener('copy', handleCopy)
    return () => document.removeEventListener('copy', handleCopy)
  }, [])

  return (
    <>
      {/* ── Outermost shell */}
      <div className="min-h-screen bg-rice-paper-100 dark:bg-tea-slate-300 text-ink-700 dark:text-sage-200 transition-colors duration-300 flex flex-col">
        {/* ── Fixed Header (always visible) */}
        <Header onMenuToggle={() => setMobileMenuOpen((v) => !v)} isMenuOpen={mobileMenuOpen} />

        {/* ── Reading progress bar + back-to-top */}
        <ReadingProgress />

        {/* ── Below-header layout: Sidebar + Main */}
        <div className="flex pt-14 min-h-[calc(100vh-3.5rem)] flex-1">
          {/* ── Left Sidebar */}
          {shouldShowSidebar && (
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
            className={['flex-1 flex flex-col min-w-0 w-full', 'transition-all duration-300'].join(' ')}
            tabIndex={-1}
          >
            {/* Mobile sidebar toggle button (shown when sidebar exists) */}
            {shouldShowSidebar && (
              <button
                id="mobile-sidebar-toggle"
                type="button"
                onClick={() => setMobileSidebarOpen((v) => !v)}
                className={[
                  'fixed bottom-6 left-4 z-20 md:hidden',
                  'flex items-center gap-2 px-3 py-2.5 rounded-pill',
                  'bg-matcha-500 dark:bg-matcha-700 text-white',
                  'shadow-matcha text-[0.78rem] font-medium',
                  'transition-transform duration-200 hover:scale-105 active:scale-95',
                ].join(' ')}
                aria-label="Toggle sidebar navigation"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <rect x="3" y="3" width="7" height="18" rx="1" />
                  <path d="M14 7h7M14 12h7M14 17h7" />
                </svg>
                Contents
              </button>
            )}

            {/* ── Page content */}
            <div className="flex-1 animate-fade-in">{children}</div>

            {/* ── In-Content Minimal Footer */}
            <footer
              id="site-footer"
              className="mt-16 py-8 border-t border-rice-paper-400/60 dark:border-tea-slate-50/40 text-center text-xs text-ink-400 dark:text-sage-500"
            >
              <div className="max-w-screen-xl mx-auto flex flex-col md:flex-row items-center justify-between gap-3 px-6">
                <div className="flex items-center gap-2 text-[0.78rem]">
                  <span className="text-matcha-400">✦</span>
                  <span>{SITE_NAME}</span>
                  <span className="text-rice-paper-500 dark:text-tea-slate-50">·</span>
                  <span>Built with calm intention</span>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[0.74rem]">
                  <nav aria-label="Footer links" className="flex items-center gap-4">
                    <Link
                      href="/contact"
                      className="text-ink-500 dark:text-sage-400 hover:text-matcha-600 dark:hover:text-matcha-300 transition-colors duration-200 motion-reduce:transition-none no-underline"
                    >
                      Contact
                    </Link>
                    <a
                      href="https://github.com/Trungsqrt"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-ink-500 dark:text-sage-400 hover:text-matcha-600 dark:hover:text-matcha-300 transition-colors duration-200 motion-reduce:transition-none no-underline"
                    >
                      GitHub
                    </a>
                    <a
                      href="https://www.linkedin.com/in/trung-mai-quang-05490a217"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-ink-500 dark:text-sage-400 hover:text-matcha-600 dark:hover:text-matcha-300 transition-colors duration-200 motion-reduce:transition-none no-underline"
                    >
                      LinkedIn
                    </a>
                  </nav>
                  <span className="hidden sm:inline text-rice-paper-500 dark:text-tea-slate-50" aria-hidden="true">
                    ·
                  </span>
                  <p className="text-[0.72rem] text-ink-300 dark:text-sage-600 m-0">
                    Curated by Jun Mai - Trungsqrt
                  </p>
                </div>
              </div>
            </footer>
          </main>
        </div>
      </div>
    </>
  )
}
