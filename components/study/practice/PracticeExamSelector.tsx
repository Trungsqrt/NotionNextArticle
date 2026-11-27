'use client'

import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ExamCollection } from '../../../lib/study/types'
import { ZenPendingDot } from '../StudySkeletons'

export interface PracticeExamSelectorProps {
  exams: ExamCollection[]
  displayedExamId: string
  isSwitching: boolean
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  onSelectExam: (examId: string) => void
}

/**
 * Accessible custom listbox dropdown for switching Practice Mode exam
 * collections, with full keyboard navigation and an inline switching indicator.
 */
export default function PracticeExamSelector({
  exams,
  displayedExamId,
  isSwitching,
  isOpen,
  onOpenChange,
  onSelectExam,
}: PracticeExamSelectorProps) {
  const dropdownRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const optionRefs = useRef<Array<HTMLLIElement | null>>([])

  const displayedExam = exams.find((ex) => ex.examId === displayedExamId) || exams[0]
  const displayedExamLabel = displayedExam
    ? `${displayedExam.title} (${displayedExam.questionCount})`
    : 'Select exam'

  // Close dropdown on outside click or Escape
  useEffect(() => {
    if (!isOpen) return

    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        onOpenChange(false)
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onOpenChange(false)
        triggerRef.current?.focus()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, onOpenChange])

  function focusExamOption(index: number) {
    if (exams.length === 0) return
    const clamped = Math.max(0, Math.min(exams.length - 1, index))
    optionRefs.current[clamped]?.focus()
  }

  function handleSelectOption(examId: string) {
    onOpenChange(false)
    onSelectExam(examId)
    triggerRef.current?.focus()
  }

  function handleTriggerKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const currentIdx = Math.max(
        0,
        exams.findIndex((ex) => ex.examId === displayedExamId)
      )
      onOpenChange(true)
      requestAnimationFrame(() => focusExamOption(currentIdx))
    }
  }

  function handleOptionKeyDown(
    e: ReactKeyboardEvent<HTMLLIElement>,
    index: number,
    examId: string
  ) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      focusExamOption((index + 1) % exams.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      focusExamOption((index - 1 + exams.length) % exams.length)
    } else if (e.key === 'Home') {
      e.preventDefault()
      focusExamOption(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      focusExamOption(exams.length - 1)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      handleSelectOption(examId)
    } else if (e.key === 'Tab') {
      onOpenChange(false)
    }
  }

  return (
    <div className="flex items-center gap-2.5 w-full sm:w-auto shrink-0">
      {isSwitching && (
        <span
          role="status"
          aria-live="polite"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-matcha-600 dark:text-matcha-400 shrink-0"
        >
          <ZenPendingDot />
          Switching…
        </span>
      )}
      <div className="relative w-full sm:w-auto" ref={dropdownRef}>
        <button
          ref={triggerRef}
          type="button"
          id="practice-exam-selector"
          aria-label="Select exam collection"
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          aria-controls="practice-exam-listbox"
          aria-busy={isSwitching || undefined}
          title={displayedExamLabel}
          onClick={() => onOpenChange(!isOpen)}
          onKeyDown={handleTriggerKeyDown}
          className={[
            'flex items-center justify-between w-full sm:w-64 md:w-72 pl-3.5 pr-2.5 py-2 rounded-[6px]',
            'text-[0.83rem] font-medium transition-all duration-200 ease-out motion-reduce:transition-none outline-none select-none cursor-pointer',
            'focus-visible:ring-2 focus-visible:ring-matcha-500/50 dark:focus-visible:ring-matcha-400/60',
            isOpen
              ? 'bg-matcha-100/90 text-matcha-700 border border-matcha-400/70 shadow-sm dark:bg-matcha-700/25 dark:text-matcha-300 dark:border-matcha-600/50 dark:shadow-none'
              : 'bg-rice-paper-200/70 text-ink-600 border border-rice-paper-400/80 hover:bg-rice-paper-300/80 hover:text-ink-700 dark:bg-tea-slate-200 dark:text-sage-200 dark:border-tea-slate-50/50 dark:hover:bg-tea-slate-100/70 dark:hover:border-tea-slate-50/70 dark:hover:text-sage-100',
          ].join(' ')}
        >
          <span className="truncate">{displayedExamLabel}</span>
          <svg
            className={[
              'w-3.5 h-3.5 ml-2 shrink-0 transition-transform duration-250 ease-out motion-reduce:transition-none text-ink-400 dark:text-sage-400',
              isOpen ? 'rotate-180 text-matcha-500 dark:text-matcha-400' : '',
            ].join(' ')}
            fill="none"
            strokeWidth="2"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {isOpen && (
          <ul
            id="practice-exam-listbox"
            role="listbox"
            aria-label="Exam collection"
            className="animate-dropdown absolute top-full left-0 sm:left-auto sm:right-0 mt-1.5 w-full sm:w-80 md:w-96 max-h-72 overflow-y-auto bg-rice-paper-100 dark:bg-tea-slate-50 border border-rice-paper-400/80 dark:border-tea-slate-50/60 rounded-[6px] shadow-zen dark:shadow-[0_4px_16px_rgba(18,19,16,0.5)] z-50 py-1 list-none m-0"
          >
            {exams.map((ex, index) => {
              const isSelected = ex.examId === displayedExamId
              return (
                <li
                  key={ex.examId}
                  ref={(el) => {
                    optionRefs.current[index] = el
                  }}
                  role="option"
                  tabIndex={-1}
                  aria-selected={isSelected}
                  onClick={() => handleSelectOption(ex.examId)}
                  onKeyDown={(e) => handleOptionKeyDown(e, index, ex.examId)}
                  className={[
                    'px-3.5 py-2 text-[0.82rem] leading-snug cursor-pointer transition-colors duration-150 ease-out motion-reduce:transition-none flex items-start justify-between gap-2.5 outline-none',
                    isSelected
                      ? 'bg-matcha-100/70 dark:bg-matcha-700/25 font-medium text-matcha-700 dark:text-matcha-300'
                      : 'text-ink-600 dark:text-sage-300 hover:bg-rice-paper-300/60 dark:hover:bg-tea-slate-200/70 hover:text-ink-700 dark:hover:text-sage-100 focus-visible:bg-rice-paper-300/60 dark:focus-visible:bg-tea-slate-200/70 focus-visible:text-ink-700 dark:focus-visible:text-sage-100',
                  ].join(' ')}
                >
                  <span className="break-words">{ex.title}</span>
                  <span className="inline-flex items-center gap-2 shrink-0 pt-0.5">
                    <span className="text-[0.74rem] font-mono tabular-nums opacity-70">
                      ({ex.questionCount})
                    </span>
                    {isSelected && (
                      <span
                        className="w-1.5 h-1.5 rounded-full bg-matcha-500 dark:bg-matcha-400"
                        aria-hidden="true"
                      />
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
