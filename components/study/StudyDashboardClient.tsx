'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { StudyDashboardData } from '../../lib/study/services/dashboard-service'

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
        className={`font-serif text-3xl font-medium mt-2 mb-0 ${
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

function formatShortDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

export default function StudyDashboardClient() {
  const [data, setData] = useState<StudyDashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    async function load() {
      setLoading(true)
      setError('')
      try {
        const res = await fetch('/api/study/dashboard', { cache: 'no-store' })
        if (!res.ok) {
          throw new Error('Unable to load your study progress.')
        }
        const json = (await res.json()) as StudyDashboardData
        if (active) setData(json)
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : 'Unable to load dashboard.')
        }
      } finally {
        if (active) setLoading(false)
      }
    }
    load()
    return () => {
      active = false
    }
  }, [])

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10 space-y-6" aria-busy="true">
        <div className="h-8 w-56 rounded-zen bg-rice-paper-300/70 dark:bg-tea-slate-200/70" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((n) => (
            <div
              key={n}
              className="h-28 rounded-card bg-rice-paper-200/70 dark:bg-tea-slate-200/50 border border-rice-paper-400/50 dark:border-tea-slate-50/30"
            />
          ))}
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10">
        <div
          role="alert"
          className="rounded-card p-6 bg-rose-50/70 dark:bg-rose-950/30 border border-earth-rust/40 dark:border-rose-400/40 text-earth-rust dark:text-rose-200 text-sm"
        >
          {error || 'Dashboard data is currently unavailable.'}
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10 space-y-10">
      {/* ── Top Heading + Primary CTA ── */}
      <section className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="font-serif font-medium text-2xl sm:text-3xl text-ink-700 dark:text-sage-100 m-0">
            Study Overview
          </h1>
          <p className="text-[0.9rem] text-ink-500 dark:text-sage-400 mt-1.5 mb-0">
            FSRS-6 spaced repetition (90% target retention), calm active recall, and CSA mock exams.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <Link
            href="/study/flashcards"
            className="px-4 py-2 rounded-zen text-[0.84rem] font-medium bg-matcha-500 hover:bg-matcha-600 dark:bg-matcha-600 dark:hover:bg-matcha-500 text-white shadow-zen-sm no-underline transition-colors duration-200 motion-reduce:transition-none"
          >
            Start Active Recall
          </Link>
          <Link
            href="/study/exams"
            className="px-4 py-2 rounded-zen text-[0.84rem] font-medium text-ink-700 dark:text-sage-200 bg-rice-paper-50 dark:bg-tea-slate-200 border border-rice-paper-400/80 dark:border-tea-slate-50/60 hover:border-matcha-400/70 no-underline transition-colors duration-200 motion-reduce:transition-none"
          >
            Take Mock Exam
          </Link>
        </div>
      </section>

      {/* ── Core Metrics ── */}
      <section aria-label="Study metrics" className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Due Today" value={data.dueToday} sublabel="Ready for recall" accent />
        <StatCard label="New Cards" value={data.newCards} sublabel="Not yet introduced" />
        <StatCard
          label="Cards Studied"
          value={data.totalCardsStudied}
          sublabel={`of ${data.totalPublishedQuestions} total`}
        />
        <StatCard
          label="Study Streak"
          value={`${data.studyStreakDays}d`}
          sublabel="Consecutive UTC days"
        />
      </section>

      {/* ── Upcoming Reviews ── */}
      <section className="rounded-card p-6 bg-rice-paper-50/90 dark:bg-tea-slate-200/60 border border-rice-paper-400/70 dark:border-tea-slate-50/50">
        <h2 className="font-serif text-lg font-medium text-ink-700 dark:text-sage-100 mt-0 mb-4">
          Upcoming Reviews
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
          {[
            { label: 'Tomorrow', count: data.upcomingReviews.tomorrow },
            { label: 'Next 3 Days', count: data.upcomingReviews.next3Days },
            { label: 'Next 7 Days', count: data.upcomingReviews.next7Days },
            { label: 'Later', count: data.upcomingReviews.later },
          ].map((b) => (
            <div
              key={b.label}
              className="rounded-zen py-3 px-4 bg-rice-paper-200/60 dark:bg-tea-slate-300/60 border border-rice-paper-400/50 dark:border-tea-slate-50/40"
            >
              <div className="font-serif text-xl font-medium text-ink-700 dark:text-sage-100">
                {b.count}
              </div>
              <div className="text-[0.74rem] text-ink-400 dark:text-sage-500 mt-0.5">
                {b.label}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Progress by Exam ── */}
      <section className="space-y-4">
        <h2 className="font-serif text-lg font-medium text-ink-700 dark:text-sage-100 m-0">
          Progress by Exam Collection
        </h2>
        {data.progressByExam.length === 0 ? (
          <div className="rounded-card p-8 text-center bg-rice-paper-50/70 dark:bg-tea-slate-200/40 border border-rice-paper-400/60 dark:border-tea-slate-50/40 text-sm text-ink-400 dark:text-sage-500">
            No published exam collections found yet. Import your question bank to begin studying.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {data.progressByExam.map((exam) => {
              const pct =
                exam.totalQuestions > 0
                  ? Math.round((exam.studiedCount / exam.totalQuestions) * 100)
                  : 0
              return (
                <div
                  key={exam.examId}
                  className="rounded-card p-5 bg-rice-paper-50/90 dark:bg-tea-slate-200/65 border border-rice-paper-400/70 dark:border-tea-slate-50/50 shadow-zen-sm flex flex-col gap-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <span className="text-[0.68rem] uppercase tracking-[0.16em] text-matcha-600 dark:text-matcha-400 font-medium">
                        {exam.certificationCategory}
                      </span>
                      <h3 className="font-serif text-base font-medium text-ink-700 dark:text-sage-100 mt-0.5 mb-0">
                        {exam.title}
                      </h3>
                    </div>
                    <span className="text-xs font-mono text-ink-500 dark:text-sage-400 shrink-0">
                      {exam.studiedCount}/{exam.totalQuestions}
                    </span>
                  </div>

                  <div className="w-full h-1.5 rounded-pill bg-rice-paper-300 dark:bg-tea-slate-100 overflow-hidden">
                    <div
                      className="h-full bg-matcha-500 dark:bg-matcha-400 transition-all duration-300 motion-reduce:transition-none"
                      style={{ width: `${pct}%` }}
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 text-[0.76rem] text-ink-400 dark:text-sage-500">
                    <span>
                      Due: <strong className="text-ink-600 dark:text-sage-200">{exam.dueCount}</strong> · Mastered:{' '}
                      <strong className="text-ink-600 dark:text-sage-200">{exam.masteredCount}</strong>
                    </span>
                    <div className="flex items-center gap-3">
                      <Link
                        href={`/study/flashcards?examId=${encodeURIComponent(exam.examId)}`}
                        className="text-matcha-600 dark:text-matcha-300 hover:underline no-underline font-medium"
                      >
                        Recall
                      </Link>
                      <Link
                        href={`/study/practice?examId=${encodeURIComponent(exam.examId)}`}
                        className="text-ink-600 dark:text-sage-300 hover:underline no-underline"
                      >
                        Practice
                      </Link>
                      <Link
                        href={`/study/exams/${encodeURIComponent(exam.examId)}`}
                        className="text-ink-600 dark:text-sage-300 hover:underline no-underline"
                      >
                        Exam
                      </Link>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* ── Progress by Topic ── */}
      {data.progressByTopic.length > 0 && (
        <section className="rounded-card p-6 bg-rice-paper-50/90 dark:bg-tea-slate-200/60 border border-rice-paper-400/70 dark:border-tea-slate-50/50">
          <h2 className="font-serif text-lg font-medium text-ink-700 dark:text-sage-100 mt-0 mb-4">
            Progress by Topic
          </h2>
          <div className="space-y-3">
            {data.progressByTopic.map((topic) => {
              const pct =
                topic.totalQuestions > 0
                  ? Math.round((topic.studiedCount / topic.totalQuestions) * 100)
                  : 0
              return (
                <div key={topic.topic} className="space-y-1">
                  <div className="flex items-center justify-between text-[0.84rem]">
                    <span className="text-ink-700 dark:text-sage-200 font-medium">{topic.topic}</span>
                    <span className="text-xs font-mono text-ink-400 dark:text-sage-400">
                      {topic.studiedCount}/{topic.totalQuestions} studied · {topic.dueCount} due
                    </span>
                  </div>
                  <div className="w-full h-1.5 rounded-pill bg-rice-paper-300 dark:bg-tea-slate-100 overflow-hidden">
                    <div
                      className="h-full bg-matcha-500/85 dark:bg-matcha-400/85"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* ── Recently Reviewed History ── */}
      <section className="rounded-card p-6 bg-rice-paper-50/90 dark:bg-tea-slate-200/60 border border-rice-paper-400/70 dark:border-tea-slate-50/50">
        <h2 className="font-serif text-lg font-medium text-ink-700 dark:text-sage-100 mt-0 mb-4">
          Recent Review History
        </h2>
        {data.recentlyReviewed.length === 0 ? (
          <p className="text-sm text-ink-400 dark:text-sage-500 m-0">
            No FSRS reviews recorded yet. Complete your first Active Recall card to start tracking memory retention.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-[0.82rem]">
              <thead>
                <tr className="border-b border-rice-paper-400/70 dark:border-tea-slate-50/50 text-ink-400 dark:text-sage-500 text-[0.72rem] uppercase tracking-wider">
                  <th className="py-2 pr-4 font-medium">Question</th>
                  <th className="py-2 pr-4 font-medium">Topic</th>
                  <th className="py-2 pr-4 font-medium">Rating</th>
                  <th className="py-2 pr-4 font-medium">State</th>
                  <th className="py-2 font-medium">Reviewed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rice-paper-400/40 dark:divide-tea-slate-50/30">
                {data.recentlyReviewed.map((ev) => (
                  <tr key={ev.eventId}>
                    <td className="py-2.5 pr-4 font-mono text-xs text-ink-600 dark:text-sage-300">
                      {ev.questionId}
                    </td>
                    <td className="py-2.5 pr-4 text-ink-600 dark:text-sage-300">{ev.topic}</td>
                    <td className="py-2.5 pr-4 capitalize font-medium text-matcha-600 dark:text-matcha-300">
                      {ev.rating}
                    </td>
                    <td className="py-2.5 pr-4 text-ink-500 dark:text-sage-400">
                      {ev.resultingState}
                    </td>
                    <td className="py-2.5 text-ink-400 dark:text-sage-500 whitespace-nowrap">
                      {formatShortDate(ev.reviewedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
