/**
 * lib/study/local-progress/storage.ts — Shared LocalStorage primitives & key builders
 * ───────────────────────────────────────────────────────────────────────────────────
 * Defines versioned, user- and exam-scoped key builders, validation bounds, and
 * safe JSON read/write/remove helpers that degrade gracefully when browser
 * storage is unavailable, full, or contains malformed data.
 */

export const STUDY_STORAGE_VERSION = 1 as const
export const MAX_BOOKMARKS_PER_EXAM = 500
export const MAX_ATTEMPT_QUESTIONS = 500
export const MAX_OPTIONS_PER_QUESTION = 20
export const MAX_ID_LENGTH = 128

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  readonly length?: number
  key?(index: number): string | null
}

export function getDefaultStorage(): StorageLike | null {
  try {
    const g = globalThis as { localStorage?: StorageLike }
    return g.localStorage ?? null
  } catch {
    return null
  }
}

export function normalizeId(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > MAX_ID_LENGTH) return ''
  return trimmed
}

function buildKey(userId: string, kind: string, examId: string): string {
  return `study-v1:u:${encodeURIComponent(userId.trim())}:${kind}:${encodeURIComponent(examId.trim())}`
}

export function getBookmarksStorageKey(userId: string, examId: string): string {
  return buildKey(userId, 'bookmarks', examId)
}

export function getPendingBookmarkOpsStorageKey(userId: string, examId: string): string {
  return buildKey(userId, 'bookmark-pending', examId)
}

export function getPracticeAttemptStorageKey(userId: string, examId: string): string {
  return buildKey(userId, 'practice-attempt', examId)
}

export function getPracticeSummaryStorageKey(userId: string, examId: string): string {
  return buildKey(userId, 'practice-summary', examId)
}

export function getExamSummaryStorageKey(userId: string, examId: string): string {
  return buildKey(userId, 'exam-summary', examId)
}

export function safeReadJson(key: string, storage: StorageLike | null): unknown {
  if (!storage) return null
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function safeWriteJson(
  key: string,
  value: unknown,
  storage: StorageLike | null
): boolean {
  if (!storage) return false
  try {
    storage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

export function safeRemove(key: string, storage: StorageLike | null): void {
  if (!storage) return
  try {
    storage.removeItem(key)
  } catch {
    // Ignore storage removal errors
  }
}

export function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number = min
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
}

export function isValidIso(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value))
}
