/**
 * lib/study/concurrency/distributed-lock.ts — Reusable lease-renewing distributed lock
 * ────────────────────────────────────────────────────────────────────────────────────
 * Combines:
 *   1. An in-process per-key async mutex (serializes concurrent requests on the same instance
 *      and provides safe local development / single-instance execution).
 *   2. An Upstash Redis lease lock (`SET NX PX` + periodic owner-checked Lua `PEXPIRE`
 *      heartbeat renewal + owner-checked Lua `DEL` release) when Upstash Redis is configured.
 *
 * Safety properties:
 *   - Heartbeat renewal keeps lock ownership alive even when slow downstream Notion calls
 *     (throttling, timeouts, retries, or `Retry-After`) exceed a short single-shot TTL.
 *   - Exposes `lease.assertValid()` so critical sections can verify lock ownership right before
 *     issuing a Notion write; if renewal failed or ownership was lost, the write is aborted
 *     with `DistributedLockLostError` instead of proceeding unsafely.
 *   - Fails closed (`DistributedLockUnavailableError`) whenever Upstash Redis is configured
 *     but unreachable/failing, or when `STUDY_DISTRIBUTED_LOCK_FAIL_CLOSED=true` in production.
 *
 * Remaining consistency limitation:
 *   Redis lease locks + pre-write ownership checks do not provide true database-level ACID
 *   fencing tokens in Notion (Notion does not support atomic compare-and-swap on property updates).
 *   A severe process pause right after `lease.assertValid()` and before the HTTP write reaches
 *   Notion could still race if the lease expires in that narrow window.
 */

import { randomUUID } from 'node:crypto'
import { ConcurrencyConflictError } from '../repositories/interfaces'

export class DistributedLockUnavailableError extends Error {
  readonly code = 'LOCK_UNAVAILABLE'
  readonly status = 503

  constructor(message: string = 'Distributed lock service is temporarily unavailable.') {
    super(message)
    this.name = 'DistributedLockUnavailableError'
  }
}

export class DistributedLockLostError extends Error {
  readonly code = 'LOCK_LOST'
  readonly status = 409

  constructor(lockKey: string) {
    super(`Distributed lock ownership was lost before completing operation for "${lockKey}".`)
    this.name = 'DistributedLockLostError'
  }
}

export interface DistributedLockLease {
  readonly key: string
  readonly distributed: boolean
  /** Returns false if the distributed lease expired or renewal failed */
  isValid(): boolean
  /** Throws DistributedLockLostError if lock ownership is no longer guaranteed */
  assertValid(): void
}

export interface DistributedLockOptions {
  /** Lease TTL in ms (default: 30000ms to cover Notion timeouts + throttling + retries) */
  ttlMs?: number
  /** Heartbeat renewal interval in ms (default: floor(ttlMs / 3)) */
  renewIntervalMs?: number
  /** Max acquisition retry attempts when another instance holds the lock (default: 6) */
  maxAcquireAttempts?: number
  /** Base retry delay in ms between acquisition attempts (default: 80ms) */
  acquireBaseDelayMs?: number
  /** Per-Redis-HTTP-call timeout in ms (default: 3000ms) */
  redisTimeoutMs?: number
  /** Custom fetch implementation for testing */
  fetchImpl?: typeof fetch
  /** Force fail-closed behavior if Redis is unconfigured */
  requireDistributedInProduction?: boolean
}

const inProcessLocks = new Map<string, Promise<unknown>>()
let hasWarnedMissingDistributedLock = false

const RENEW_LOCK_LUA =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end'

const RELEASE_LOCK_LUA =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getUpstashLockConfig(): { url: string; token: string } | null {
  const url = (process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '')
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim()
  if (!url || !token) return null
  return { url, token }
}

async function withInProcessLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = inProcessLocks.get(key) || Promise.resolve()
  const next = prev.then(task, task)
  const cleanup = next.then(
    () => {
      if (inProcessLocks.get(key) === cleanup) inProcessLocks.delete(key)
    },
    () => {
      if (inProcessLocks.get(key) === cleanup) inProcessLocks.delete(key)
    }
  )
  inProcessLocks.set(key, cleanup)
  return next
}

async function runRedisPipeline(
  upstash: { url: string; token: string },
  commands: string[][],
  timeoutMs: number,
  fetchImpl: typeof fetch
): Promise<{ ok: true; result: unknown } | { ok: false }> {
  try {
    const res = await fetchImpl(`${upstash.url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${upstash.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { ok: false }
    const payload = (await res.json()) as Array<{ result?: unknown; error?: unknown }>
    if (!Array.isArray(payload) || payload.length === 0 || payload[0]?.error) {
      return { ok: false }
    }
    return { ok: true, result: payload[0]?.result }
  } catch {
    return { ok: false }
  }
}

export async function withDistributedLock<T>(
  lockKey: string,
  task: (lease: DistributedLockLease) => Promise<T>,
  options: DistributedLockOptions = {}
): Promise<T> {
  const ttlMs = Math.max(200, options.ttlMs ?? 30_000)
  const renewIntervalMs = Math.max(
    50,
    options.renewIntervalMs ?? Math.floor(ttlMs / 3)
  )
  const maxAcquireAttempts = Math.max(1, options.maxAcquireAttempts ?? 6)
  const acquireBaseDelayMs = Math.max(10, options.acquireBaseDelayMs ?? 80)
  const redisTimeoutMs = Math.max(200, options.redisTimeoutMs ?? 3000)
  const fetchImpl = options.fetchImpl ?? fetch

  return withInProcessLock(lockKey, async () => {
    const upstash = getUpstashLockConfig()

    if (!upstash) {
      const isProd = process.env.NODE_ENV === 'production'
      const failClosed =
        options.requireDistributedInProduction ??
        process.env.STUDY_DISTRIBUTED_LOCK_FAIL_CLOSED === 'true'

      if (isProd && failClosed) {
        console.error('[study-lock] distributed_lock_unconfigured_fail_closed', {
          namespace: lockKey.split(':').slice(0, 3).join(':'),
        })
        throw new DistributedLockUnavailableError(
          'Distributed lock storage is required in production but not configured.'
        )
      }

      if (isProd && !hasWarnedMissingDistributedLock) {
        hasWarnedMissingDistributedLock = true
        console.warn('[study-lock] distributed_lock_unconfigured', {
          message:
            'UPSTASH_REDIS_REST_URL/TOKEN not set; falling back to per-instance mutex only.',
        })
      }

      return task({
        key: lockKey,
        distributed: false,
        isValid: () => true,
        assertValid: () => {},
      })
    }

    const lockToken = randomUUID()
    let acquired = false
    let leaseExpiresAtMs = 0

    for (let attempt = 0; attempt < maxAcquireAttempts; attempt++) {
      const callStartedAt = Date.now()
      const res = await runRedisPipeline(
        upstash,
        [['SET', lockKey, lockToken, 'NX', 'PX', String(ttlMs)]],
        redisTimeoutMs,
        fetchImpl
      )

      if (!res.ok) {
        // Never silently proceed with an unlocked write when configured Redis fails
        console.error('[study-lock] acquire_redis_unavailable', {
          namespace: lockKey.split(':').slice(0, 3).join(':'),
          attempt: attempt + 1,
        })
        throw new DistributedLockUnavailableError()
      }

      if (res.result === 'OK') {
        acquired = true
        leaseExpiresAtMs = callStartedAt + ttlMs
        break
      }

      if (attempt + 1 < maxAcquireAttempts) {
        await sleep(acquireBaseDelayMs * (attempt + 1))
      }
    }

    if (!acquired) {
      throw new ConcurrencyConflictError(lockKey, -1, -1)
    }

    let leaseLost = false
    let released = false
    let renewInFlight = false

    const renewOnce = async () => {
      if (released || leaseLost || renewInFlight) return
      renewInFlight = true
      const callStartedAt = Date.now()
      try {
        const res = await runRedisPipeline(
          upstash,
          [['EVAL', RENEW_LOCK_LUA, '1', lockKey, lockToken, String(ttlMs)]],
          redisTimeoutMs,
          fetchImpl
        )
        if (released) return
        if (!res.ok) {
          if (Date.now() >= leaseExpiresAtMs) {
            leaseLost = true
          }
          return
        }
        if (Number(res.result) === 1) {
          leaseExpiresAtMs = callStartedAt + ttlMs
        } else {
          leaseLost = true
        }
      } finally {
        renewInFlight = false
      }
    }

    const renewTimer = setInterval(() => {
      void renewOnce()
    }, renewIntervalMs)
    if (typeof (renewTimer as { unref?: () => void }).unref === 'function') {
      ;(renewTimer as { unref: () => void }).unref()
    }

    const lease: DistributedLockLease = {
      key: lockKey,
      distributed: true,
      isValid: () => !leaseLost && Date.now() < leaseExpiresAtMs,
      assertValid: () => {
        if (leaseLost || Date.now() >= leaseExpiresAtMs) {
          throw new DistributedLockLostError(lockKey)
        }
      },
    }

    try {
      return await task(lease)
    } finally {
      released = true
      clearInterval(renewTimer)
      await runRedisPipeline(
        upstash,
        [['EVAL', RELEASE_LOCK_LUA, '1', lockKey, lockToken]],
        redisTimeoutMs,
        fetchImpl
      )
    }
  })
}
