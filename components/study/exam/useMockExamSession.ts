'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { StudyQuestionPrompt } from '../../../lib/study/types'
import type {
  GradedExamResult,
  StartedExamSession,
} from '../../../lib/study/services/exam-service'
import { recordMockExamResult } from '../../../lib/study/local-progress'

export interface UseMockExamSessionParams {
  examId: string
  userId: string
}

export interface MockExamSessionState {
  session: StartedExamSession | null
  result: GradedExamResult | null
  loading: boolean
  submitting: boolean
  error: string
  currentIdx: number
  currentQuestion: StudyQuestionPrompt | null
  answers: Record<string, string[]>
  flagged: Record<string, boolean>
  remainingSeconds: number
  answeredTotal: number
  canGoPrevious: boolean
  canGoNext: boolean

  // Actions
  startExam: () => Promise<void>
  handleSubmit: () => Promise<void>
  toggleOption: (questionId: string, optionId: string, isMulti: boolean) => void
  toggleFlag: (questionId: string) => void
  selectQuestion: (index: number) => void
  goPrevious: () => void
  goNext: () => void
}

/**
 * Owns the Mock Exam client lifecycle: starting a randomized signed session,
 * running the countdown timer with automatic expiry submission, tracking answers
 * and flagged questions by stable internal option/question IDs, and submitting
 * to the server for grading and local summary recording.
 */
export function useMockExamSession({
  examId,
  userId,
}: UseMockExamSessionParams): MockExamSessionState {
  const [session, setSession] = useState<StartedExamSession | null>(null)
  const [result, setResult] = useState<GradedExamResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const [currentIdx, setCurrentIdx] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [flagged, setFlagged] = useState<Record<string, boolean>>({})
  const [remainingSeconds, setRemainingSeconds] = useState(0)

  const startAbortRef = useRef<AbortController | null>(null)
  const startSeqRef = useRef(0)
  const submitAbortRef = useRef<AbortController | null>(null)
  const submitLockRef = useRef(false)

  const startExam = useCallback(async () => {
    startAbortRef.current?.abort()
    submitAbortRef.current?.abort()
    submitLockRef.current = false
    setSubmitting(false)

    const controller = new AbortController()
    startAbortRef.current = controller
    const seq = ++startSeqRef.current

    setLoading(true)
    setError('')
    setResult(null)
    setAnswers({})
    setFlagged({})
    setCurrentIdx(0)

    try {
      const res = await fetch('/api/study/exams/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ examId }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error('Unable to start this exam collection.')
      const started = (await res.json()) as StartedExamSession
      if (seq !== startSeqRef.current) return
      setSession(started)
      const diffSec = Math.max(
        0,
        Math.floor((Date.parse(started.expiresAt) - Date.now()) / 1000)
      )
      setRemainingSeconds(diffSec)
    } catch (err) {
      if (controller.signal.aborted || seq !== startSeqRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to start exam.')
    } finally {
      if (seq === startSeqRef.current) {
        setLoading(false)
      }
    }
  }, [examId])

  useEffect(() => {
    startExam()
    return () => {
      startAbortRef.current?.abort()
      submitAbortRef.current?.abort()
      startSeqRef.current += 1
    }
  }, [startExam])

  const handleSubmit = useCallback(async () => {
    if (!session || submitting || submitLockRef.current || result) return

    submitLockRef.current = true
    submitAbortRef.current?.abort()
    const controller = new AbortController()
    submitAbortRef.current = controller
    const startSeqAtSubmit = startSeqRef.current

    setSubmitting(true)
    setError('')

    try {
      const res = await fetch('/api/study/exams/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          examToken: session.examToken,
          answers,
        }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error('Unable to grade exam right now.')
      const graded = (await res.json()) as GradedExamResult
      if (startSeqAtSubmit !== startSeqRef.current) return
      recordMockExamResult(userId, examId, graded)
      setResult(graded)
    } catch (err) {
      if (controller.signal.aborted || startSeqAtSubmit !== startSeqRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to submit exam.')
    } finally {
      if (startSeqAtSubmit === startSeqRef.current) {
        submitLockRef.current = false
        setSubmitting(false)
      }
    }
  }, [session, submitting, result, answers, userId, examId])

  // Countdown timer
  useEffect(() => {
    if (!session || result) return
    const id = setInterval(() => {
      setRemainingSeconds((prev) => {
        if (prev <= 1) {
          clearInterval(id)
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(id)
  }, [session, result])

  // Auto-submit when timer hits zero
  useEffect(() => {
    if (session && !result && remainingSeconds === 0 && !submitting && !submitLockRef.current) {
      handleSubmit()
    }
  }, [session, result, remainingSeconds, submitting, handleSubmit])

  const totalQuestions = session?.questions.length ?? 0
  const canGoPrevious = Boolean(session && !submitting && currentIdx > 0)
  const canGoNext = Boolean(session && !submitting && currentIdx < totalQuestions - 1)

  const goPrevious = useCallback(() => {
    if (!canGoPrevious) return
    setCurrentIdx((i) => Math.max(0, i - 1))
  }, [canGoPrevious])

  const goNext = useCallback(() => {
    if (!canGoNext) return
    setCurrentIdx((i) => Math.min(totalQuestions - 1, i + 1))
  }, [canGoNext, totalQuestions])

  const selectQuestion = useCallback(
    (index: number) => {
      if (submitting) return
      setCurrentIdx(index)
    },
    [submitting]
  )

  const toggleOption = useCallback(
    (questionId: string, optionId: string, isMulti: boolean) => {
      if (submitting) return
      setAnswers((prev) => {
        const curr = prev[questionId] || []
        if (!isMulti) return { ...prev, [questionId]: [optionId] }
        const exists = curr.includes(optionId)
        return {
          ...prev,
          [questionId]: exists ? curr.filter((id) => id !== optionId) : [...curr, optionId],
        }
      })
    },
    [submitting]
  )

  const toggleFlag = useCallback(
    (questionId: string) => {
      if (submitting) return
      setFlagged((prev) => ({ ...prev, [questionId]: !prev[questionId] }))
    },
    [submitting]
  )

  const currentQuestion = session?.questions[currentIdx] ?? null
  const answeredTotal = Object.values(answers).filter((a) => a.length > 0).length

  return {
    session,
    result,
    loading,
    submitting,
    error,
    currentIdx,
    currentQuestion,
    answers,
    flagged,
    remainingSeconds,
    answeredTotal,
    canGoPrevious,
    canGoNext,
    startExam,
    handleSubmit,
    toggleOption,
    toggleFlag,
    selectQuestion,
    goPrevious,
    goNext,
  }
}
