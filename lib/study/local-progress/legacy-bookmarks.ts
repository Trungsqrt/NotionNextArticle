/**
 * lib/study/local-progress/legacy-bookmarks.ts — Browser-local & legacy bookmark storage
 * ──────────────────────────────────────────────────────────────────────────────────────
 * Handles backward compatibility with earlier browser-local v1 bookmarks and
 * unscoped legacy `study-bookmarks:<examId>` keys. Legacy bookmarks are NEVER
 * auto-imported silently so one user's local bookmarks cannot leak to another account.
 */

import {
  MAX_BOOKMARKS_PER_EXAM,
  STUDY_STORAGE_VERSION,
  getBookmarksStorageKey,
  getDefaultStorage,
  normalizeId,
  safeReadJson,
  safeRemove,
  safeWriteJson,
  type StorageLike,
} from './storage'

export interface StoredBookmarksV1 {
  version: 1
  questionIds: string[]
  updatedAt: string
}

/**
 * Reads any browser-local bookmarks (both unscoped legacy `study-bookmarks:<examId>`
 * and earlier local-only `study-v1:u:<userId>:bookmarks:<examId>`) so the UI can
 * present an explicit one-time import confirmation without ever silently adopting
 * another account's bookmarks.
 */
export function readLegacyLocalBookmarksForImport(
  userId: string,
  examId: string,
  storage: StorageLike | null = getDefaultStorage()
): string[] {
  const cleanUser = normalizeId(userId)
  const cleanExam = normalizeId(examId)
  if (!cleanUser || !cleanExam || !storage) return []

  const seen = new Set<string>()
  const ids: string[] = []

  const pushId = (raw: unknown) => {
    if (ids.length >= MAX_BOOKMARKS_PER_EXAM) return
    const qId = normalizeId(raw)
    if (qId && !seen.has(qId)) {
      seen.add(qId)
      ids.push(qId)
    }
  }

  // 1. User-scoped browser-local v1 bookmarks
  const userScoped = readUserBookmarks(cleanUser, cleanExam, storage)
  for (const qId of Object.keys(userScoped)) {
    pushId(qId)
  }

  // 2. Unscoped legacy `study-bookmarks:<examId>` map
  try {
    const raw = storage.getItem(`study-bookmarks:${cleanExam}`)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        for (const [qId, enabled] of Object.entries(parsed as Record<string, unknown>)) {
          if (enabled) pushId(qId)
        }
      }
    }
  } catch {
    // Ignore malformed legacy storage
  }

  return ids
}

export function clearLegacyLocalBookmarks(
  userId: string,
  examId: string,
  storage: StorageLike | null = getDefaultStorage()
): void {
  const cleanUser = normalizeId(userId)
  const cleanExam = normalizeId(examId)
  if (!cleanExam || !storage) return
  if (cleanUser) {
    safeRemove(getBookmarksStorageKey(cleanUser, cleanExam), storage)
  }
  safeRemove(`study-bookmarks:${cleanExam}`, storage)
}

/**
 * Checks whether an unscoped legacy `study-bookmarks:<examId>` key exists.
 * Legacy bookmarks are intentionally never auto-imported to prevent cross-account leakage.
 */
export function hasLegacyBookmarks(
  examId: string,
  storage: StorageLike | null = getDefaultStorage()
): boolean {
  const cleanExamId = normalizeId(examId)
  if (!cleanExamId || !storage) return false
  try {
    const raw = storage.getItem(`study-bookmarks:${cleanExamId}`)
    if (!raw) return false
    const parsed = JSON.parse(raw)
    return Boolean(parsed && typeof parsed === 'object' && Object.values(parsed).some(Boolean))
  } catch {
    return false
  }
}

export function readUserBookmarks(
  userId: string,
  examId: string,
  storage: StorageLike | null = getDefaultStorage()
): Record<string, boolean> {
  const cleanUser = normalizeId(userId)
  const cleanExam = normalizeId(examId)
  if (!cleanUser || !cleanExam) return {}

  const parsed = safeReadJson(getBookmarksStorageKey(cleanUser, cleanExam), storage)
  if (!parsed || typeof parsed !== 'object') return {}
  const record = parsed as Partial<StoredBookmarksV1>
  if (record.version !== STUDY_STORAGE_VERSION || !Array.isArray(record.questionIds)) {
    return {}
  }

  const map: Record<string, boolean> = {}
  let count = 0
  for (const rawId of record.questionIds) {
    if (count >= MAX_BOOKMARKS_PER_EXAM) break
    const qId = normalizeId(rawId)
    if (qId && !map[qId]) {
      map[qId] = true
      count += 1
    }
  }
  return map
}

export function writeUserBookmarks(
  userId: string,
  examId: string,
  bookmarks: Readonly<Record<string, boolean>>,
  storage: StorageLike | null = getDefaultStorage(),
  nowIso: string = new Date().toISOString()
): boolean {
  const cleanUser = normalizeId(userId)
  const cleanExam = normalizeId(examId)
  if (!cleanUser || !cleanExam) return false

  const ids: string[] = []
  const seen = new Set<string>()
  for (const [rawId, enabled] of Object.entries(bookmarks)) {
    if (!enabled) continue
    if (ids.length >= MAX_BOOKMARKS_PER_EXAM) break
    const qId = normalizeId(rawId)
    if (qId && !seen.has(qId)) {
      seen.add(qId)
      ids.push(qId)
    }
  }

  const payload: StoredBookmarksV1 = {
    version: STUDY_STORAGE_VERSION,
    questionIds: ids,
    updatedAt: nowIso,
  }
  return safeWriteJson(getBookmarksStorageKey(cleanUser, cleanExam), payload, storage)
}

export function listAllBookmarkedQuestionIds(
  userId: string,
  examIds: readonly string[],
  storage: StorageLike | null = getDefaultStorage()
): string[] {
  const cleanUser = normalizeId(userId)
  if (!cleanUser) return []

  const seen = new Set<string>()
  const result: string[] = []
  for (const examId of examIds) {
    const map = readUserBookmarks(cleanUser, examId, storage)
    for (const qId of Object.keys(map)) {
      if (!seen.has(qId)) {
        seen.add(qId)
        result.push(qId)
      }
    }
  }
  return result
}
