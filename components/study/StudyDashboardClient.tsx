'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { StudyDashboardCatalog } from '../../lib/study/services/dashboard-service'
import {
  computeDashboardOverview,
  type MockExamCollectionStatus,
  type PracticeCollectionStatus,
} from '../../lib/study/local-progress'
import { StudyLink } from './StudyNavigationContext'
import { StudyDashboardSkeleton, ZenPendingDot } from './StudySkeletons'

type DashboardStatus = 'loading' | 'refreshing' | 'error' | 'loaded'

function StatCard({
  label,
  value,
  sublabel,
  accent = false,
}: {
  label: string
  value: string | number
  sublabel?: string
  accent?: boolean
}) {
  return (
    <div className="rounded-card p-5 bg-rice-paper-50/90 dark:bg-tea-slate-200/65 border border-rice-paper-400/70 dark:border-tea-slate-50/50 shadow-zen-sm">
      <p className="text-[0.72rem] uppercase tracking-[0.16em] font-medium text-ink-400 dark:text-sage-500 m-0">
        {label}
      </p>
      <p
        className={`font-serif text-3xl font-medium tabular-nums mt-2 mb-0 ${
          accent
            ? 'text-matcha-600 dark:text-matcha-300'
            : 'text-ink-700 dark:text-sage-100'
        }`}
      >
        {value}
      </p>
      {sublabel && (
        <p className="text-[0.76rem] text-ink-400 dark:text-sage-500 mt-1 mb-0">
          {sublabel}
        </p>
      )}
    </div>
  )
}

function practiceStatusBadge(status: PracticeCollectionStatus): {
  label: string
  className: string
} {
  if (status === 'completed') {
    return {
      label: 'Completed',
      className:
        'bg-matcha-100/85 dark:bg-matcha-900/45 text-matcha-700 dark:text-matcha-300 border-matcha-300/70 dark:border-matcha-700/60',
    }
  }
  if (status === 'in_progress') {
    return {
      label: 'In Progress',
      className:
        'bg-rice-paper-200/90 dark:bg-tea-slate-100/80 text-ink-700 dark:text-sage-200 border-earth-beige/80 dark:border-tea-slate-50/70',
    }
  }
  return {
    label: 'Not Started',
    className:
      'bg-rice-paper-200/60 dark:bg-tea-slate-300/60 text-ink-400 dark:text-sage-400 border-rice-paper-400/60 dark:border-tea-slate-50/40',
  }
}

function examStatusBadge(status: MockExamCollectionStatus): {
  label: string
  className: string
} {
  if (status === 'passed') {
    return {
      label: 'Passed',
      className:
        'bg-matcha-100/85 dark:bg-matcha-900/45 text-matcha-700 dark:text-matcha-300 border-matcha-300/70 dark:border-matcha-700/60',
    }
  }
  if (status === 'not_passed') {
    return {
      label: 'Not Passed',
      className:
        'bg-earth-rust/[0.10] dark:bg-earth-rust/[0.20] text-[#7A4932] dark:text-[#E2BBA2] border-earth-rust/40 dark:border-earth-rust/55',
    }
  }
  return {
    label: 'Not Attempted',
    className:
      'bg-rice-paper-200/60 dark:bg-tea-slate-300/60 text-ink-400 dark:text-sage-400 border-rice-paper-400/60 dark:border-tea-slate-50/40',
  }
}

export default function StudyDashboardClient({
  userId,
  initialCatalog,
}: {
  userId: string
  initialCatalog: StudyDashboardCatalog | null
}) {
  const [catalog, setCatalog] = useState<StudyDashboardCatalog | null>(initialCatalog)
  const [status, setStatus] = useState<DashboardStatus>(
    initialCatalog ? 'loaded' : 'loading'
  )
  const [error, setError] = useState('')
  const [storageReady, setStorageReady] = useState(false)
  const [storageVersion, setStorageVersion] = useState(0)

  const catalogRef = useRef<StudyDashboardCatalog | null>(initialCatalog)
  const abortRef = useRef<AbortController | null>(null)
  const seqRef = useRef(0)

  const loadCatalog = useCallback(async () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const seq = ++seqRef.current

    setStatus(catalogRef.current ? 'refreshing' : 'loading')
    setError('')

    try {
      const res = await fetch('/api/study/dashboard', {
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!res.ok) {
        throw new Error('Unable to load your exam collections.')
      }
      const json = (await res.json()) as StudyDashboardCatalog
      if (seq !== seqRef.current) return
      catalogRef.current = json
      setCatalog(json)
      setStatus('loaded')
    } catch (err) {
      if (controller.signal.aborted || seq !== seqRef.current) return
      setError(err instanceof Error ? err.message : 'Unable to load dashboard.')
      setStatus(catalogRef.current ? 'loaded' : 'error')
    }
  }, [])

  // Hydrate browser-local progress after mount and listen for cross-tab storage updates
  useEffect(() => {
    setStorageReady(true)
    function onStorage() {
      setStorageVersion((v) => v + 1)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // Fetch catalog only if SSR initial load failed
  useEffect(() => {
    if (!initialCatalog) {
      loadCatalog()
    }
    return () => {
      abortRef.current?.abort()
      seqRef.current += 1
    }
  }, [initialCatalog, loadCatalog])

  const overview = useMemo(() => {
    if (!catalog) return null
    // Reference storageVersion so cross-tab updates recompute cleanly
    void storageVersion
    if (!storageReady) {
      return computeDashboardOverview(userId, catalog.exams, null)
    }
    return computeDashboardOverview(userId, catalog.exams)
  }, [catalog, userId, storageReady, storageVersion])

  if (status === 'loading' && !catalog) {
    return <StudyDashboardSkeleton />
  }

  if ((status === 'error' || !catalog || !overview) && !catalog) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10 animate-study-feedback">
        <div
          role="alert"
          className="rounded-card p-6 bg-rose-50/70 dark:bg-rose-950/30 border border-earth-rust/40 dark:border-rose-400/40 text-earth-rust dark:text-rose-200 text-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4"
        >
          <span>{error || 'Dashboard data is currently unavailable.'}</span>
          <button
            type="button"
            onClick={loadCatalog}
            className="self-start sm:self-auto px-4 py-2 rounded-zen text-xs font-medium bg-rice-paper-50 dark:bg-tea-slate-200 text-ink-700 dark:text-sage-100 border border-earth-rust/40 dark:border-rose-400/40 hover:border-matcha-500 transition-colors duration-150 motion-reduce:transition-none shrink-0"
          >
            Try Again
          </button>
        </div>
      </div>
    )
  }

  if (!overview) return null
  const isRefreshing = status === 'refreshing'

  return (
    <div
      className="max-w-5xl mx-auto px-4 sm:px-6 py-10 space-y-10 animate-study-feedback"
      aria-busy={isRefreshing || undefined}
    >
      {/* ── Top Heading + Primary CTAs ── */}
      <section className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-serif font-medium text-2xl sm:text-3xl text-ink-700 dark:text-sage-100 m-0">
              Study Overview
            </h1>
            {isRefreshing && (
              <span
                role="status"
                aria-live="polite"
                className="inline-flex items-center gap-1.5 text-xs text-matcha-600 dark:text-matcha-400"
              >
                <ZenPendingDot />
                Refreshing…
              </span>
            )}
          </div>
          <p className="text-[0.9rem] text-ink-500 dark:text-sage-400 mt-1.5 mb-0">
            Track your Practice Mode progress, server-graded CSA Mock Exams, and bookmarked Active Recall reviews.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <StudyLink
            href="/study/practice"
            className="px-4 py-2 rounded-zen text-[0.84rem] font-medium bg-matcha-500 hover:bg-matcha-600 dark:bg-matcha-600 dark:hover:bg-matcha-500 text-white shadow-zen-sm no-underline transition-colors duration-200 motion-reduce:transition-none"
          >
            Open Practice Mode
          </StudyLink>
          <StudyLink
            href="/study/exams"
            className="px-4 py-2 rounded-zen text-[0.84rem] font-medium text-ink-700 dark:text-sage-200 bg-rice-paper-50 dark:bg-tea-slate-200 border border-rice-paper-400/80 dark:border-tea-slate-50/60 hover:border-matcha-400/70 no-underline transition-colors duration-200 motion-reduce:transition-none"
          >
            Take Mock Exam
          </StudyLink>
        </div>
      </section>

      {error && (
        <div
          role="alert"
          className="rounded-zen px-4 py-3 bg-rose-50/80 dark:bg-rose-950/30 border border-earth-rust/40 dark:border-rose-400/40 text-sm text-earth-rust dark:text-rose-200 flex items-center justify-between gap-3"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={loadCatalog}
            disabled={isRefreshing}
            className="px-3 py-1 rounded-zen text-xs font-medium bg-rice-paper-50 dark:bg-tea-slate-200 text-ink-700 dark:text-sage-100 border border-earth-rust/40 dark:border-rose-400/40 disabled:opacity-50 shrink-0"
          >
            Retry
          </button>
        </div>
      )}

      {/* ── Core Practice & Mock Exam Metrics ── */}
      <section aria-label="Study metrics" className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Completed Practice"
          value={`${overview.completedPracticeCount}/${overview.totalCollections}`}
          sublabel="Practice collections"
          accent
        />
        <StatCard
          label="Completed Mock Exams"
          value={`${overview.completedMockExamCount}/${overview.totalCollections}`}
          sublabel="Server-graded exams"
        />
        <StatCard
          label="Latest Practice Accuracy"
          value={
            overview.latestPracticeAccuracy !== null
              ? `${overview.latestPracticeAccuracy}%`
              : '—'
          }
          sublabel={
            overview.latestPracticeAccuracy !== null
              ? 'Most recent practice'
              : 'No practice graded yet'
          }
        />
        <StatCard
          label="Best Exam Score"
          value={overview.bestExamScore !== null ? `${overview.bestExamScore}%` : '—'}
          sublabel={
            overview.bestExamScore !== null
              ? 'Highest graded simulation'
              : 'No mock exam submitted yet'
          }
        />
      </section>

      {/* ── Exam Collections: Practice Progress & Mock Exam Progress ── */}
      <section className="space-y-4">
        <h2 className="font-serif text-lg font-medium text-ink-700 dark:text-sage-100 m-0">
          Exam Collections
        </h2>
        {overview.exams.length === 0 ? (
          <div className="rounded-card p-8 text-center bg-rice-paper-50/70 dark:bg-tea-slate-200/40 border border-rice-paper-400/60 dark:border-tea-slate-50/40 text-sm text-ink-400 dark:text-sage-500">
            No published exam collections found yet. Import your question bank to begin studying.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {overview.exams.map(({ exam, practice, mockExam }) => {
              const pBadge = practiceStatusBadge(practice.status)
              const eBadge = examStatusBadge(mockExam.status)

              return (
                <article
                  key={exam.examId}
                  className="rounded-card p-5 sm:p-6 bg-rice-paper-50/90 dark:bg-tea-slate-200/65 border border-rice-paper-400/70 dark:border-tea-slate-50/50 shadow-zen-sm flex flex-col justify-between gap-5"
                >
                  <div>
                    <span className="text-[0.68rem] uppercase tracking-[0.16em] text-matcha-600 dark:text-matcha-400 font-medium">
                      {exam.certificationCategory} · {exam.questionCount} questions
                    </span>
                    <h3 className="font-serif text-base sm:text-lg font-medium text-ink-700 dark:text-sage-100 mt-1 mb-0">
                      {exam.title}
                    </h3>
                  </div>

                  {/* Practice Progress */}
                  <div className="space-y-2.5 pt-3 border-t border-rice-paper-400/50 dark:border-tea-slate-50/40">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[0.72rem] uppercase tracking-[0.14em] font-medium text-ink-400 dark:text-sage-500">
                        Practice Progress
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded-pill text-[0.68rem] font-medium border ${pBadge.className}`}
                      >
                        {pBadge.label}
                      </span>
                    </div>

                    <div className="w-full h-1.5 rounded-pill bg-rice-paper-300 dark:bg-tea-slate-100 overflow-hidden">
                      <div
                        className="h-full bg-matcha-500 dark:bg-matcha-400 transition-all duration-300 motion-reduce:transition-none"
                        style={{ width: `${practice.progressPercent}%` }}
                      />
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 text-[0.78rem] text-ink-500 dark:text-sage-400">
                      <span className="font-mono text-xs tabular-nums">
                        {practice.checkedCount}/{practice.totalQuestions} checked
                        {practice.accuracyPercent !== null && (
                          <> · {practice.accuracyPercent}% accuracy</>
                        )}
                      </span>
                      <StudyLink
                        href={`/study/practice?examId=${encodeURIComponent(exam.examId)}`}
                        className="text-xs font-medium text-matcha-600 dark:text-matcha-300 hover:underline no-underline"
                      >
                        {practice.actionLabel} →
                      </StudyLink>
                    </div>
                  </div>

                  {/* Mock Exam Progress */}
                  <div className="space-y-2.5 pt-3 border-t border-rice-paper-400/50 dark:border-tea-slate-50/40">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[0.72rem] uppercase tracking-[0.14em] font-medium text-ink-400 dark:text-sage-500">
                        Mock Exam Progress
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded-pill text-[0.68rem] font-medium border ${eBadge.className}`}
                      >
                        {eBadge.label}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 text-[0.78rem] text-ink-500 dark:text-sage-400">
                      <span className="font-mono text-xs tabular-nums">
                        {mockExam.latestScorePercent !== null ? (
                          <>
                            Latest: <strong className="text-ink-700 dark:text-sage-100">{mockExam.latestScorePercent}%</strong>
                            {' · '}
                            Best: <strong className="text-ink-700 dark:text-sage-100">{mockExam.bestScorePercent}%</strong>
                          </>
                        ) : (
                          'No submitted attempt yet'
                        )}
                      </span>
                      <StudyLink
                        href={`/study/exams/${encodeURIComponent(exam.examId)}`}
                        className="text-xs font-medium text-ink-700 dark:text-sage-200 hover:text-matcha-600 dark:hover:text-matcha-300 hover:underline no-underline"
                      >
                        Start Exam →
                      </StudyLink>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>

      {/* ── Sync & Storage Scope Note ── */}
      <p className="text-[0.76rem] text-ink-400 dark:text-sage-500 m-0 pt-2 border-t border-rice-paper-400/50 dark:border-tea-slate-50/35">
        Bookmarks synchronize with your account through Notion across devices. Practice progress and mock exam summaries remain stored locally in this browser.
      </p>
    </div>
  )
}
