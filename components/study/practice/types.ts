import type { GradedQuestionResult } from '../../../lib/study/services/grading'

export type PracticeFilter = 'all' | 'incorrect' | 'bookmarked'

export type PracticeFetchStatus = 'idle' | 'loading' | 'switching' | 'error' | 'loaded'

export type PracticeResultEntry = GradedQuestionResult & {
  /** True when restored from localStorage (verdict + user selection only; no stored answer key/explanation). */
  restored?: boolean
}

export interface LegacyBookmarkImportCandidate {
  examId: string
  questionIds: string[]
}
