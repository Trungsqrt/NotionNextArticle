'use client'

import { useEffect } from 'react'
import type { StudyRating } from '../../../lib/study/types'
import { shouldIgnoreStudyShortcut } from '../../../lib/study/keyboard'

export interface UseRecallKeyboardShortcutsParams {
  enabled: boolean
  isRevealed: boolean
  loadingReveal: boolean
  isSubmittingRating: boolean
  onToggleChoices: () => void
  onReveal: () => void
  onRate: (rating: StudyRating) => void
}

/**
 * Keyboard shortcuts for Active Recall:
 * - Before reveal: O = toggle choices, Enter / Space = reveal answer
 * - After reveal: 1 = Again, 2 = Hard, 3 = Good, 4 = Easy
 */
export function useRecallKeyboardShortcuts({
  enabled,
  isRevealed,
  loadingReveal,
  isSubmittingRating,
  onToggleChoices,
  onReveal,
  onRate,
}: UseRecallKeyboardShortcutsParams): void {
  useEffect(() => {
    if (!enabled) return

    function onKeyDown(e: KeyboardEvent) {
      if (shouldIgnoreStudyShortcut(e)) return

      if (!isRevealed) {
        if (e.key.toLowerCase() === 'o') {
          e.preventDefault()
          onToggleChoices()
        } else if ((e.key === 'Enter' || e.key === ' ') && !loadingReveal) {
          e.preventDefault()
          onReveal()
        }
        return
      }

      if (isSubmittingRating) return
      if (e.key === '1') {
        e.preventDefault()
        onRate('again')
      } else if (e.key === '2') {
        e.preventDefault()
        onRate('hard')
      } else if (e.key === '3') {
        e.preventDefault()
        onRate('good')
      } else if (e.key === '4') {
        e.preventDefault()
        onRate('easy')
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    enabled,
    isRevealed,
    loadingReveal,
    isSubmittingRating,
    onToggleChoices,
    onReveal,
    onRate,
  ])
}
