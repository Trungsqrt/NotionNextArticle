/**
 * lib/study/repositories/interfaces.ts — Storage-agnostic repository contracts
 * ────────────────────────────────────────────────────────────────────────────
 * All upper layers (auth, recall, exam, importer) depend ONLY on these
 * interfaces so persistence can later move from Notion to a transactional SQL
 * database without changing domain or UI code.
 */

import type {
  StudyUser,
  ExamCollection,
  ExamCollectionStatus,
  StudyQuestion,
  QuestionStatus,
  FsrsCardState,
  ReviewEvent,
} from '../types'

export class ConcurrencyConflictError extends Error {
  readonly code = 'CONCURRENCY_CONFLICT'
  readonly expectedRevision: number
  readonly actualRevision: number

  constructor(stateKey: string, expectedRevision: number, actualRevision: number) {
    super(
      `Concurrent update detected for card state "${stateKey}" (expected revision ${expectedRevision}, found ${actualRevision})`
    )
    this.name = 'ConcurrencyConflictError'
    this.expectedRevision = expectedRevision
    this.actualRevision = actualRevision
  }
}

export class DataIntegrityError extends Error {
  readonly code = 'DATA_INTEGRITY_ERROR'

  constructor(message: string) {
    super(message)
    this.name = 'DataIntegrityError'
  }
}

export interface StudyUserRepository {
  findByUsername(username: string): Promise<StudyUser | null>
  findByUserId(userId: string): Promise<StudyUser | null>
  upsert(user: StudyUser): Promise<StudyUser>
}

export interface ExamCollectionRepository {
  findByExamId(examId: string): Promise<ExamCollection | null>
  list(options?: { status?: ExamCollectionStatus }): Promise<ExamCollection[]>
  upsert(exam: ExamCollection): Promise<ExamCollection>
}

export interface QuestionBankRepository {
  findByQuestionId(questionId: string): Promise<StudyQuestion | null>
  listByExamId(
    examId: string,
    options?: { status?: QuestionStatus }
  ): Promise<StudyQuestion[]>
  listByQuestionIds(questionIds: string[]): Promise<StudyQuestion[]>
  upsert(question: StudyQuestion): Promise<StudyQuestion>
}

export interface SaveCardStateOptions {
  /**
   * Optimistic concurrency check:
   * - For a new card state, omit or pass 0.
   * - For an update, pass the revision read prior to computing the next state.
   * Throws ConcurrencyConflictError if the persisted revision has moved ahead.
   * Note: Notion does not support atomic compare-and-swap; this check is a
   * best-effort optimistic guard paired with append-only ReviewEvent logs.
   */
  expectedRevision?: number
}

export interface FsrsCardStateRepository {
  findByUserAndQuestion(userId: string, questionId: string): Promise<FsrsCardState | null>
  listByUser(userId: string): Promise<FsrsCardState[]>
  listDueByUser(userId: string, asOfIso: string): Promise<FsrsCardState[]>
  save(state: FsrsCardState, options?: SaveCardStateOptions): Promise<FsrsCardState>
}

export interface AppendReviewEventResult {
  event: ReviewEvent
  created: boolean
}

export interface ReviewEventRepository {
  findByEventId(eventId: string): Promise<ReviewEvent | null>
  /**
   * Indexed O(1) lookup for the most recent ReviewEvent for a specific
   * (userId, questionId) pair. Avoids scanning a user's full review history.
   */
  findLatestByUserAndQuestion(userId: string, questionId: string): Promise<ReviewEvent | null>
  listByUser(userId: string, options?: { limit?: number }): Promise<ReviewEvent[]>
  /**
   * Append-only idempotent write: if an event with the same eventId already
   * exists, returns { event: existing, created: false } without duplicating.
   */
  appendIfNotExists(
    event: ReviewEvent,
    options?: { skipExistenceCheck?: boolean }
  ): Promise<AppendReviewEventResult>
}
