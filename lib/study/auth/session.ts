/**
 * lib/study/auth/session.ts — Session issuance, validation & revocation
 * ─────────────────────────────────────────────────────────────────────
 * Coordinates cryptographic session tokens with live StudyUserRepository
 * checks (status === 'active' and credentialVersion match) so revoked users
 * and rotated credentials are rejected server-side.
 */

import type { SafeStudyUser, StudyUser } from '../types'
import { normalizeUsername, toSafeStudyUser } from '../schemas'
import { getStudyAuthConfig, type StudyAuthConfig } from '../config'
import type { StudyUserRepository } from '../repositories/interfaces'
import {
  verifyAccessKey,
  runDummyKeyVerification,
  signSessionToken,
  verifySessionToken,
  type StudySessionPayload,
} from './crypto'

export const STUDY_COOKIE_NAME_PROD = '__Host-study_session'
export const STUDY_COOKIE_NAME_DEV = 'study_session'

const USER_STATUS_CACHE_TTL_MS = 60 * 1000 // 60s bounded cache for session re-validation (immediately evicted on revoke)
const USER_STATUS_CACHE_MAX_ENTRIES = 100

interface CachedUserEntry {
  user: StudyUser | null
  cachedAt: number
}

function getUserStatusCache(): Map<string, CachedUserEntry> {
  const g = globalThis as unknown as { __studyUserStatusCache?: Map<string, CachedUserEntry> }
  if (!g.__studyUserStatusCache) {
    g.__studyUserStatusCache = new Map()
  }
  return g.__studyUserStatusCache
}

export function invalidateCachedStudyUser(userId: string): void {
  getUserStatusCache().delete(userId.trim())
}

export function clearStudyUserStatusCache(): void {
  getUserStatusCache().clear()
}

export function getStudySessionCookieName(isProduction: boolean = process.env.NODE_ENV === 'production'): string {
  return isProduction ? STUDY_COOKIE_NAME_PROD : STUDY_COOKIE_NAME_DEV
}

export function buildSessionCookieOptions(
  maxAgeSec: number,
  isProduction: boolean = process.env.NODE_ENV === 'production'
) {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSec,
    expires: new Date(Date.now() + maxAgeSec * 1000),
  }
}

export function buildExpiredCookieOptions(
  isProduction: boolean = process.env.NODE_ENV === 'production'
) {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 0,
    expires: new Date(0),
  }
}

export type AuthenticateResult =
  | { ok: true; user: SafeStudyUser; token: string; maxAgeSec: number }
  | { ok: false; reason: 'invalid_credentials' | 'revoked' }

/**
 * Verifies username + access key against StudyUserRepository and issues a
 * signed session token on success.
 */
export async function authenticateWithAccessKey(
  rawUsername: string,
  plainAccessKey: string,
  deps: {
    userRepo: StudyUserRepository
    authConfig?: StudyAuthConfig
    nowSec?: number
  }
): Promise<AuthenticateResult> {
  const authConfig = deps.authConfig || getStudyAuthConfig()
  const nowSec = deps.nowSec ?? Math.floor(Date.now() / 1000)

  let username: string
  try {
    username = normalizeUsername(rawUsername)
  } catch {
    runDummyKeyVerification(plainAccessKey)
    return { ok: false, reason: 'invalid_credentials' }
  }

  const user = await deps.userRepo.findByUsername(username)
  if (!user) {
    runDummyKeyVerification(plainAccessKey)
    return { ok: false, reason: 'invalid_credentials' }
  }

  const keyValid = verifyAccessKey(plainAccessKey, user.accessKeyHash, user.hashVersion)
  if (!keyValid) {
    return { ok: false, reason: 'invalid_credentials' }
  }

  if (user.status !== 'active') {
    return { ok: false, reason: 'revoked' }
  }

  const maxAgeSec = authConfig.sessionTtlHours * 3600
  const payload: StudySessionPayload = {
    sub: user.userId,
    usr: user.username,
    role: user.role,
    cv: user.credentialVersion,
    iat: nowSec,
    exp: nowSec + maxAgeSec,
  }

  const token = signSessionToken(payload, authConfig.sessionSecret)

  // Prime user status cache with freshly verified active user
  getUserStatusCache().set(user.userId, { user, cachedAt: Date.now() })

  return {
    ok: true,
    user: toSafeStudyUser(user),
    token,
    maxAgeSec,
  }
}

export type ValidateSessionResult =
  | { ok: true; user: SafeStudyUser; payload: StudySessionPayload }
  | {
      ok: false
      reason:
        | 'missing'
        | 'malformed'
        | 'invalid_signature'
        | 'expired'
        | 'user_not_found'
        | 'revoked'
        | 'credential_rotated'
    }

/**
 * Validates a session token cryptographically AND against live Study Users
 * status + credentialVersion (with a bounded 30s in-memory cache).
 */
export async function validateStudySessionToken(
  token: string | null | undefined,
  deps: {
    userRepo: StudyUserRepository
    authConfig?: StudyAuthConfig
    nowSec?: number
    bypassCache?: boolean
  }
): Promise<ValidateSessionResult> {
  if (!token) {
    return { ok: false, reason: 'missing' }
  }

  const authConfig = deps.authConfig || getStudyAuthConfig()
  const verified = verifySessionToken(token, authConfig.sessionSecret, deps.nowSec)
  if (!verified.ok) {
    return { ok: false, reason: verified.reason }
  }

  const { payload } = verified
  const cache = getUserStatusCache()
  const cached = !deps.bypassCache ? cache.get(payload.sub) : undefined

  let user: StudyUser | null
  if (cached && Date.now() - cached.cachedAt < USER_STATUS_CACHE_TTL_MS) {
    user = cached.user
  } else {
    user = await deps.userRepo.findByUserId(payload.sub)
    if (cache.size >= USER_STATUS_CACHE_MAX_ENTRIES && !cache.has(payload.sub)) {
      const oldestKey = cache.keys().next().value
      if (oldestKey !== undefined) cache.delete(oldestKey)
    }
    cache.set(payload.sub, { user, cachedAt: Date.now() })
  }

  if (!user) {
    return { ok: false, reason: 'user_not_found' }
  }

  if (user.status !== 'active') {
    return { ok: false, reason: 'revoked' }
  }

  if (user.credentialVersion !== payload.cv) {
    return { ok: false, reason: 'credential_rotated' }
  }

  return {
    ok: true,
    user: toSafeStudyUser(user),
    payload,
  }
}

/**
 * Revokes all active sessions for a user by incrementing `credentialVersion`
 * in Notion and immediately evicting the server user status cache.
 */
export async function revokeUserSessions(
  userId: string,
  userRepo: StudyUserRepository
): Promise<StudyUser | null> {
  const existing = await userRepo.findByUserId(userId)
  if (!existing) return null

  const updated = await userRepo.upsert({
    ...existing,
    credentialVersion: existing.credentialVersion + 1,
    updatedAt: new Date().toISOString(),
  })

  invalidateCachedStudyUser(userId)
  return updated
}
