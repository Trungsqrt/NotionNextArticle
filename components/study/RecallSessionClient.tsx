'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import type { StudyRating } from '../../lib/study/types'
import type {
  RecallQueueItem,
  RecallQueueResponse,
  RevealedRecallAnswer,
} from '../../lib/study/services/recall-service'
import StudyRichText from './StudyRichText'
import { StudyLink } from './StudyNavigationContext'
import { RecallSessionSkeleton, ZenPendingDot } from './StudySkeletons'
import { shouldIgnoreStudyShortcut } from '../../lib/study/keyboard'

type QueueStatus = 'loading' | 'refreshing' | 'error' | 'loaded'

function generateEventId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `rev-${crypto.randomUUID()}`
  }
  return `rev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

const RATING_BUTTONS: Array<{
  rating: StudyRating
  label: string
  shortcut: string
  className: string
}> = [
  {
    rating: 'again',
    label: 'Again',
    shortcut: '1',
    className:
      'border-earth-rust/50 text-earth-rust dark:text-rose-300 hover:bg-rose-50/70 dark:hover:bg-rose-950/30',
  },
  {
    rating: 'hard',
    label: 'Hard',
    shortcut: '2',
    className:
      'border-earth-beige text-ink-600 dark:text-sage-300 hover:bg-rice-paper-200/80 dark:hover:bg-tea-slate-100/60',
  },
  {
    rating: 'good',
    label: 'Good',
    shortcut: '3',
    className:
      'border-matcha-400/80 text-matcha-700 dark:text-matcha-300 bg-matcha-50/70 dark:bg-matcha-900/30 hover:bg-matcha-100/80 dark:hover:bg-matcha-900/50',
  },
  {
    rating: 'easy',
    label: 'Easy',
    shortcut: '4',
    className:
      'border-matcha-500/70 text-matcha-700 dark:text-matcha-200 hover:bg-matcha-100/60 dark:hover:bg-matcha-900/40',
  },
]

export default function RecallSessionClient() {
  const searchParams = useSearchParams()
  const examIdFilter = searchParams?.get('examId') || ''

  const [queue, setQueue] = useState<RecallQueueItem[]>([])
  const [counts, setCounts] = useState({ due: 0, newCards: 0 })
  const [currentIdx, setCurrentIdx] = useState(0)
  const [completedCount, setCompletedCount] = useState(0)

  const [showChoices, setShowChoices] = useState(false)
  const [revealed, setRevealed] = useState<RevealedRecallAnswer | null>(null)
  const [queueStatus, setQueueStatus] = useState<QueueStatus>('loading')
  const [loadingReveal, setLoadingReveal] = useState(false)
  const [submittingRating, setSubmittingRating] = useState<StudyRating | null>(null)
  const [error, setError] = useState('')

  // Stable eventId per card view so accidental double-clicks or retries stay idempotent
  const currentEventIdRef = useRef<string>(generateEventId())
  const hasLoadedOnceRef = useRef(false)
  const queueAbortRef = useRef<AbortController | null>(null)
  const queueSeqRef = useRef(0)
  const actionAbortRef = useRef<AbortController | null>(null)
  const actionSeqRef = useRef(0)
  const revealLockRef = useRef(false)
  const rateLockRef = useRef(false)

  const loadQueue = useCallback(async () => {
    queueAbortRef.current?.abort()
    actionAbortRef.current?.abort()
    revealLockRef.current = false
    rateLockRef.current = false
    setLoadingReveal(false)
    setSubmittingRating(null)

    const controller = new AbortController()
    queueAbortRef.current = controller
    const seq = ++queueSeqRef.current

    setQueueStatus(hasLoadedOnceRef.current ? 'refreshing' : 'loading')
    setError('')

    try {
      const qs = new URLSearchParams({ limit: '25' })
      if (examIdFilter) qs.set('examId', examIdFilter)
      const res = await fetch(`/api/study/recall/queue?${qs.toString()}`, {
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!res.ok) throw new Error('Unable to load due recall cards.')
      const data = (await res.json()) as RecallQueueResponse
      if (seq !== queueSeqRef.current) return

      hasLoadedOnceRef.current = true
      setQueue(data.items)
      setCounts({ due: data.dueCount, newCards: data.newCount })
      setCurrentIdx(0)
      setShowChoices(false)
      setRevealed(null)
      currentEventIdRef.current = generateEventId()
      setQueueStatus('loaded')
    } catch (err) {
      if (controller.signal.aborted || seq !== queueSeqRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to load recall queue.')
      setQueueStatus(hasLoadedOnceRef.current ? 'loaded' : 'error')
    }
  }, [examIdFilter])

  useEffect(() => {
    hasLoadedOnceRef.current = false
    loadQueue()
    return () => {
      queueAbortRef.current?.abort()
      actionAbortRef.current?.abort()
      queueSeqRef.current += 1
      actionSeqRef.current += 1
    }
  }, [loadQueue])

  const currentItem = queue[currentIdx] || null

  const handleReveal = useCallback(async () => {
    if (!currentItem || revealed || loadingReveal || revealLockRef.current || queueStatus === 'refreshing') {
      return
    }

    revealLockRef.current = true
    actionAbortRef.current?.abort()
    const controller = new AbortController()
    actionAbortRef.current = controller
    const seq = ++actionSeqRef.current
    const queueSeqAtStart = queueSeqRef.current

    setLoadingReveal(true)
    setError('')

    try {
      const res = await fetch('/api/study/recall/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId: currentItem.prompt.questionId }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error('Unable to reveal answer right now.')
      const data = (await res.json()) as RevealedRecallAnswer
      if (seq !== actionSeqRef.current || queueSeqAtStart !== queueSeqRef.current) return
      setRevealed(data)
      setShowChoices(true)
    } catch (err) {
      if (controller.signal.aborted || seq !== actionSeqRef.current || queueSeqAtStart !== queueSeqRef.current) {
        return
      }
      setError(err instanceof Error ? err.message : 'Unable to reveal answer.')
    } finally {
      if (seq === actionSeqRef.current) {
        revealLockRef.current = false
        setLoadingReveal(false)
      }
    }
  }, [currentItem, revealed, loadingReveal, queueStatus])

  const handleRate = useCallback(
    async (rating: StudyRating) => {
      if (!currentItem || !revealed || submittingRating || rateLockRef.current || queueStatus === 'refreshing') {
        return
      }

      rateLockRef.current = true
      actionAbortRef.current?.abort()
      const controller = new AbortController()
      actionAbortRef.current = controller
      const seq = ++actionSeqRef.current
      const queueSeqAtStart = queueSeqRef.current

      setSubmittingRating(rating)
      setError('')

      try {
        const res = await fetch('/api/study/recall/review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            questionId: currentItem.prompt.questionId,
            rating,
            eventId: currentEventIdRef.current,
            expectedRevision: currentItem.revision,
          }),
          signal: controller.signal,
        })

        if (seq !== actionSeqRef.current || queueSeqAtStart !== queueSeqRef.current) return

        if (res.status === 409) {
          setError(
            'This card was updated on another device or tab. Reloading the latest queue…'
          )
          rateLockRef.current = false
          setSubmittingRating(null)
          await loadQueue()
          return
        }

        if (!res.ok) {
          throw new Error('Could not save your review. Please try again.')
        }

        setCompletedCount((c) => c + 1)
        setShowChoices(false)
        setRevealed(null)
        currentEventIdRef.current = generateEventId()
        setCurrentIdx((idx) => idx + 1)
      } catch (err) {
        if (controller.signal.aborted || seq !== actionSeqRef.current || queueSeqAtStart !== queueSeqRef.current) {
          return
        }
        setError(err instanceof Error ? err.message : 'Failed to save review.')
      } finally {
        if (seq === actionSeqRef.current) {
          rateLockRef.current = false
          setSubmittingRating(null)
        }
      }
    },
    [currentItem, revealed, submittingRating, queueStatus, loadQueue]
  )

  // Keyboard shortcuts: O = show choices, Enter/Space = reveal answer, 1-4 = Again/Hard/Good/Easy
  useEffect(() => {
    if (!currentItem || queueStatus !== 'loaded') return

    function onKeyDown(e: KeyboardEvent) {
      if (shouldIgnoreStudyShortcut(e)) return

      if (!revealed) {
        if (e.key.toLowerCase() === 'o') {
          e.preventDefault()
          setShowChoices((v) => !v)
        } else if ((e.key === 'Enter' || e.key === ' ') && !loadingReveal) {
          e.preventDefault()
          handleReveal()
        }
        return
      }

      if (submittingRating) return
      if (e.key === '1') { e.preventDefault(); handleRate('again') }
      else if (e.key === '2') { e.preventDefault(); handleRate('hard') }
      else if (e.key === '3') { e.preventDefault(); handleRate('good') }
      else if (e.key === '4') { e.preventDefault(); handleRate('easy') }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [currentItem, revealed, queueStatus, loadingReveal, submittingRating, handleReveal, handleRate])

  if (queueStatus === 'loading') {
    return <RecallSessionSkeleton />
  }

  if (queueStatus === 'error' && !currentItem) {
    return (
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-14 animate-study-feedback">
        <div
          role="alert"
          className="rounded-card p-6 sm:p-8 bg-rose-50/75 dark:bg-rose-950/30 border border-earth-rust/40 dark:border-rose-400/40 text-center space-y-4"
        >
          <p className="text-sm text-earth-rust dark:text-rose-200 m-0">
            {error || 'Unable to load your active recall queue right now.'}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={loadQueue}
              className="px-4 py-2 rounded-zen text-[0.84rem] font-medium bg-matcha-500 hover:bg-matcha-600 text-white transition-colors duration-150 motion-reduce:transition-none"
            >
              Try Again
            </button>
            <StudyLink
              href="/study"
              className="px-4 py-2 rounded-zen text-[0.84rem] font-medium text-ink-600 dark:text-sage-300 border border-rice-paper-400 dark:border-tea-slate-50/60 no-underline"
            >
              Return to Dashboard
            </StudyLink>
          </div>
        </div>
      </div>
    )
  }

  const isRefreshing = queueStatus === 'refreshing'

  if (!currentItem) {
    return (
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-14 text-center animate-study-feedback">
        <div className="rounded-card p-8 bg-rice-paper-50/90 dark:bg-tea-slate-200/65 border border-rice-paper-400/70 dark:border-tea-slate-50/50 shadow-zen-sm">
          <h1 className="font-serif text-2xl font-medium text-ink-700 dark:text-sage-100 mb-2">
            {completedCount > 0 ? 'Session Complete' : 'All Caught Up'}
          </h1>
          <p className="text-[0.9rem] text-ink-500 dark:text-sage-400 mb-6">
            {completedCount > 0
              ? `You reviewed ${completedCount} card${completedCount === 1 ? '' : 's'} with FSRS-6 scheduling. Your next due dates have been saved.`
              : 'There are no due or new cards waiting right now.'}
          </p>
          {error && (
            <div
              role="alert"
              className="mb-5 rounded-zen px-4 py-2.5 bg-rose-50/80 dark:bg-rose-950/30 border border-earth-rust/40 dark:border-rose-400/40 text-xs text-earth-rust dark:text-rose-200"
            >
              {error}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              disabled={isRefreshing}
              aria-busy={isRefreshing || undefined}
              onClick={loadQueue}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-zen text-[0.84rem] font-medium bg-matcha-500 hover:bg-matcha-600 text-white transition-colors duration-200 motion-reduce:transition-none disabled:opacity-60"
            >
              {isRefreshing && <ZenPendingDot />}
              <span>{isRefreshing ? 'Checking…' : 'Check for More Cards'}</span>
            </button>
            <StudyLink
              href="/study"
              className="px-4 py-2 rounded-zen text-[0.84rem] font-medium text-ink-600 dark:text-sage-300 border border-rice-paper-400 dark:border-tea-slate-50/60 no-underline"
            >
              Return to Dashboard
            </StudyLink>
          </div>
        </div>
      </div>
    )
  }

  const { prompt } = currentItem
  const correctSet = new Set(revealed?.correctOptionIds || [])

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-10 space-y-6 animate-study-feedback">
      {/* ── Progress Header ── */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-[0.8rem] text-ink-500 dark:text-sage-400">
        <div className="flex items-center gap-2.5">
          <span className="px-2.5 py-0.5 rounded-pill text-[0.7rem] font-medium uppercase tracking-wider bg-matcha-100/80 dark:bg-matcha-900/40 text-matcha-700 dark:text-matcha-300 border border-matcha-200/70 dark:border-matcha-700/50">
            {currentItem.bucket === 'due' ? currentItem.state : 'New Card'}
          </span>
          <span>{prompt.topic}</span>
          {isRefreshing && (
            <span
              role="status"
              aria-live="polite"
              className="inline-flex items-center gap-1.5 text-xs text-matcha-600 dark:text-matcha-400"
            >
              <ZenPendingDot />
              Syncing…
            </span>
          )}
        </div>
        <span className="font-mono text-xs">
          Card {currentIdx + 1} / {queue.length} · Due: {counts.due} · New: {counts.newCards}
        </span>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-zen px-4 py-3 bg-rose-50/80 dark:bg-rose-950/30 border border-earth-rust/40 dark:border-rose-400/40 text-sm text-earth-rust dark:text-rose-200 flex items-center justify-between gap-3"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError('')}
            className="text-xs font-medium underline shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ── Flashcard Surface ── */}
      <article
        aria-busy={isRefreshing || undefined}
        className={[
          'rounded-card p-6 sm:p-8 bg-rice-paper-50/95 dark:bg-tea-slate-200/70 border border-rice-paper-400/75 dark:border-tea-slate-50/50 shadow-zen-sm space-y-6',
          'transition-opacity duration-150 ease-zen motion-reduce:transition-none',
          isRefreshing ? 'opacity-65' : 'opacity-100',
        ].join(' ')}
      >
        <div className="flex items-center justify-between text-xs text-ink-400 dark:text-sage-500">
          <span className="font-mono">{prompt.questionId}</span>
          <span>
            {prompt.questionType === 'multi_select' ? 'Multi-select' : 'Single-choice'}
          </span>
        </div>

        <StudyRichText
          text={prompt.questionText}
          imageRefs={prompt.imageRefs}
          placement="question"
          className="font-serif text-lg sm:text-[1.15rem] leading-relaxed text-ink-700 dark:text-sage-100"
        />

        {/* Free-recall guidance before revealing choices */}
        {!showChoices && !revealed && (
          <div className="rounded-zen p-4 bg-rice-paper-200/60 dark:bg-tea-slate-300/60 border border-rice-paper-400/50 dark:border-tea-slate-50/40 text-[0.84rem] text-ink-500 dark:text-sage-400">
            Pause and recall the answer from memory first. Reveal choices only if you need a cue, then assess your recall honestly.
          </div>
        )}

        {/* Optional Multiple-Choice Options */}
        {showChoices && (
          <ul className="space-y-2.5 list-none p-0 m-0 animate-study-feedback">
            {prompt.options.map((opt) => {
              const isCorrect = revealed ? correctSet.has(opt.id) : false
              const fb = revealed?.optionFeedback.find((f) => f.optionId === opt.id)
              return (
                <li
                  key={opt.id}
                  className={[
                    'rounded-zen px-4 py-3 border text-[0.9rem]',
                    isCorrect
                      ? 'bg-matcha-50/90 dark:bg-matcha-900/35 border-matcha-400/80 dark:border-matcha-600/70 text-ink-700 dark:text-sage-100'
                      : 'bg-rice-paper-100/80 dark:bg-tea-slate-300/60 border-rice-paper-400/60 dark:border-tea-slate-50/40 text-ink-600 dark:text-sage-200',
                  ].join(' ')}
                >
                  <div className="flex items-start gap-2.5">
                    <span className="font-mono text-xs font-semibold px-1.5 py-0.5 rounded bg-rice-paper-200 dark:bg-tea-slate-100 text-ink-600 dark:text-sage-300 shrink-0 mt-0.5">
                      {opt.id}
                    </span>
                    <div className="flex-1 min-w-0">
                      <StudyRichText
                        text={opt.text}
                        imageRefs={prompt.imageRefs}
                        placement="option"
                        optionId={opt.id}
                      />
                      {fb && (
                        <div className="mt-2 pt-2 border-t border-rice-paper-400/50 dark:border-tea-slate-50/30 text-xs text-ink-500 dark:text-sage-400">
                          <StudyRichText
                            text={fb.feedback}
                            imageRefs={prompt.imageRefs}
                            placement="feedback"
                            optionId={opt.id}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}

        {/* Revealed Answer & Explanation */}
        {revealed && (
          <div className="pt-5 border-t border-rice-paper-400/70 dark:border-tea-slate-50/50 space-y-4 animate-study-feedback">
            <div className="flex items-center gap-2 text-sm font-medium text-matcha-700 dark:text-matcha-300">
              <span>Correct Answer:</span>
              <span className="font-mono">{revealed.correctOptionIds.join(', ')}</span>
            </div>
            {revealed.explanation && (
              <div className="rounded-zen p-4 bg-rice-paper-200/55 dark:bg-tea-slate-300/55 border border-rice-paper-400/50 dark:border-tea-slate-50/40 text-[0.9rem] leading-relaxed text-ink-700 dark:text-sage-200">
                <StudyRichText
                  text={revealed.explanation}
                  imageRefs={prompt.imageRefs}
                  placement="explanation"
                />
              </div>
            )}
          </div>
        )}

        {/* Action Controls */}
        {!revealed ? (
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <button
              type="button"
              disabled={isRefreshing}
              onClick={() => setShowChoices((v) => !v)}
              className="px-4 py-2 rounded-zen text-[0.84rem] font-medium text-ink-600 dark:text-sage-300 border border-rice-paper-400/80 dark:border-tea-slate-50/60 hover:border-matcha-400/70 transition-colors duration-200 motion-reduce:transition-none disabled:opacity-50"
            >
              {showChoices ? 'Hide Choices (O)' : 'Show Choices (O)'}
            </button>

            <button
              type="button"
              onClick={handleReveal}
              disabled={loadingReveal || isRefreshing}
              aria-busy={loadingReveal || undefined}
              aria-keyshortcuts="Enter Space"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-zen text-[0.88rem] font-medium bg-matcha-500 hover:bg-matcha-600 dark:bg-matcha-600 dark:hover:bg-matcha-500 text-white shadow-zen-sm transition-colors duration-200 motion-reduce:transition-none disabled:opacity-60"
            >
              {loadingReveal && <ZenPendingDot />}
              <span>
                {loadingReveal ? (
                  'Revealing Answer…'
                ) : (
                  <>
                    Reveal Answer
                    <span className="hidden sm:inline font-mono text-[0.72rem] opacity-75 ml-1.5">
                      (Enter / Space)
                    </span>
                  </>
                )}
              </span>
            </button>
          </div>
        ) : (
          <div className="space-y-3 pt-2">
            <p className="text-xs text-ink-400 dark:text-sage-500 m-0">
              How well did you recall the concept from memory? (A lucky guess does not equal Easy.)
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              {RATING_BUTTONS.map((btn) => {
                const preview = currentItem.ratingPreviews[btn.rating]
                const isThisSubmitting = submittingRating === btn.rating
                return (
                  <button
                    key={btn.rating}
                    type="button"
                    disabled={Boolean(submittingRating) || isRefreshing}
                    aria-busy={isThisSubmitting || undefined}
                    onClick={() => handleRate(btn.rating)}
                    className={[
                      'rounded-zen px-3 py-2.5 border text-center',
                      'transition-all duration-150 motion-reduce:transition-none',
                      isThisSubmitting
                        ? 'ring-1 ring-matcha-500/40 dark:ring-matcha-400/40 opacity-100'
                        : 'disabled:opacity-45',
                      btn.className,
                    ].join(' ')}
                  >
                    <div className="text-[0.86rem] font-medium">
                      {btn.label}{' '}
                      <span className="font-mono text-[0.72rem] opacity-65">({btn.shortcut})</span>
                    </div>
                    <div className="text-[0.72rem] font-mono opacity-80 mt-0.5 inline-flex items-center justify-center gap-1.5">
                      {isThisSubmitting ? (
                        <>
                          <ZenPendingDot />
                          <span>Saving…</span>
                        </>
                      ) : (
                        <span>{preview?.intervalLabel || '—'}</span>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </article>
    </div>
  )
}
