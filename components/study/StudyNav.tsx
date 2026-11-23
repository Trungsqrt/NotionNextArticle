'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { SafeStudyUser } from '../../lib/study/types'
import StudySignOutButton from './StudySignOutButton'

const STUDY_TABS = [
  { href: '/study', label: 'Dashboard' },
  { href: '/study/flashcards', label: 'Active Recall' },
  { href: '/study/practice', label: 'Practice' },
  { href: '/study/exams', label: 'Mock Exams' },
]

export default function StudyNav({ user }: { user: SafeStudyUser }) {
  const pathname = usePathname() || '/study'

  const isActive = (href: string) =>
    href === '/study' ? pathname === '/study' : pathname.startsWith(href)

  return (
    <header className="border-b border-rice-paper-400/70 dark:border-tea-slate-50/50 bg-rice-paper-50/70 dark:bg-tea-slate-200/40">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-2 text-[0.7rem] uppercase tracking-[0.22em] font-medium text-matcha-600 dark:text-matcha-400">
            <span className="w-1.5 h-1.5 rounded-full bg-matcha-500 dark:bg-matcha-400" aria-hidden="true" />
            Study Room
          </span>
          <nav aria-label="Study Room navigation" className="flex flex-wrap items-center gap-1">
            {STUDY_TABS.map((tab) => {
              const active = isActive(tab.href)
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  aria-current={active ? 'page' : undefined}
                  className={[
                    'px-3 py-1.5 rounded-zen text-[0.82rem] font-medium no-underline',
                    'transition-colors duration-200 ease-zen motion-reduce:transition-none',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-matcha-500/60',
                    active
                      ? 'bg-matcha-100/85 dark:bg-matcha-900/45 text-matcha-700 dark:text-matcha-300 border border-matcha-300/60 dark:border-matcha-700/50'
                      : 'text-ink-500 dark:text-sage-400 border border-transparent hover:bg-rice-paper-200/70 dark:hover:bg-tea-slate-100/50 hover:text-ink-700 dark:hover:text-sage-100',
                  ].join(' ')}
                >
                  {tab.label}
                </Link>
              )
            })}
          </nav>
        </div>

        <div className="flex items-center justify-between sm:justify-end gap-3">
          <div className="flex items-center gap-2 text-[0.78rem] text-ink-500 dark:text-sage-400">
            <span className="font-medium text-ink-700 dark:text-sage-200">{user.username}</span>
            <span className="px-2 py-0.5 rounded-pill text-[0.66rem] uppercase tracking-wider bg-rice-paper-200 dark:bg-tea-slate-100 text-ink-500 dark:text-sage-300 border border-rice-paper-400/70 dark:border-tea-slate-50/50">
              {user.role}
            </span>
          </div>
          <StudySignOutButton />
        </div>
      </div>
    </header>
  )
}
