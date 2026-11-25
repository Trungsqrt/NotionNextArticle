/**
 * lib/study/types.ts — Canonical TypeScript domain contracts for Private Study Room
 * ─────────────────────────────────────────────────────────────────────────────────
 * Pure domain types shared across repositories, validation, and future study
 * services. Contains zero Notion SDK or Next.js runtime imports so the storage
 * layer can be swapped from Notion to a transactional SQL database later.
 */

export type StudyUserRole = 'admin' | 'student'
export type StudyUserStatus = 'active' | 'revoked'
export type AccessKeyHashVersion = 'scrypt-v1' | 'argon2id-v1'

export interface StudyUser {
  /** Stable logical user identifier (never tied to a Notion page UUID) */
  userId: string
  /** Unique normalized lowercase username */
  username: string
  /** Salted modern KDF hash (e.g. scrypt$... or argon2id$...) — server-only */
  accessKeyHash: string
  /** Explicit hash algorithm version for future migrations */
  hashVersion: AccessKeyHashVersion
  role: StudyUserRole
  status: StudyUserStatus
  /** Monotonic integer incremented to revoke active sessions/credentials */
  credentialVersion: number
  createdAt: string
  updatedAt: string
}

/** Sanitized user representation safe to pass to session/UI layers */
export type SafeStudyUser = Omit<StudyUser, 'accessKeyHash' | 'hashVersion'>

export type ExamCollectionStatus = 'published' | 'draft'

export interface ExamCollection {
  /** Stable logical exam identifier (e.g. "csa-core-01") */
  examId: string
  title: string
  description: string
  certificationCategory: string
  questionCount: number
  status: ExamCollectionStatus
  createdAt?: string
  updatedAt?: string
}

export type QuestionType = 'single_choice' | 'multi_select'
export type QuestionStatus = 'published' | 'draft' | 'retired'

export interface QuestionOption {
  /** Stable option identifier within the question (e.g. "A", "B", "C", "D") */
  id: string
  /** Display text for the option */
  text: string
  /** Optional per-option feedback shown ONLY after grading (server-only pre-answer) */
  feedback?: string
}

export type QuestionImagePlacement = 'question' | 'option' | 'feedback' | 'explanation'

export interface QuestionImageRef {
  /** Stable identifier (Notion image block ID once uploaded, or logical ref ID during dry-run) */
  id: string
  /** Permanent Notion image block ID attached to the private Question page (never a signed URL) */
  notionBlockId?: string
  /** Where the image appeared in the original source content */
  placement?: QuestionImagePlacement
  /** Option ID when placement is 'option' or 'feedback' */
  optionId?: string
  /** 0-based order within its placement to preserve exact layout */
  order?: number
  /** Original local filename preserved for troubleshooting */
  originalFilename?: string
  /** Original relative source reference (e.g. "./images/img_975870794.png") */
  sourceRef?: string
  /** SHA-256 content hash for deduplication across re-imports */
  sha256?: string
  alt: string
  caption?: string
}

export interface StudyQuestion {
  /** Stable logical question identifier preserved across updates */
  questionId: string
  /** Stable logical reference to ExamCollection.examId */
  examId: string
  questionText: string
  questionType: QuestionType
  /** Ordered answer options (order preserved explicitly) */
  options: QuestionOption[]
  /** Server-only list of correct option IDs */
  correctOptionIds: string[]
  /** Server-only explanation revealed after grading */
  explanation: string
  imageRefs: QuestionImageRef[]
  topic: string
  status: QuestionStatus
  /** Monotonic content version incremented when question text/options/key change */
  contentVersion: number
  updatedAt?: string
}

/**
 * Client-safe question prompt DTO.
 * Strictly strips correctOptionIds, explanation, and per-option feedback
 * so answers cannot leak into client bundles or pre-answer API responses.
 */
export interface StudyQuestionPrompt {
  questionId: string
  examId: string
  questionText: string
  questionType: QuestionType
  options: Array<{ id: string; text: string }>
  imageRefs: QuestionImageRef[]
  topic: string
  contentVersion: number
}

/** Standard FSRS v4/v5/ts-fsrs card state lifecycle */
export type FsrsLifecycleState = 'New' | 'Learning' | 'Review' | 'Relearning'

/** Version-compatible FSRS card snapshot (maps cleanly to ts-fsrs Card) */
export interface FsrsCardSnapshot {
  state: FsrsLifecycleState
  due: string
  stability: number
  difficulty: number
  elapsedDays: number
  scheduledDays: number
  reps: number
  lapses: number
  lastReview: string | null
  learningSteps?: number
}

export interface FsrsCardState {
  /** Composite key "${userId}::${questionId}" for deterministic lookup */
  stateKey: string
  userId: string
  questionId: string
  card: FsrsCardSnapshot
  due: string
  lastReview: string | null
  /** Optimistic concurrency revision (incremented on every state write) */
  revision: number
  schedulerVersion: string
  parametersVersion: string
  updatedAt: string
}

export type StudyRating = 'again' | 'hard' | 'good' | 'easy'

export interface ReviewEvent {
  /** Client/server-generated unique ID for append-only idempotency */
  eventId: string
  userId: string
  questionId: string
  reviewedAt: string
  rating: StudyRating
  previousState: FsrsCardSnapshot
  resultingState: FsrsCardSnapshot
  schedulerVersion: string
  parametersVersion: string
}

export interface StudyBookmarkRecord {
  /** Composite key "${userId}::${examId}" for deterministic 1-record-per-user-and-exam lookup */
  bookmarkKey: string
  userId: string
  examId: string
  /** Deduplicated bookmarked question IDs (never stores question content or answers) */
  questionIds: string[]
  updatedAt: string
}
