'use client'

import { useEffect } from 'react'
import { shouldIgnoreStudyShortcut } from '../../../lib/study/keyboard'

export interface UseMockExamKeyboardShortcutsParams {
  enabled: boolean
  canGoPrevious: boolean
  canGoNext: boolean
  onPrevious: () => void
  onNext: () => void
}

/**
 * Keyboard shortcuts for active Mock Exam navigation:
 * ArrowLeft = Previous, ArrowRight / Enter = Next.
 * Deliberately never submits the exam automatically.
 */
export function useMockExamKeyboardShortcuts({
  enabled,
  canGoPrevious,
  canGoNext,
  onPrevious,
  onNext,
}: UseMockExamKeyboardShortcutsParams): void {
  useEffect(() => {
    if (!enabled) return

    function onKeyDown(e: KeyboardEvent) {
      if (shouldIgnoreStudyShortcut(e)) return

      if (e.key === 'ArrowLeft') {
        if (!canGoPrevious) return
        e.preventDefault()
        onPrevious()
        return
      }

      if (e.key === 'ArrowRight' || e.key === 'Enter') {
        if (!canGoNext) return
        e.preventDefault()
        onNext()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled, canGoPrevious, canGoNext, onPrevious, onNext])
}
