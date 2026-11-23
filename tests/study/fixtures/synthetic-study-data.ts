/**
 * tests/study/fixtures/synthetic-study-data.ts
 * ────────────────────────────────────────────
 * Strictly synthetic placeholder fixtures for unit testing Study System
 * schemas, Notion property mappers, and repositories.
 * Contains ZERO real exam questions, answers, users, or credentials.
 */

import type {
  StudyUser,
  ExamCollection,
  StudyQuestion,
  FsrsCardSnapshot,
  FsrsCardState,
  ReviewEvent,
} from '../../../lib/study/types'
import { buildCardStateKey } from '../../../lib/study/schemas'

// Synthetic scrypt-v1 formatted hash (not a real user credential)
export const SYNTHETIC_SCRYPT_HASH =
  'scrypt$0123456789abcdef0123456789abcdef$abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'

export const SYNTHETIC_USER: StudyUser = {
  userId: 'usr-synth-001',
  username: 'demo.student',
  accessKeyHash: SYNTHETIC_SCRYPT_HASH,
  hashVersion: 'scrypt-v1',
  role: 'student',
  status: 'active',
  credentialVersion: 1,
  createdAt: '2026-01-10T08:00:00.000Z',
  updatedAt: '2026-01-10T08:00:00.000Z',
}

export const SYNTHETIC_EXAM: ExamCollection = {
  examId: 'exam-synth-01',
  title: 'Synthetic Practice Set 01',
  description: 'Placeholder practice collection for automated unit tests.',
  certificationCategory: 'SYNTH',
  questionCount: 2,
  status: 'published',
}

export const SYNTHETIC_SINGLE_CHOICE_QUESTION: StudyQuestion = {
  questionId: 'q-synth-001',
  examId: 'exam-synth-01',
  questionText: 'Placeholder single-choice question: Which color is neutral?',
  questionType: 'single_choice',
  options: [
    { id: 'A', text: 'Option Alpha', feedback: 'Feedback for Alpha' },
    { id: 'B', text: 'Option Beta', feedback: 'Feedback for Beta' },
    { id: 'C', text: 'Option Gamma' },
  ],
  correctOptionIds: ['B'],
  explanation: 'Synthetic explanation: Option Beta is marked correct in this fixture.',
  imageRefs: [{ id: 'img-synth-1', alt: 'Synthetic diagram', caption: 'Fixture figure 1' }],
  topic: 'Synthetic Foundations',
  status: 'published',
  contentVersion: 1,
}

export const SYNTHETIC_MULTI_SELECT_QUESTION: StudyQuestion = {
  questionId: 'q-synth-002',
  examId: 'exam-synth-01',
  questionText: 'Placeholder multi-select question: Choose two synthetic items.',
  questionType: 'multi_select',
  options: [
    { id: 'A', text: 'First item' },
    { id: 'B', text: 'Second item' },
    { id: 'C', text: 'Third item' },
    { id: 'D', text: 'Fourth item' },
  ],
  correctOptionIds: ['A', 'C'],
  explanation: 'Synthetic explanation: Both A and C are required.',
  imageRefs: [],
  topic: 'Synthetic Workflows',
  status: 'published',
  contentVersion: 2,
}

export const SYNTHETIC_PREVIOUS_SNAPSHOT: FsrsCardSnapshot = {
  state: 'New',
  due: '2026-02-01T00:00:00.000Z',
  stability: 0,
  difficulty: 0,
  elapsedDays: 0,
  scheduledDays: 0,
  reps: 0,
  lapses: 0,
  lastReview: null,
  learningSteps: 0,
}

export const SYNTHETIC_RESULTING_SNAPSHOT: FsrsCardSnapshot = {
  state: 'Learning',
  due: '2026-02-02T00:00:00.000Z',
  stability: 2.4,
  difficulty: 4.9,
  elapsedDays: 0,
  scheduledDays: 1,
  reps: 1,
  lapses: 0,
  lastReview: '2026-02-01T10:00:00.000Z',
  learningSteps: 1,
}

export const SYNTHETIC_CARD_STATE: FsrsCardState = {
  stateKey: buildCardStateKey(SYNTHETIC_USER.userId, SYNTHETIC_SINGLE_CHOICE_QUESTION.questionId),
  userId: SYNTHETIC_USER.userId,
  questionId: SYNTHETIC_SINGLE_CHOICE_QUESTION.questionId,
  card: SYNTHETIC_RESULTING_SNAPSHOT,
  due: SYNTHETIC_RESULTING_SNAPSHOT.due,
  lastReview: SYNTHETIC_RESULTING_SNAPSHOT.lastReview,
  revision: 1,
  schedulerVersion: 'ts-fsrs-5',
  parametersVersion: 'fsrs-default-v1',
  updatedAt: '2026-02-01T10:00:00.000Z',
}

export const SYNTHETIC_REVIEW_EVENT: ReviewEvent = {
  eventId: 'evt-synth-0001',
  userId: SYNTHETIC_USER.userId,
  questionId: SYNTHETIC_SINGLE_CHOICE_QUESTION.questionId,
  reviewedAt: '2026-02-01T10:00:00.000Z',
  rating: 'good',
  previousState: SYNTHETIC_PREVIOUS_SNAPSHOT,
  resultingState: SYNTHETIC_RESULTING_SNAPSHOT,
  schedulerVersion: 'ts-fsrs-5',
  parametersVersion: 'fsrs-default-v1',
}
