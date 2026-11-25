/**
 * lib/study/bookmark-sync.ts — Hardened non-blocking client bookmark sync controller
 * ──────────────────────────────────────────────────────────────────────────────────
 * Decouples bookmark persistence from Practice studying while guaranteeing state
 * correctness across rapid toggles, slow GET responses, exam switches, reloads,
 * and multi-account sessions:
 *
 * - Optimistic UI updates immediately without blocking studying.
 * - Coalesces rapid toggles and bursts into single-flight `POST /api/study/bookmarks`
 *   (`action: 'sync'`) batches per `(userId, examId)` and cancels no-ops.
 * - Prevents stale `GET` responses from overwriting newer confirmed `POST` responses
 *   via a monotonic server-state version counter + aborting in-flight GETs on POST success.
 * - Uses a per-`(userId, examId)` active controller registry and per-operation `opId`s so
 *   an older destroyed controller finishing a background save NEVER overwrites newer
 *   pending LocalStorage operations created after switching away and returning.
 * - Validates every HTTP 200 payload (`examId`, `userId`, `questionIds`, and sent-op
 *   confirmation) before acknowledging or clearing pending changes.
 * - Sends `expectedUserId` so pending operations can never be applied under a different
 *   authenticated account.
 * - Bounded timeouts, bounded retries on transient errors, and `Retry-After` support.
 */

import {
  readPendingBookmarkOps,
  writePendingBookmarkOps,
  type PendingBookmarkOp,
  type StorageLike,
} from './local-progress'

export type BookmarkSyncStatus = 'idle' | 'saving' | 'saved' | 'not_synced'

export interface BookmarkConfirmedEvent {
  /** Monotonic confirmation ID so UI effects react exactly once per confirmed batch */
  id: number
  /** Question IDs whose mutations were confirmed persisted in this batch */
  questionIds: string[]
}

export interface BookmarkSyncSnapshot {
  /** Visible optimistic bookmarks (server-confirmed overlaid with pending ops) */
  bookmarks: Record<string, boolean>
  /** Last server-confirmed bookmark state */
  serverBookmarks: Record<string, boolean>
  /** True once GET /api/study/bookmarks or POST sync succeeded */
  loadedFromServer: boolean
  /** True while the initial independent GET /api/study/bookmarks is in flight */
  isInitialLoadPending: boolean
  /** Sync lifecycle status */
  status: BookmarkSyncStatus
  /** Number of unsynced mutations awaiting server confirmation */
  pendingCount: number
  /** Question IDs with queued or in-flight mutations */
  savingQuestionIds: string[]
  /** Latest confirmed server persistence batch (for question-scoped UI feedback) */
  lastConfirmedEvent: BookmarkConfirmedEvent | null
  /** True when the initial load failed and bookmarks have not synced yet */
  loadFailed: boolean
  /** Subtle non-blocking error message when status === 'not_synced' */
  errorMessage: string | null
}

export interface BookmarkSyncControllerOptions {
  userId: string
  examId: string
  /** Optional allowed question IDs for filtering hydrated bookmarks */
  validQuestionIds?: ReadonlySet<string>
  onStateChange: (snapshot: BookmarkSyncSnapshot) => void
  fetchImpl?: typeof fetch
  storage?: StorageLike | null
  /** Debounce window for coalescing rapid toggles (default: 250ms) */
  debounceMs?: number
  /** Maximum coalesce delay before flushing continuous rapid clicks (default: 1000ms) */
  maxCoalesceWaitMs?: number
  /** Per-request timeout in ms (default: 10000ms) */
  timeoutMs?: number
  /** Maximum automatic retries for transient failures (default: 2 -> up to 3 attempts) */
  maxRetries?: number
  /** Base exponential backoff delay in ms when Retry-After is absent (default: 750ms) */
  retryBaseDelayMs?: number
  /** Maximum delay honored from Retry-After header in ms (default: 30000ms) */
  maxRetryAfterMs?: number
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>
}

interface PendingEntry {
  action: 'add' | 'remove'
  opId: string
  updatedAt: string
}

interface SentOpEntry {
  questionId: string
  action: 'add' | 'remove'
  opId: string
}

interface ActiveControllerHandle {
  controllerId: number
  reconcileExternalSyncSuccess: (
    sentEntries: readonly SentOpEntry[],
    confirmedIds: readonly string[],
    syncSeq: number
  ) => void
  reconcileExternalSyncFailure: (
    sentEntries: readonly SentOpEntry[],
    message: string
  ) => void
}

const TRANSIENT_HTTP_STATUSES = new Set([409, 429, 502, 503, 504])

let globalControllerSeq = 0
let globalOpSeq = 0
let globalConfirmSeq = 0
let globalSyncSeq = 0

// Tracks the latest mounted controller per `(userId, examId)` so a background POST
// from an older destroyed controller reconciles cleanly into the newer controller
// instead of overwriting newer LocalStorage pending operations.
const activeControllersByKey = new Map<string, ActiveControllerHandle>()

function buildRegistryKey(userId: string, examId: string): string {
  return `${userId.trim()}::${examId.trim()}`
}

export function questionIdsToBookmarkMap(ids: readonly string[]): Record<string, boolean> {
  const map: Record<string, boolean> = {}
  for (const id of ids) {
    if (id) map[id] = true
  }
  return map
}

export function parseRetryAfterHeaderMs(
  headerValue: string | null,
  maxRetryAfterMs: number = 30_000,
  nowMs: number = Date.now()
): number | null {
  if (!headerValue) return null
  const trimmed = headerValue.trim()
  if (!trimmed) return null

  const numericSeconds = Number.parseFloat(trimmed)
  if (Number.isFinite(numericSeconds) && numericSeconds > 0) {
    return Math.min(Math.ceil(numericSeconds * 1000), maxRetryAfterMs)
  }

  const parsedDateMs = Date.parse(trimmed)
  if (!Number.isNaN(parsedDateMs)) {
    const deltaMs = parsedDateMs - nowMs
    if (deltaMs > 0) {
      return Math.min(deltaMs, maxRetryAfterMs)
    }
  }

  return null
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  if (signal?.aborted) return Promise.reject(new Error('Aborted'))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('Aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function validateBookmarkApiPayload(
  raw: unknown,
  expectedExamId: string,
  expectedUserId: string
): { ok: true; questionIds: string[] } | { ok: false; message: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'Invalid bookmark sync response.' }
  }
  const obj = raw as Record<string, unknown>

  if (typeof obj.examId !== 'string' || obj.examId.trim() !== expectedExamId) {
    return { ok: false, message: 'Bookmark response exam mismatch.' }
  }
  if (
    obj.userId !== undefined &&
    (typeof obj.userId !== 'string' || obj.userId.trim() !== expectedUserId)
  ) {
    return { ok: false, message: 'Signed-in account changed. Please refresh.' }
  }
  if (!Array.isArray(obj.questionIds)) {
    return { ok: false, message: 'Bookmark response missing persisted list.' }
  }

  const questionIds: string[] = []
  for (const item of obj.questionIds) {
    if (typeof item !== 'string' || !item.trim()) {
      return { ok: false, message: 'Bookmark response contained invalid question ID.' }
    }
    questionIds.push(item.trim())
  }

  return { ok: true, questionIds }
}

function verifySentOpsPersisted(
  sentEntries: readonly SentOpEntry[],
  confirmedIds: readonly string[]
): boolean {
  const confirmedSet = new Set(confirmedIds)
  for (const entry of sentEntries) {
    if (entry.action === 'add' && !confirmedSet.has(entry.questionId)) {
      return false
    }
    if (entry.action === 'remove' && confirmedSet.has(entry.questionId)) {
      return false
    }
  }
  return true
}

export interface BookmarkSyncController {
  getSnapshot(): BookmarkSyncSnapshot
  loadFromServer(): Promise<void>
  toggle(questionId: string): void
  enqueue(questionId: string, action: 'add' | 'remove'): void
  flushNow(): Promise<void>
  retry(): Promise<void>
  applyServerSnapshot(questionIds: readonly string[]): void
  destroy(): void
}

export function createBookmarkSyncController(
  options: BookmarkSyncControllerOptions
): BookmarkSyncController {
  const {
    userId,
    examId,
    onStateChange,
    fetchImpl = (...args: Parameters<typeof fetch>) => fetch(...args),
    storage,
    debounceMs = 250,
    maxCoalesceWaitMs = 1000,
    timeoutMs = 10_000,
    maxRetries = 2,
    retryBaseDelayMs = 750,
    maxRetryAfterMs = 30_000,
    sleepFn = defaultSleep,
  } = options

  const controllerId = ++globalControllerSeq
  const registryKey = buildRegistryKey(userId, examId)
  const validQuestionIds: ReadonlySet<string> | undefined = options.validQuestionIds

  let serverBookmarks: Record<string, boolean> = {}
  let serverStateVersion = 0
  let lastAppliedSyncSeq = 0
  let loadedFromServer = false
  let isInitialLoadPending = false
  let loadFailed = false
  let status: BookmarkSyncStatus = 'idle'
  let errorMessage: string | null = null
  let lastConfirmedEvent: BookmarkConfirmedEvent | null = null

  let destroyed = false
  let flushInFlight = false
  let loadInFlight = false
  const inFlightQuestionIds = new Set<string>()
  const pendingOps = new Map<string, PendingEntry>()

  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let firstQueuedAtMs: number | null = null
  let loadAbortController: AbortController | null = null

  function readStoragePending(): Record<string, PendingBookmarkOp> {
    return storage !== undefined
      ? readPendingBookmarkOps(userId, examId, storage)
      : readPendingBookmarkOps(userId, examId)
  }

  function writeStoragePending(ops: Readonly<Record<string, PendingBookmarkOp>>): void {
    if (storage !== undefined) {
      writePendingBookmarkOps(userId, examId, ops, storage)
    } else {
      writePendingBookmarkOps(userId, examId, ops)
    }
  }

  function isActiveOwner(): boolean {
    return !destroyed && activeControllersByKey.get(registryKey)?.controllerId === controllerId
  }

  // Hydrate any unsynced pending/failed operations from user-scoped LocalStorage
  const storedPending = readStoragePending()
  for (const [qId, op] of Object.entries(storedPending)) {
    if (validQuestionIds && !validQuestionIds.has(qId)) continue
    pendingOps.set(qId, {
      action: op.action,
      opId: op.opId || `restored-${++globalOpSeq}`,
      updatedAt: op.updatedAt,
    })
  }

  function persistOwnPendingOps(): void {
    if (!isActiveOwner()) return
    const serialized: Record<string, PendingBookmarkOp> = {}
    for (const [qId, entry] of pendingOps.entries()) {
      serialized[qId] = {
        action: entry.action,
        opId: entry.opId,
        updatedAt: entry.updatedAt,
      }
    }
    writeStoragePending(serialized)
  }

  /**
   * Used ONLY when a destroyed controller finishes a background POST and no newer
   * controller currently owns `(userId, examId)`: merges into LocalStorage by removing
   * only entries whose `opId` matches `sentEntries`, never erasing newer operations.
   */
  function removeConfirmedOpsFromStorageSafely(sentEntries: readonly SentOpEntry[]): void {
    const current = readStoragePending()
    let modified = false
    for (const item of sentEntries) {
      const stored = current[item.questionId]
      if (stored && stored.opId === item.opId) {
        delete current[item.questionId]
        modified = true
      }
    }
    if (modified) {
      writeStoragePending(current)
    }
  }

  function filterIdsByExam(ids: readonly string[]): string[] {
    if (!validQuestionIds) return [...ids]
    return ids.filter((id) => validQuestionIds.has(id))
  }

  function computeVisibleBookmarks(): Record<string, boolean> {
    const visible: Record<string, boolean> = { ...serverBookmarks }
    for (const [qId, entry] of pendingOps.entries()) {
      if (entry.action === 'add') {
        visible[qId] = true
      } else {
        delete visible[qId]
      }
    }
    return visible
  }

  function getSavingQuestionIds(): string[] {
    const set = new Set<string>(inFlightQuestionIds)
    for (const qId of pendingOps.keys()) {
      set.add(qId)
    }
    return Array.from(set)
  }

  function getSnapshot(): BookmarkSyncSnapshot {
    return {
      bookmarks: computeVisibleBookmarks(),
      serverBookmarks: { ...serverBookmarks },
      loadedFromServer,
      isInitialLoadPending,
      status,
      pendingCount: pendingOps.size,
      savingQuestionIds: status === 'saving' || flushInFlight ? getSavingQuestionIds() : [],
      lastConfirmedEvent,
      loadFailed,
      errorMessage,
    }
  }

  function emit(): void {
    if (!isActiveOwner()) return
    onStateChange(getSnapshot())
  }

  function clearDebounceTimer(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    firstQueuedAtMs = null
  }

  async function fetchWithBoundedRetry(
    url: string,
    init: RequestInit,
    outerSignal?: AbortSignal
  ): Promise<
    | { ok: true; questionIds: string[] }
    | { ok: false; status: number | null; code?: string; message: string }
  > {
    let attempt = 0
    while (true) {
      if (outerSignal?.aborted) {
        return { ok: false, status: null, message: 'Request cancelled.' }
      }

      const attemptController = new AbortController()
      const onOuterAbort = () => attemptController.abort()
      outerSignal?.addEventListener('abort', onOuterAbort, { once: true })

      let timedOut = false
      const timeoutTimer = setTimeout(() => {
        timedOut = true
        attemptController.abort()
      }, timeoutMs)

      let shouldRetry = false
      let retryDelayMs = retryBaseDelayMs * Math.pow(2, attempt)
      let failureStatus: number | null = null
      let failureCode: string | undefined
      let failureMessage = 'Bookmark not synced yet.'

      try {
        const res = await fetchImpl(url, {
          ...init,
          cache: 'no-store',
          signal: attemptController.signal,
        } as RequestInit)

        if (res.ok) {
          let parsedJson: unknown
          try {
            parsedJson = await res.json()
          } catch {
            return {
              ok: false,
              status: res.status,
              code: 'INVALID_RESPONSE',
              message: 'Could not verify bookmark sync response.',
            }
          }
          const validated = validateBookmarkApiPayload(parsedJson, examId, userId)
          if (!validated.ok) {
            return {
              ok: false,
              status: res.status,
              code: 'INVALID_RESPONSE',
              message: validated.message,
            }
          }
          return { ok: true, questionIds: validated.questionIds }
        }

        failureStatus = res.status
        try {
          const errJson = (await res.json()) as { code?: unknown }
          if (typeof errJson?.code === 'string') {
            failureCode = errJson.code
          }
        } catch {
          // Ignore non-JSON error body
        }

        const retryAfterMs = parseRetryAfterHeaderMs(
          res.headers?.get?.('retry-after') ?? null,
          maxRetryAfterMs
        )
        if (retryAfterMs !== null) {
          retryDelayMs = retryAfterMs
        }

        if (TRANSIENT_HTTP_STATUSES.has(res.status)) {
          shouldRetry = true
          failureMessage =
            res.status === 429
              ? 'Sync busy — retry when ready.'
              : 'Bookmark not synced yet.'
        } else if (failureCode === 'ACCOUNT_MISMATCH') {
          failureMessage = 'Signed-in account changed — refresh to sync.'
        } else {
          failureMessage =
            res.status === 401 || res.status === 403
              ? 'Session expired — sign in again to sync.'
              : 'Bookmark could not be synced.'
        }
      } catch {
        if (outerSignal?.aborted) {
          return { ok: false, status: null, message: 'Request cancelled.' }
        }
        shouldRetry = true
        failureMessage = timedOut
          ? 'Sync timed out — saved locally.'
          : 'Offline or unavailable — saved locally.'
      } finally {
        clearTimeout(timeoutTimer)
        outerSignal?.removeEventListener('abort', onOuterAbort)
      }

      if (!shouldRetry || attempt >= maxRetries) {
        return {
          ok: false,
          status: failureStatus,
          code: failureCode,
          message: failureMessage,
        }
      }

      attempt += 1
      try {
        await sleepFn(retryDelayMs, outerSignal)
      } catch {
        return {
          ok: false,
          status: failureStatus,
          code: failureCode,
          message: failureMessage,
        }
      }
    }
  }

  function applyConfirmedSyncState(
    sentEntries: readonly SentOpEntry[],
    confirmedIds: readonly string[],
    recordConfirmationEvent: boolean,
    syncSeq?: number
  ): void {
    if (typeof syncSeq === 'number') {
      if (syncSeq < lastAppliedSyncSeq) {
        return
      }
      lastAppliedSyncSeq = syncSeq
    }
    const filteredIds = filterIdsByExam(confirmedIds)
    serverStateVersion += 1
    // Cancel any stale initial GET now that a newer authoritative POST succeeded
    loadAbortController?.abort()
    loadInFlight = false
    isInitialLoadPending = false

    serverBookmarks = questionIdsToBookmarkMap(filteredIds)
    loadedFromServer = true
    loadFailed = false

    // Clear ONLY operations whose opId matches what the server actually persisted
    for (const item of sentEntries) {
      const current = pendingOps.get(item.questionId)
      if (current && current.opId === item.opId) {
        pendingOps.delete(item.questionId)
      }
    }
    // Prune any newer op not currently in flight that already matches the confirmed server state
    for (const [qId, entry] of Array.from(pendingOps.entries())) {
      if (inFlightQuestionIds.has(qId)) continue
      const serverHas = Boolean(serverBookmarks[qId])
      if (serverHas === (entry.action === 'add')) {
        pendingOps.delete(qId)
      }
    }

    persistOwnPendingOps()

    if (recordConfirmationEvent && sentEntries.length > 0) {
      lastConfirmedEvent = {
        id: ++globalConfirmSeq,
        questionIds: sentEntries.map((item) => item.questionId),
      }
    }

    if (pendingOps.size > 0) {
      status = 'saving'
      errorMessage = null
      emit()
      scheduleFlush(false)
    } else {
      status = 'saved'
      errorMessage = null
      emit()
    }
  }

  function scheduleFlush(immediate: boolean = false): void {
    if (flushInFlight || pendingOps.size === 0) return

    if (immediate || debounceMs <= 0) {
      clearDebounceTimer()
      void flushNow()
      return
    }

    const now = Date.now()
    if (firstQueuedAtMs === null) {
      firstQueuedAtMs = now
    }
    const elapsed = now - firstQueuedAtMs
    const remainingMaxWait = Math.max(0, maxCoalesceWaitMs - elapsed)
    const delay = Math.min(debounceMs, remainingMaxWait)

    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }
    debounceTimer = setTimeout(() => {
      clearDebounceTimer()
      void flushNow()
    }, delay)
  }

  async function flushNow(): Promise<void> {
    clearDebounceTimer()
    if (flushInFlight || pendingOps.size === 0) return

    const sentEntries: SentOpEntry[] = Array.from(pendingOps.entries()).map(([qId, entry]) => ({
      questionId: qId,
      action: entry.action,
      opId: entry.opId,
    }))

    const add: string[] = []
    const remove: string[] = []
    for (const item of sentEntries) {
      if (item.action === 'add') add.push(item.questionId)
      else remove.push(item.questionId)
    }

    const syncSeq = ++globalSyncSeq
    flushInFlight = true
    inFlightQuestionIds.clear()
    for (const item of sentEntries) {
      inFlightQuestionIds.add(item.questionId)
    }
    status = 'saving'
    errorMessage = null
    emit()

    const result = await fetchWithBoundedRetry('/api/study/bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'sync',
        examId,
        add,
        remove,
        expectedUserId: userId,
      }),
    })

    flushInFlight = false
    inFlightQuestionIds.clear()

    const persistenceVerified =
      result.ok && verifySentOpsPersisted(sentEntries, result.questionIds)

    // If this controller was destroyed or superseded while the POST was in flight,
    // NEVER overwrite newer LocalStorage pending operations from another controller!
    if (!isActiveOwner()) {
      const currentOwner = activeControllersByKey.get(registryKey)
      if (persistenceVerified && result.ok) {
        if (currentOwner && currentOwner.controllerId !== controllerId) {
          currentOwner.reconcileExternalSyncSuccess(sentEntries, result.questionIds, syncSeq)
        } else {
          removeConfirmedOpsFromStorageSafely(sentEntries)
        }
      } else if (currentOwner && currentOwner.controllerId !== controllerId) {
        currentOwner.reconcileExternalSyncFailure(
          sentEntries,
          result.ok ? 'Bookmark sync could not be confirmed.' : result.message
        )
      }
      return
    }

    if (persistenceVerified && result.ok) {
      applyConfirmedSyncState(sentEntries, result.questionIds, true, syncSeq)
      return
    }

    // Failure or unconfirmed payload: preserve pendingOps intact in LocalStorage for recovery
    persistOwnPendingOps()
    status = 'not_synced'
    errorMessage = result.ok
      ? 'Bookmark change was not confirmed by server.'
      : result.message
    emit()
  }

  async function loadFromServer(): Promise<void> {
    if (!isActiveOwner() || loadInFlight) return
    loadInFlight = true
    isInitialLoadPending = true
    loadFailed = false
    const loadStartedVersion = serverStateVersion

    loadAbortController?.abort()
    const controller = new AbortController()
    loadAbortController = controller
    emit()

    const result = await fetchWithBoundedRetry(
      `/api/study/bookmarks?examId=${encodeURIComponent(examId)}`,
      { method: 'GET' },
      controller.signal
    )

    if (loadAbortController === controller) {
      loadAbortController = null
    }
    loadInFlight = false
    isInitialLoadPending = false

    if (!isActiveOwner() || controller.signal.aborted) return

    // Never allow a stale GET response to overwrite a newer confirmed POST response!
    if (serverStateVersion > loadStartedVersion) {
      emit()
      return
    }

    if (result.ok) {
      const confirmedIds = filterIdsByExam(result.questionIds)
      serverStateVersion += 1
      serverBookmarks = questionIdsToBookmarkMap(confirmedIds)
      loadedFromServer = true
      loadFailed = false

      // Drop any locally queued op (not in flight) that already matches the server state
      for (const [qId, entry] of Array.from(pendingOps.entries())) {
        if (inFlightQuestionIds.has(qId)) continue
        const serverHas = Boolean(serverBookmarks[qId])
        if (serverHas === (entry.action === 'add')) {
          pendingOps.delete(qId)
        }
      }
      persistOwnPendingOps()

      if (pendingOps.size > 0) {
        status = 'saving'
        errorMessage = null
        emit()
        scheduleFlush(true)
      } else if (!flushInFlight) {
        if (status === 'not_synced') {
          status = 'idle'
          errorMessage = null
        }
        emit()
      }
      return
    }

    loadFailed = true
    status = 'not_synced'
    errorMessage = result.message || 'Could not load synced bookmarks.'
    emit()
  }

  function enqueue(questionId: string, action: 'add' | 'remove'): void {
    const cleanId = questionId.trim()
    if (!cleanId || !isActiveOwner()) return

    // Coalesce toggle-on-then-off back to confirmed server state with 0 network calls
    if (loadedFromServer && !inFlightQuestionIds.has(cleanId)) {
      const serverHas = Boolean(serverBookmarks[cleanId])
      if (serverHas === (action === 'add')) {
        pendingOps.delete(cleanId)
        persistOwnPendingOps()
        if (pendingOps.size === 0 && !flushInFlight) {
          clearDebounceTimer()
          status = loadFailed ? 'not_synced' : 'idle'
          errorMessage = loadFailed ? 'Could not load synced bookmarks.' : null
        }
        emit()
        return
      }
    }

    pendingOps.set(cleanId, {
      action,
      opId: `${controllerId}-${++globalOpSeq}`,
      updatedAt: new Date().toISOString(),
    })
    persistOwnPendingOps()

    status = 'saving'
    errorMessage = null
    emit()
    scheduleFlush(false)
  }

  function toggle(questionId: string): void {
    const visible = computeVisibleBookmarks()
    const nextAction: 'add' | 'remove' = visible[questionId] ? 'remove' : 'add'
    enqueue(questionId, nextAction)
  }

  async function retry(): Promise<void> {
    if (!isActiveOwner()) return
    if (pendingOps.size > 0) {
      await flushNow()
      return
    }
    if (loadFailed || !loadedFromServer) {
      await loadFromServer()
    }
  }

  function applyServerSnapshot(questionIds: readonly string[]): void {
    if (!isActiveOwner()) return
    applyConfirmedSyncState([], questionIds, false)
  }

  // Register as the active controller for `(userId, examId)`
  const handle: ActiveControllerHandle = {
    controllerId,
    reconcileExternalSyncSuccess(sentEntries, confirmedIds, syncSeq) {
      if (!isActiveOwner()) return
      applyConfirmedSyncState(sentEntries, confirmedIds, false, syncSeq)
    },
    reconcileExternalSyncFailure(_sentEntries, message) {
      if (!isActiveOwner()) return
      if (pendingOps.size > 0 && !flushInFlight) {
        status = 'not_synced'
        errorMessage = message
        emit()
      }
    },
  }
  activeControllersByKey.set(registryKey, handle)

  function destroy(): void {
    if (destroyed) return
    destroyed = true
    if (activeControllersByKey.get(registryKey)?.controllerId === controllerId) {
      activeControllersByKey.delete(registryKey)
    }
    loadAbortController?.abort()
    // If there are debounced unsaved changes when leaving this exam, flush them asynchronously
    // in the background so Notion + LocalStorage stay in sync without blocking navigation.
    if (debounceTimer) {
      clearDebounceTimer()
      if (pendingOps.size > 0 && !flushInFlight) {
        void flushNow()
      }
    }
  }

  return {
    getSnapshot,
    loadFromServer,
    toggle,
    enqueue,
    flushNow,
    retry,
    applyServerSnapshot,
    destroy,
  }
}

// ── Minimal Question-Scoped Bookmark Feedback Controller ────────────────────

export type BookmarkTransientFeedbackPhase = 'hidden' | 'loading' | 'success'

export interface QuestionBookmarkFeedbackController {
  getPhase(): BookmarkTransientFeedbackPhase
  setActiveQuestion(questionId: string | null): void
  onBookmarkTriggered(questionId: string): void
  onSyncSnapshot(snapshot: BookmarkSyncSnapshot): void
  destroy(): void
}

/**
 * Coordinates minimal, question-scoped bookmark UI feedback:
 * - No visible Saving/Saved text during normal fast sync.
 * - Shows a subtle loading indicator ONLY if saving exceeds `loadingDelayMs` (400ms).
 * - Shows a small success checkmark for `successDurationMs` (600ms) after confirmed
 *   persistence on the triggering question only.
 * - Immediately hides transient feedback on question navigation without canceling sync,
 *   and never displays a delayed checkmark on an unrelated question.
 */
export function createQuestionBookmarkFeedback(options: {
  onPhaseChange: (phase: BookmarkTransientFeedbackPhase) => void
  loadingDelayMs?: number
  successDurationMs?: number
}): QuestionBookmarkFeedbackController {
  const loadingDelayMs = options.loadingDelayMs ?? 400
  const successDurationMs = options.successDurationMs ?? 600

  let activeQuestionId: string | null = null
  let triggeredQuestionId: string | null = null
  let phase: BookmarkTransientFeedbackPhase = 'hidden'
  let lastHandledConfirmId = 0
  let loadingTimer: ReturnType<typeof setTimeout> | null = null
  let successTimer: ReturnType<typeof setTimeout> | null = null
  let destroyed = false

  function clearTimers(): void {
    if (loadingTimer) {
      clearTimeout(loadingTimer)
      loadingTimer = null
    }
    if (successTimer) {
      clearTimeout(successTimer)
      successTimer = null
    }
  }

  function setPhase(next: BookmarkTransientFeedbackPhase): void {
    if (destroyed || phase === next) return
    phase = next
    options.onPhaseChange(phase)
  }

  return {
    getPhase: () => phase,

    setActiveQuestion(questionId: string | null) {
      if (destroyed || questionId === activeQuestionId) return
      activeQuestionId = questionId
      triggeredQuestionId = null
      clearTimers()
      setPhase('hidden')
    },

    onBookmarkTriggered(questionId: string) {
      if (destroyed || !questionId || questionId !== activeQuestionId) return
      triggeredQuestionId = questionId
      clearTimers()
      setPhase('hidden')
      loadingTimer = setTimeout(() => {
        loadingTimer = null
        if (!destroyed && activeQuestionId === questionId && triggeredQuestionId === questionId) {
          setPhase('loading')
        }
      }, loadingDelayMs)
    },

    onSyncSnapshot(snapshot: BookmarkSyncSnapshot) {
      if (destroyed) return

      if (snapshot.status === 'not_synced') {
        clearTimers()
        triggeredQuestionId = null
        setPhase('hidden')
        return
      }

      const confirmed = snapshot.lastConfirmedEvent
      if (confirmed && confirmed.id > lastHandledConfirmId) {
        lastHandledConfirmId = confirmed.id
        const stillSavingActive =
          activeQuestionId !== null && snapshot.savingQuestionIds.includes(activeQuestionId)
        if (
          activeQuestionId !== null &&
          triggeredQuestionId === activeQuestionId &&
          confirmed.questionIds.includes(activeQuestionId) &&
          !stillSavingActive
        ) {
          clearTimers()
          triggeredQuestionId = null
          setPhase('success')
          successTimer = setTimeout(() => {
            successTimer = null
            setPhase('hidden')
          }, successDurationMs)
          return
        }
      }

      // If the triggered question is no longer saving (e.g. rapid toggle-on-then-off no-op)
      if (
        triggeredQuestionId &&
        !snapshot.savingQuestionIds.includes(triggeredQuestionId)
      ) {
        clearTimers()
        triggeredQuestionId = null
        if (phase === 'loading') {
          setPhase('hidden')
        }
      }
    },

    destroy() {
      if (destroyed) return
      destroyed = true
      clearTimers()
      triggeredQuestionId = null
      activeQuestionId = null
      phase = 'hidden'
    },
  }
}
