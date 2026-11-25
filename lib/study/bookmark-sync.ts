/**
 * lib/study/bookmark-sync.ts — Non-blocking client bookmark synchronization controller
 * ────────────────────────────────────────────────────────────────────────────────────
 * Decouples bookmark persistence from Practice studying:
 * - Immediate optimistic updates with latest-intention semantics.
 * - Coalesces rapid toggles and multi-question bursts into a single serialized
 *   request per (userId, examId) — zero duplicate requests or race conditions.
 * - Cancels no-op round trips (e.g. bookmark then immediately unbookmark before flush).
 * - Bounded request timeouts, bounded automatic retry limits on transient errors,
 *   and strict respect for HTTP `Retry-After` headers.
 * - Persists pending/failed operations in user-scoped LocalStorage for recovery
 *   without rolling back or losing the user's latest intent.
 * - Never polls aggressively; exposes explicit manual `retry()`.
 */

import {
  readPendingBookmarkOps,
  writePendingBookmarkOps,
  type PendingBookmarkOp,
  type StorageLike,
} from './local-progress'

export type BookmarkSyncStatus = 'idle' | 'saving' | 'saved' | 'not_synced'

export interface BookmarkSyncSnapshot {
  /** Visible optimistic bookmarks (server-confirmed overlaid with pending ops) */
  bookmarks: Record<string, boolean>
  /** Last server-confirmed bookmark state */
  serverBookmarks: Record<string, boolean>
  /** True once GET /api/study/bookmarks or POST sync succeeded */
  loadedFromServer: boolean
  /** True while the initial independent GET /api/study/bookmarks is in flight */
  isInitialLoadPending: boolean
  /** Subtle status indicator: idle | saving | saved | not_synced */
  status: BookmarkSyncStatus
  /** Number of unsynced mutations awaiting server confirmation */
  pendingCount: number
  /** True when the initial load failed and bookmarks have not synced yet */
  loadFailed: boolean
  /** Subtle non-blocking message when status === 'not_synced' */
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
  /** Duration to show the subtle "Saved" confirmation before returning to idle (default: 2500ms) */
  savedIndicatorMs?: number
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>
}

interface PendingEntry {
  action: 'add' | 'remove'
  seq: number
  updatedAt: string
}

const TRANSIENT_HTTP_STATUSES = new Set([409, 429, 502, 503, 504])

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

export interface BookmarkSyncController {
  getSnapshot(): BookmarkSyncSnapshot
  setValidQuestionIds(validIds: ReadonlySet<string>): void
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
    savedIndicatorMs = 2500,
    sleepFn = defaultSleep,
  } = options

  let validQuestionIds: ReadonlySet<string> | undefined = options.validQuestionIds
  let serverBookmarks: Record<string, boolean> = {}
  let loadedFromServer = false
  let isInitialLoadPending = false
  let loadFailed = false
  let status: BookmarkSyncStatus = 'idle'
  let errorMessage: string | null = null

  let opSeq = 0
  let destroyed = false
  let flushInFlight = false
  let loadInFlight = false
  const inFlightQuestionIds = new Set<string>()
  const pendingOps = new Map<string, PendingEntry>()

  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let firstQueuedAtMs: number | null = null
  let savedFadeTimer: ReturnType<typeof setTimeout> | null = null
  let loadAbortController: AbortController | null = null
  const activeLoadSleepControllers = new Set<AbortController>()

  // Hydrate any unsynced pending/failed operations from user-scoped LocalStorage
  const storedPending =
    storage !== undefined
      ? readPendingBookmarkOps(userId, examId, storage)
      : readPendingBookmarkOps(userId, examId)

  for (const [qId, op] of Object.entries(storedPending)) {
    if (validQuestionIds && !validQuestionIds.has(qId)) continue
    opSeq += 1
    pendingOps.set(qId, {
      action: op.action,
      seq: opSeq,
      updatedAt: op.updatedAt,
    })
  }

  function persistPendingOps(): void {
    const serialized: Record<string, PendingBookmarkOp> = {}
    for (const [qId, entry] of pendingOps.entries()) {
      serialized[qId] = {
        action: entry.action,
        updatedAt: entry.updatedAt,
      }
    }
    if (storage !== undefined) {
      writePendingBookmarkOps(userId, examId, serialized, storage)
    } else {
      writePendingBookmarkOps(userId, examId, serialized)
    }
  }

  function filterIdsByExam(ids: readonly string[]): string[] {
    if (!validQuestionIds) return [...ids]
    return ids.filter((id) => validQuestionIds!.has(id))
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

  function getSnapshot(): BookmarkSyncSnapshot {
    return {
      bookmarks: computeVisibleBookmarks(),
      serverBookmarks: { ...serverBookmarks },
      loadedFromServer,
      isInitialLoadPending,
      status,
      pendingCount: pendingOps.size,
      loadFailed,
      errorMessage,
    }
  }

  function emit(): void {
    if (destroyed) return
    onStateChange(getSnapshot())
  }

  function clearSavedFadeTimer(): void {
    if (savedFadeTimer) {
      clearTimeout(savedFadeTimer)
      savedFadeTimer = null
    }
  }

  function clearDebounceTimer(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    firstQueuedAtMs = null
  }

  function markSaved(): void {
    clearSavedFadeTimer()
    status = 'saved'
    errorMessage = null
    emit()
    if (!destroyed && savedIndicatorMs > 0) {
      savedFadeTimer = setTimeout(() => {
        savedFadeTimer = null
        if (!destroyed && status === 'saved' && pendingOps.size === 0 && !flushInFlight) {
          status = 'idle'
          emit()
        }
      }, savedIndicatorMs)
    }
  }

  async function fetchWithBoundedRetry(
    url: string,
    init: RequestInit,
    outerSignal?: AbortSignal
  ): Promise<{ ok: true; data: { questionIds?: string[] } } | { ok: false; status: number | null; message: string }> {
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
      let failureMessage = 'Bookmark change not synced yet.'

      try {
        const res = await fetchImpl(url, {
          ...init,
          cache: 'no-store',
          signal: attemptController.signal,
        } as RequestInit)

        if (res.ok) {
          const data = (await res.json().catch(() => ({}))) as { questionIds?: string[] }
          return { ok: true, data }
        }

        failureStatus = res.status
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
        } else {
          failureMessage =
            res.status === 401 || res.status === 403
              ? 'Session expired — sign in again to sync bookmarks.'
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
        return { ok: false, status: failureStatus, message: failureMessage }
      }

      attempt += 1
      const sleepController = outerSignal ? null : new AbortController()
      if (sleepController && outerSignal) {
        activeLoadSleepControllers.add(sleepController)
      }
      try {
        await sleepFn(retryDelayMs, outerSignal || sleepController?.signal)
      } catch {
        return { ok: false, status: failureStatus, message: failureMessage }
      } finally {
        if (sleepController) {
          activeLoadSleepControllers.delete(sleepController)
        }
      }
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

    // Snapshot current pending entries with their sequence numbers so any
    // toggle occurring while this request is in flight is preserved afterwards.
    const sentEntries = Array.from(pendingOps.entries()).map(([qId, entry]) => ({
      questionId: qId,
      action: entry.action,
      seq: entry.seq,
    }))

    const add: string[] = []
    const remove: string[] = []
    for (const item of sentEntries) {
      if (item.action === 'add') add.push(item.questionId)
      else remove.push(item.questionId)
    }

    flushInFlight = true
    inFlightQuestionIds.clear()
    for (const item of sentEntries) {
      inFlightQuestionIds.add(item.questionId)
    }
    clearSavedFadeTimer()
    status = 'saving'
    errorMessage = null
    emit()

    // Intentionally omit `loadAbortController` signal so an exam switch does not
    // cancel an already-dispatched bookmark save in flight; LocalStorage is still updated on success.
    const result = await fetchWithBoundedRetry('/api/study/bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'sync',
        examId,
        add,
        remove,
      }),
    })

    flushInFlight = false
    inFlightQuestionIds.clear()

    if (result.ok) {
      const confirmedIds = filterIdsByExam(
        Array.isArray(result.data.questionIds) ? result.data.questionIds : []
      )
      serverBookmarks = questionIdsToBookmarkMap(confirmedIds)
      loadedFromServer = true
      loadFailed = false

      // Clear only operations whose sequence number matches what the server persisted
      for (const item of sentEntries) {
        const current = pendingOps.get(item.questionId)
        if (current && current.seq === item.seq) {
          pendingOps.delete(item.questionId)
        }
      }
      // Also prune any newer op that now already equals the confirmed server state
      for (const [qId, entry] of Array.from(pendingOps.entries())) {
        const serverHas = Boolean(serverBookmarks[qId])
        if (serverHas === (entry.action === 'add')) {
          pendingOps.delete(qId)
        }
      }

      persistPendingOps()

      if (pendingOps.size > 0) {
        status = 'saving'
        emit()
        scheduleFlush(destroyed)
      } else {
        markSaved()
      }
      return
    }

    // Failure after bounded retries: keep pendingOps intact in LocalStorage for recovery
    persistPendingOps()
    status = 'not_synced'
    errorMessage = result.message
    emit()
  }

  async function loadFromServer(): Promise<void> {
    if (destroyed || loadInFlight) return
    loadInFlight = true
    isInitialLoadPending = true
    loadFailed = false
    loadAbortController?.abort()
    const controller = new AbortController()
    loadAbortController = controller
    emit()

    const result = await fetchWithBoundedRetry(
      `/api/study/bookmarks?examId=${encodeURIComponent(examId)}`,
      { method: 'GET' },
      controller.signal
    )

    loadInFlight = false
    isInitialLoadPending = false
    if (loadAbortController === controller) {
      loadAbortController = null
    }
    if (destroyed || controller.signal.aborted) return

    if (result.ok) {
      const confirmedIds = filterIdsByExam(
        Array.isArray(result.data.questionIds) ? result.data.questionIds : []
      )
      serverBookmarks = questionIdsToBookmarkMap(confirmedIds)
      loadedFromServer = true
      loadFailed = false

      // Drop any locally queued op that already matches the authoritative server state
      for (const [qId, entry] of Array.from(pendingOps.entries())) {
        if (inFlightQuestionIds.has(qId)) continue
        const serverHas = Boolean(serverBookmarks[qId])
        if (serverHas === (entry.action === 'add')) {
          pendingOps.delete(qId)
        }
      }
      persistPendingOps()

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
    errorMessage = 'Could not load synced bookmarks.'
    emit()
  }

  function enqueue(questionId: string, action: 'add' | 'remove'): void {
    const cleanId = questionId.trim()
    if (!cleanId || destroyed) return

    opSeq += 1
    clearSavedFadeTimer()

    // Coalesce toggle-on-then-off back to confirmed server state with 0 network calls
    if (loadedFromServer && !inFlightQuestionIds.has(cleanId)) {
      const serverHas = Boolean(serverBookmarks[cleanId])
      if (serverHas === (action === 'add')) {
        pendingOps.delete(cleanId)
        persistPendingOps()
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
      seq: opSeq,
      updatedAt: new Date().toISOString(),
    })
    persistPendingOps()

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
    if (destroyed) return
    if (pendingOps.size > 0) {
      await flushNow()
      return
    }
    if (loadFailed || !loadedFromServer) {
      await loadFromServer()
    }
  }

  function applyServerSnapshot(questionIds: readonly string[]): void {
    if (destroyed) return
    const confirmedIds = filterIdsByExam(questionIds)
    serverBookmarks = questionIdsToBookmarkMap(confirmedIds)
    loadedFromServer = true
    loadFailed = false

    for (const [qId, entry] of Array.from(pendingOps.entries())) {
      if (inFlightQuestionIds.has(qId)) continue
      const serverHas = Boolean(serverBookmarks[qId])
      if (serverHas === (entry.action === 'add')) {
        pendingOps.delete(qId)
      }
    }
    persistPendingOps()

    if (pendingOps.size > 0) {
      emit()
      scheduleFlush(true)
    } else if (!flushInFlight) {
      markSaved()
    }
  }

  function setValidQuestionIds(nextValidIds: ReadonlySet<string>): void {
    validQuestionIds = nextValidIds
    // Filter any already-loaded maps against the exam's published question set
    const nextServer: Record<string, boolean> = {}
    for (const qId of Object.keys(serverBookmarks)) {
      if (nextValidIds.has(qId)) nextServer[qId] = true
    }
    serverBookmarks = nextServer

    let pendingChanged = false
    for (const qId of Array.from(pendingOps.keys())) {
      if (!nextValidIds.has(qId)) {
        pendingOps.delete(qId)
        pendingChanged = true
      }
    }
    if (pendingChanged) {
      persistPendingOps()
    }
    emit()
  }

  function destroy(): void {
    if (destroyed) return
    destroyed = true
    clearSavedFadeTimer()
    loadAbortController?.abort()
    for (const ctrl of activeLoadSleepControllers) {
      ctrl.abort()
    }
    activeLoadSleepControllers.clear()
    // If there are debounced unsaved changes when leaving this exam, flush them asynchronously
    // in the background so LocalStorage + Notion stay in sync without blocking navigation.
    if (debounceTimer) {
      clearDebounceTimer()
      if (pendingOps.size > 0 && !flushInFlight) {
        void flushNow()
      }
    }
  }

  return {
    getSnapshot,
    setValidQuestionIds,
    loadFromServer,
    toggle,
    enqueue,
    flushNow,
    retry,
    applyServerSnapshot,
    destroy,
  }
}
