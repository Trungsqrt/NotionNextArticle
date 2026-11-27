/**
 * lib/study/local-progress/pending-bookmarks.ts — User-scoped pending sync op recovery
 * ────────────────────────────────────────────────────────────────────────────────────
 * Persists queued or failed bookmark add/remove mutations per `(userId, examId)` so
 * BookmarkSyncController and Active Recall can recover unsynced operations across
 * reloads, exam switches, or temporary offline periods.
 */

import {
  MAX_BOOKMARKS_PER_EXAM,
  STUDY_STORAGE_VERSION,
  getDefaultStorage,
  getPendingBookmarkOpsStorageKey,
  isValidIso,
  normalizeId,
  safeReadJson,
  safeRemove,
  safeWriteJson,
  type StorageLike,
} from './storage'

export interface PendingBookmarkOp {
  action: 'add' | 'remove'
  updatedAt: string
  /** Optional unique operation ID used to avoid clobbering newer pending ops across controller instances */
  opId?: string
}

export interface StoredPendingBookmarkOpsV1 {
  version: 1
  examId: string
  ops: Record<string, PendingBookmarkOp>
  updatedAt: string
}

export interface PendingBookmarkExamEntry {
  examId: string
  ops: Record<string, PendingBookmarkOp>
}

const MAX_SCANNED_STORAGE_KEYS = 2000

export function readPendingBookmarkOps(
  userId: string,
  examId: string,
  storage: StorageLike | null = getDefaultStorage()
): Record<string, PendingBookmarkOp> {
  const cleanUser = normalizeId(userId)
  const cleanExam = normalizeId(examId)
  if (!cleanUser || !cleanExam) return {}

  const parsed = safeReadJson(getPendingBookmarkOpsStorageKey(cleanUser, cleanExam), storage)
  if (!parsed || typeof parsed !== 'object') return {}
  const record = parsed as Partial<StoredPendingBookmarkOpsV1>
  if (
    record.version !== STUDY_STORAGE_VERSION ||
    record.examId !== cleanExam ||
    !record.ops ||
    typeof record.ops !== 'object'
  ) {
    return {}
  }

  const result: Record<string, PendingBookmarkOp> = {}
  let count = 0
  for (const [rawId, rawOp] of Object.entries(record.ops)) {
    if (count >= MAX_BOOKMARKS_PER_EXAM) break
    const qId = normalizeId(rawId)
    if (!qId || !rawOp || typeof rawOp !== 'object') continue
    const op = rawOp as Partial<PendingBookmarkOp>
    if (op.action !== 'add' && op.action !== 'remove') continue
    const cleanOpId = normalizeId(op.opId)
    result[qId] = {
      action: op.action,
      updatedAt: isValidIso(op.updatedAt) ? op.updatedAt : new Date(0).toISOString(),
      ...(cleanOpId ? { opId: cleanOpId } : {}),
    }
    count += 1
  }
  return result
}

/**
 * Discovers all exams with persisted pending bookmark operations for the
 * authenticated `userId`, independently of any loaded recall queue batch.
 * Strictly isolated to `userId`'s key prefix; never inspects other users' keys.
 */
export function listPendingBookmarkExams(
  userId: string,
  storage: StorageLike | null = getDefaultStorage(),
  options?: { examIdFilter?: string }
): PendingBookmarkExamEntry[] {
  const cleanUser = normalizeId(userId)
  if (!cleanUser || !storage) return []

  const cleanFilter = normalizeId(options?.examIdFilter)
  if (cleanFilter) {
    const ops = readPendingBookmarkOps(cleanUser, cleanFilter, storage)
    return Object.keys(ops).length > 0 ? [{ examId: cleanFilter, ops }] : []
  }

  if (typeof storage.length !== 'number' || typeof storage.key !== 'function') {
    return []
  }

  const prefix = `study-v1:u:${encodeURIComponent(cleanUser)}:bookmark-pending:`
  const results: PendingBookmarkExamEntry[] = []
  const seenExams = new Set<string>()

  let totalKeys = 0
  try {
    totalKeys = Math.min(Math.max(0, storage.length), MAX_SCANNED_STORAGE_KEYS)
  } catch {
    return []
  }

  for (let i = 0; i < totalKeys; i++) {
    let rawKey: string | null = null
    try {
      rawKey = storage.key(i)
    } catch {
      continue
    }
    if (!rawKey || !rawKey.startsWith(prefix)) continue

    const encodedExamId = rawKey.slice(prefix.length)
    if (!encodedExamId) continue

    let decodedExamId = ''
    try {
      decodedExamId = decodeURIComponent(encodedExamId)
    } catch {
      continue
    }

    const cleanExamId = normalizeId(decodedExamId)
    if (!cleanExamId || seenExams.has(cleanExamId)) continue
    seenExams.add(cleanExamId)

    const ops = readPendingBookmarkOps(cleanUser, cleanExamId, storage)
    if (Object.keys(ops).length > 0) {
      results.push({ examId: cleanExamId, ops })
    }
  }

  return results
}

export function writePendingBookmarkOps(
  userId: string,
  examId: string,
  ops: Readonly<Record<string, PendingBookmarkOp>>,
  storage: StorageLike | null = getDefaultStorage(),
  nowIso: string = new Date().toISOString()
): boolean {
  const cleanUser = normalizeId(userId)
  const cleanExam = normalizeId(examId)
  if (!cleanUser || !cleanExam) return false

  const key = getPendingBookmarkOpsStorageKey(cleanUser, cleanExam)
  const sanitized: Record<string, PendingBookmarkOp> = {}
  let count = 0

  for (const [rawId, op] of Object.entries(ops)) {
    if (count >= MAX_BOOKMARKS_PER_EXAM) break
    const qId = normalizeId(rawId)
    if (!qId || (op.action !== 'add' && op.action !== 'remove')) continue
    const cleanOpId = normalizeId(op.opId)
    sanitized[qId] = {
      action: op.action,
      updatedAt: isValidIso(op.updatedAt) ? op.updatedAt : nowIso,
      ...(cleanOpId ? { opId: cleanOpId } : {}),
    }
    count += 1
  }

  if (count === 0) {
    safeRemove(key, storage)
    return true
  }

  const payload: StoredPendingBookmarkOpsV1 = {
    version: STUDY_STORAGE_VERSION,
    examId: cleanExam,
    ops: sanitized,
    updatedAt: nowIso,
  }
  return safeWriteJson(key, payload, storage)
}
