'use client'

import { useEffect } from 'react'
import { shouldIgnoreStudyShortcut } from '../../../lib/study/keyboard'

export interface UsePracticeKeyboardShortcutsParams {
  enabled: boolean
  currentQuestionId: string | null
  currentGraded: boolean
  hasCurrentSelection: boolean
  isChecking: boolean
  canGoPrevious: boolean
  canGoNext: boolean
  canFinishPractice: boolean
  onPrevious: () => void
  onNext: () => void
  onCheckAnswer: (questionId: string) => void
  onFinishPractice: () => void
}

/**
 * Registers Practice Mode keyboard shortcuts:
 * - ArrowLeft / ArrowRight: Previous / Next question
 * - Enter (Smart Enter): Check Answer (if ungraded with selection), Next (if graded),
 *   or Finish Practice (on final graded question in the All view)
 * - Space: Check Answer (if ungraded with selection)
 */
export function usePracticeKeyboardShortcuts({
  enabled,
  currentQuestionId,
  currentGraded,
  hasCurrentSelection,
  isChecking,
  canGoPrevious,
  canGoNext,
  canFinishPractice,
  onPrevious,
  onNext,
  onCheckAnswer,
  onFinishPractice,
}: UsePracticeKeyboardShortcutsParams) {
  useEffect(() => {
    if (!enabled || !currentQuestionId) {
      return
    }

    function onKeyDown(e: KeyboardEvent) {
      if (shouldIgnoreStudyShortcut(e)) return

      if (e.key === 'ArrowLeft') {
        if (!canGoPrevious) return
        e.preventDefault()
        onPrevious()
        return
      }

      if (e.key === 'ArrowRight') {
        if (!canGoNext) return
        e.preventDefault()
        onNext()
        return
      }

      if (e.key === 'Enter') {
        if (!currentGraded) {
          if (hasCurrentSelection && !isChecking) {
            e.preventDefault()
            onCheckAnswer(currentQuestionId!)
          }
        } else if (canGoNext) {
          e.preventDefault()
          onNext()
        } else if (canFinishPractice) {
          e.preventDefault()
          onFinishPractice()
        }
        return
      }

      if (e.key === ' ') {
        if (!currentGraded && hasCurrentSelection && !isChecking) {
          e.preventDefault()
          onCheckAnswer(currentQuestionId!)
        }
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    enabled,
    currentQuestionId,
    currentGraded,
    hasCurrentSelection,
    isChecking,
    canGoPrevious,
    canGoNext,
    canFinishPractice,
    onPrevious,
    onNext,
    onCheckAnswer,
    onFinishPractice,
  ])
}
