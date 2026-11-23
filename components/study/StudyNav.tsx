'use client'

import { usePathname } from 'next/navigation'
import type { SafeStudyUser } from '../../lib/study/types'
import {
  STUDY_NAV_TABS,
  getStudyRouteLabel,
  resolveStudyTabState,
} from '../../lib/study/navigation'
import { StudyLink, useStudyNavigation } from './StudyNavigationContext'
import { ZenPendingDot } from './StudySkeletons'
import StudySignOutButton from './StudySignOutButton'

export default function StudyNav({ user }: { user: SafeStudyUser }) {
  const pathname = usePathname() || '/study'
  const { pendingHref, isNavigating } = useStudyNavigation()

  // Defensive guard: never render Study Room navigation on the login screen
  if (pathname === '/study/login') {
    return null
  }

  const pendingLabel = isNavigating ? getStudyRouteLabel(pendingHref) : ''

  return (
    <header className="relative border-b border-rice-paper-400/70 dark:border-tea-slate-50/50 bg-rice-paper-50/75 dark:bg-tea-slate-200/45">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-2 text-[0.7rem] uppercase tracking-[0.22em] font-medium text-matcha-600 dark:text-matcha-400">
            <span
              className={[
                'w-1.5 h-1.5 rounded-full bg-matcha-500 dark:bg-matcha-400',
                isNavigating ? 'animate-zen-breathe' : '',
              ].join(' ')}
              aria-hidden="true"
            />
            Study Room
          </span>

          <nav aria-label="Study Room navigation" className="flex flex-wrap items-center gap-1">
            {STUDY_NAV_TABS.map((tab) => {
              const state = resolveStudyTabState({
                pathname,
                pendingHref,
                tabHref: tab.href,
              })
              const isPending = state === 'pending'

              return (
                <StudyLink
                  key={tab.href}
                  href={tab.href}
                  aria-current={state === 'active' ? 'page' : undefined}
                  aria-busy={isPending || undefined}
                  className={[
                    'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-zen text-[0.82rem] font-medium no-underline',
                    'transition-all duration-150 ease-zen motion-reduce:transition-none',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-matcha-500/60',
                    state === 'active'
                      ? 'bg-matcha-100/85 dark:bg-matcha-900/45 text-matcha-700 dark:text-matcha-300 border border-matcha-300/60 dark:border-matcha-700/50'
                      : state === 'pending'
                        ? 'bg-matcha-50/95 dark:bg-matcha-900/35 text-matcha-700 dark:text-matcha-200 border border-matcha-400/80 dark:border-matcha-500/65 shadow-zen-sm'
                        : state === 'active-leaving'
                          ? 'bg-matcha-100/45 dark:bg-matcha-900/20 text-matcha-600/75 dark:text-matcha-300/70 border border-matcha-300/35 dark:border-matcha-700/30'
                          : 'text-ink-500 dark:text-sage-400 border border-transparent hover:bg-rice-paper-200/70 dark:hover:bg-tea-slate-100/50 hover:text-ink-700 dark:hover:text-sage-100',
                  ].join(' ')}
                >
                  {isPending && (
                    <ZenPendingDot className="text-matcha-600 dark:text-matcha-400" />
                  )}
                  <span>{tab.label}</span>
                </StudyLink>
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

      {/* Subtle muted-sage navigation progress hairline */}
      <div
        aria-hidden="true"
        className={[
          'pointer-events-none absolute inset-x-0 bottom-0 h-[2px] overflow-hidden',
          'transition-opacity duration-200 ease-zen motion-reduce:transition-none',
          isNavigating ? 'opacity-100' : 'opacity-0',
        ].join(' ')}
      >
        {isNavigating && (
          <div
            key={pendingHref || 'nav'}
            className="h-full w-full bg-matcha-500/80 dark:bg-matcha-400/80 animate-zen-nav-bar"
          />
        )}
      </div>

      <span className="sr-only" role="status" aria-live="polite">
        {isNavigating ? `Loading ${pendingLabel}…` : ''}
      </span>
    </header>
  )
}
