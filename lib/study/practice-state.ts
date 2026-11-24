/**
 * lib/study/practice-state.ts — Pure helpers for Practice Mode error, retry,
 * and exam-selection synchronization (P1, P2, P3).
 */

export interface PracticeExamRef {
  examId: string
  title?: string
}

export type PracticeError =
  | {
      kind: 'load_exam'
      examId: string
      message: string
      isSwitch: boolean
    }
  | {
      kind: 'check_answer'
      questionId: string
      selectedOptionIds: string[]
      message: string
    }

/**
 * Resolves a requested examId (e.g. from URL search params or user selection)
 * against the available published exams, falling back to the first published exam.
 */
export function resolveValidExamId(
  requestedExamId: string | null | undefined,
  exams: readonly PracticeExamRef[]
): string {
  const trimmed = (requestedExamId || '').trim()
  if (trimmed && exams.some((exam) => exam.examId === trimmed)) {
    return trimmed
  }
  return exams[0]?.examId || ''
}

/**
 * Determines whether a URL `examId` query parameter change should trigger a
 * programmatic exam switch, without overriding an intentional dropdown selection.
 */
export function resolveExternalParamExamSwitch(params: {
  paramExamId: string
  lastHandledParamExamId: string
  activeExamId: string
  pendingExamId: string | null
  exams: readonly PracticeExamRef[]
}): string | null {
  const { paramExamId, lastHandledParamExamId, activeExamId, pendingExamId, exams } = params
  const trimmed = paramExamId.trim()
  if (!trimmed || trimmed === lastHandledParamExamId) {
    return null
  }
  if (!exams.some((exam) => exam.examId === trimmed)) {
    return null
  }
  const effectiveExamId = pendingExamId || activeExamId
  if (trimmed === effectiveExamId) {
    return null
  }
  return trimmed
}

/**
 * Builds the updated Practice URL with the selected `examId` query parameter
 * while preserving any unrelated query parameters and hash.
 */
export function buildPracticeExamUrl(currentHref: string, examId: string): string {
  const url = new URL(currentHref, 'http://localhost')
  url.searchParams.set('examId', examId)
  return `${url.pathname}${url.search}${url.hash}`
}

/**
 * Determines whether the "View Summary" button should be displayed.
 * Shown across All, Incorrect, and Bookmarked views once all questions
 * in the active exam have been graded and the user is not already on
 * the completion screen.
 */
export function shouldShowViewSummaryButton(params: {
  allGraded: boolean
  isCompleted: boolean
  isInitialLoading: boolean
}): boolean {
  return params.allGraded && !params.isCompleted && !params.isInitialLoading
}

/**
 * Resolves the retry action for a PracticeError so Check Answer failures never
 * reset the exam attempt and failed exam switches retry only the target exam.
 */
export function resolvePracticeRetryAction(
  error: PracticeError | null,
  currentSelections: Readonly<Record<string, string[]>>
):
  | { type: 'load_exam'; examId: string; isSwitch: boolean }
  | { type: 'check_answer'; questionId: string; selectedOptionIds: string[] }
  | null {
  if (!error) return null
  if (error.kind === 'load_exam') {
    return {
      type: 'load_exam',
      examId: error.examId,
      isSwitch: error.isSwitch,
    }
  }
  const latestSelection = currentSelections[error.questionId]
  const selectedOptionIds =
    latestSelection && latestSelection.length > 0
      ? latestSelection
      : error.selectedOptionIds
  return {
    type: 'check_answer',
    questionId: error.questionId,
    selectedOptionIds,
  }
}
