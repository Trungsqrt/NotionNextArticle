import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import type { StudyUser } from '../../lib/study/types'
import type { StudyAuthConfig } from '../../lib/study/config'
import type { StudyUserRepository } from '../../lib/study/repositories/interfaces'
import {
  generateAccessKey,
  hashAccessKey,
  verifyAccessKey,
  signSessionToken,
  verifySessionToken,
} from '../../lib/study/auth/crypto'
import {
  authenticateWithAccessKey,
  validateStudySessionToken,
  revokeUserSessions,
  buildSessionCookieOptions,
  buildExpiredCookieOptions,
  clearStudyUserStatusCache,
} from '../../lib/study/auth/session'
import {
  checkLoginRateLimit,
  resetLoginRateLimit,
  clearAllStudyRateLimits,
  verifyCsrfOrigin,
} from '../../lib/study/auth/security'
import {
  assertUserDataAccess,
  hasRequiredRole,
  ForbiddenError,
} from '../../lib/study/auth/guard'
import { proxy } from '../../proxy'

const TEST_AUTH_CONFIG: StudyAuthConfig = {
  sessionSecret: 'test-only-hmac-secret-at-least-32-characters-long-0123456789',
  sessionTtlHours: 24,
  isProduction: true,
}

function createMockUserRepo(initialUsers: StudyUser[]): StudyUserRepository {
  const byId = new Map<string, StudyUser>(initialUsers.map((u) => [u.userId, { ...u }]))
  return {
    async findByUsername(username: string): Promise<StudyUser | null> {
      const target = username.trim().toLowerCase()
      for (const user of byId.values()) {
        if (user.username === target) return { ...user }
      }
      return null
    },
    async findByUserId(userId: string): Promise<StudyUser | null> {
      const found = byId.get(userId.trim())
      return found ? { ...found } : null
    },
    async upsert(user: StudyUser): Promise<StudyUser> {
      byId.set(user.userId, { ...user })
      return { ...user }
    },
  }
}

function buildTestUser(overrides: Partial<StudyUser> = {}): {
  user: StudyUser
  plainKey: string
} {
  const plainKey = generateAccessKey(24)
  const { accessKeyHash, hashVersion } = hashAccessKey(plainKey)
  const user: StudyUser = {
    userId: 'usr-auth-001',
    username: 'study.student',
    accessKeyHash,
    hashVersion,
    role: 'student',
    status: 'active',
    credentialVersion: 1,
    createdAt: '2026-01-15T00:00:00.000Z',
    updatedAt: '2026-01-15T00:00:00.000Z',
    ...overrides,
  }
  return { user, plainKey }
}

describe('Study Auth — Crypto, Login, Sessions & Revocation', () => {
  beforeEach(() => {
    clearStudyUserStatusCache()
    clearAllStudyRateLimits()
  })

  it('hashes and verifies access keys with salted scrypt and issues safe session without leaking hashes', async () => {
    const { user, plainKey } = buildTestUser()
    assert.equal(verifyAccessKey(plainKey, user.accessKeyHash, 'scrypt-v1'), true)
    assert.equal(verifyAccessKey('wrong-key-value-12345', user.accessKeyHash, 'scrypt-v1'), false)

    const userRepo = createMockUserRepo([user])
    const auth = await authenticateWithAccessKey('  STUDY.STUDENT ', plainKey, {
      userRepo,
      authConfig: TEST_AUTH_CONFIG,
      nowSec: 1_700_000_000,
    })

    assert.equal(auth.ok, true)
    if (!auth.ok) return

    assert.equal(auth.user.userId, user.userId)
    assert.equal(auth.user.username, 'study.student')
    assert.equal('accessKeyHash' in auth.user, false)
    assert.equal('hashVersion' in auth.user, false)

    const validated = await validateStudySessionToken(auth.token, {
      userRepo,
      authConfig: TEST_AUTH_CONFIG,
      nowSec: 1_700_000_100,
    })
    assert.equal(validated.ok, true)
    if (validated.ok) {
      assert.equal('accessKeyHash' in validated.user, false)
      assert.equal(validated.user.userId, user.userId)
    }
  })

  it('rejects invalid username and invalid access key', async () => {
    const { user } = buildTestUser()
    const userRepo = createMockUserRepo([user])

    const badUser = await authenticateWithAccessKey('nonexistent.user', 'some-key-123456', {
      userRepo,
      authConfig: TEST_AUTH_CONFIG,
    })
    assert.deepEqual(badUser, { ok: false, reason: 'invalid_credentials' })

    const badKey = await authenticateWithAccessKey(user.username, 'wrong-access-key-999', {
      userRepo,
      authConfig: TEST_AUTH_CONFIG,
    })
    assert.deepEqual(badKey, { ok: false, reason: 'invalid_credentials' })
  })

  it('rejects revoked user at login and revokes existing session when status becomes revoked', async () => {
    const { user, plainKey } = buildTestUser()
    const userRepo = createMockUserRepo([user])

    const loginRes = await authenticateWithAccessKey(user.username, plainKey, {
      userRepo,
      authConfig: TEST_AUTH_CONFIG,
      nowSec: 1_700_000_000,
    })
    assert.equal(loginRes.ok, true)
    if (!loginRes.ok) return

    // Admin revokes user in Notion
    await userRepo.upsert({ ...user, status: 'revoked' })
    clearStudyUserStatusCache()

    // Existing session token must be rejected
    const midSession = await validateStudySessionToken(loginRes.token, {
      userRepo,
      authConfig: TEST_AUTH_CONFIG,
      nowSec: 1_700_000_050,
    })
    assert.deepEqual(midSession, { ok: false, reason: 'revoked' })

    // New login must also be rejected
    const secondLogin = await authenticateWithAccessKey(user.username, plainKey, {
      userRepo,
      authConfig: TEST_AUTH_CONFIG,
    })
    assert.deepEqual(secondLogin, { ok: false, reason: 'revoked' })
  })

  it('rejects expired and tampered session tokens', async () => {
    const { user, plainKey } = buildTestUser()
    const userRepo = createMockUserRepo([user])

    const loginRes = await authenticateWithAccessKey(user.username, plainKey, {
      userRepo,
      authConfig: TEST_AUTH_CONFIG,
      nowSec: 1_700_000_000,
    })
    assert.equal(loginRes.ok, true)
    if (!loginRes.ok) return

    // Expired token (past 24h TTL)
    const expired = await validateStudySessionToken(loginRes.token, {
      userRepo,
      authConfig: TEST_AUTH_CONFIG,
      nowSec: 1_700_000_000 + 24 * 3600 + 1,
    })
    assert.deepEqual(expired, { ok: false, reason: 'expired' })

    // Tampered token signature
    const tampered = `${loginRes.token.slice(0, -3)}AAA`
    const verifiedTampered = verifySessionToken(tampered, TEST_AUTH_CONFIG.sessionSecret, 1_700_000_010)
    assert.deepEqual(verifiedTampered, { ok: false, reason: 'invalid_signature' })

    // Signed with wrong secret
    const forged = signSessionToken(
      {
        sub: user.userId,
        usr: user.username,
        role: 'admin',
        cv: 1,
        iat: 1_700_000_000,
        exp: 1_700_100_000,
      },
      'a-completely-different-secret-that-is-32-chars-long'
    )
    const verifiedForged = verifySessionToken(forged, TEST_AUTH_CONFIG.sessionSecret, 1_700_000_010)
    assert.deepEqual(verifiedForged, { ok: false, reason: 'invalid_signature' })
  })

  it('revokes all active sessions when credentialVersion is incremented and sets secure cookie flags', async () => {
    const { user, plainKey } = buildTestUser()
    const userRepo = createMockUserRepo([user])

    const loginRes = await authenticateWithAccessKey(user.username, plainKey, {
      userRepo,
      authConfig: TEST_AUTH_CONFIG,
      nowSec: 1_700_000_000,
    })
    assert.equal(loginRes.ok, true)
    if (!loginRes.ok) return

    // Revoke all sessions
    const updated = await revokeUserSessions(user.userId, userRepo)
    assert.ok(updated)
    assert.equal(updated.credentialVersion, 2)

    // Old token (cv=1) is immediately rejected
    const afterRevoke = await validateStudySessionToken(loginRes.token, {
      userRepo,
      authConfig: TEST_AUTH_CONFIG,
      nowSec: 1_700_000_010,
    })
    assert.deepEqual(afterRevoke, { ok: false, reason: 'credential_rotated' })

    // Cookie flags verification (login & logout)
    const loginCookie = buildSessionCookieOptions(3600, true)
    assert.equal(loginCookie.httpOnly, true)
    assert.equal(loginCookie.secure, true)
    assert.equal(loginCookie.sameSite, 'lax')
    assert.equal(loginCookie.path, '/')

    const logoutCookie = buildExpiredCookieOptions(true)
    assert.equal(logoutCookie.maxAge, 0)
    assert.equal(logoutCookie.httpOnly, true)
    assert.equal(logoutCookie.secure, true)
  })
})

describe('Study Authz, CSRF, Rate Limiting, Proxy & SEO Isolation', () => {
  beforeEach(() => {
    clearAllStudyRateLimits()
  })

  it('prevents cross-user data access and enforces role authorization', () => {
    const student = {
      userId: 'usr-student-1',
      username: 'student.one',
      role: 'student' as const,
      status: 'active' as const,
      credentialVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const admin = { ...student, userId: 'usr-admin-1', role: 'admin' as const }

    // Student can access own data, cannot access another user's data
    assert.doesNotThrow(() => assertUserDataAccess(student, 'usr-student-1'))
    assert.throws(() => assertUserDataAccess(student, 'usr-student-2'), ForbiddenError)

    // Admin can access across users
    assert.doesNotThrow(() => assertUserDataAccess(admin, 'usr-student-2'))

    // Role checks
    assert.equal(hasRequiredRole(student, ['admin']), false)
    assert.equal(hasRequiredRole(admin, ['admin']), true)
    assert.equal(hasRequiredRole(student, ['student', 'admin']), true)
  })

  it('enforces CSRF protection on state-changing requests', () => {
    const crossSite = new Request('https://example.com/api/study/auth/login', {
      method: 'POST',
      headers: {
        host: 'example.com',
        'sec-fetch-site': 'cross-site',
        origin: 'https://evil.test',
      },
    })
    assert.equal(verifyCsrfOrigin(crossSite).ok, false)

    const originMismatch = new Request('https://example.com/api/study/auth/logout', {
      method: 'POST',
      headers: {
        host: 'example.com',
        origin: 'https://attacker.example',
      },
    })
    assert.equal(verifyCsrfOrigin(originMismatch).ok, false)

    const missingOrigin = new Request('https://example.com/api/study/auth/logout', {
      method: 'POST',
      headers: { host: 'example.com' },
    })
    assert.equal(verifyCsrfOrigin(missingOrigin).ok, false)

    const sameOrigin = new Request('https://example.com/api/study/auth/login', {
      method: 'POST',
      headers: {
        host: 'example.com',
        'sec-fetch-site': 'same-origin',
        origin: 'https://example.com',
      },
    })
    assert.equal(verifyCsrfOrigin(sameOrigin).ok, true)
  })

  it('rate-limits repeated login attempts per username and per IP', () => {
    const now = 1_700_000_000_000
    for (let i = 0; i < 8; i++) {
      assert.equal(checkLoginRateLimit('192.0.2.10', 'student.one', now).allowed, true)
    }
    // 9th attempt for same username is blocked
    const blockedUser = checkLoginRateLimit('192.0.2.10', 'student.one', now)
    assert.equal(blockedUser.allowed, false)
    assert.ok(blockedUser.retryAfterSec > 0)

    // Reset clears the limit
    resetLoginRateLimit('192.0.2.10', 'student.one')
    assert.equal(checkLoginRateLimit('192.0.2.10', 'student.one', now).allowed, true)
  })

  it('redirects unauthenticated private pages to /study/login and returns 401 on private APIs with noindex headers', () => {
    const protectedPages = [
      'https://example.com/study',
      'https://example.com/study/flashcards',
      'https://example.com/study/exams',
      'https://example.com/study/exams/csa-01',
    ]

    for (const url of protectedPages) {
      const res = proxy(new NextRequest(url))
      assert.equal(res.status, 307)
      assert.ok(res.headers.get('location')?.includes('/study/login'))
      assert.ok(res.headers.get('x-robots-tag')?.includes('noindex'))
      assert.ok(res.headers.get('cache-control')?.includes('no-store'))
    }

    // Login page is reachable without cookie, still carries noindex + no-store
    const loginPageRes = proxy(new NextRequest('https://example.com/study/login'))
    assert.equal(loginPageRes.status, 200)
    assert.ok(loginPageRes.headers.get('x-robots-tag')?.includes('noindex'))

    // Unauthenticated API request returns 401
    const apiRes = proxy(new NextRequest('https://example.com/api/study/auth/session'))
    assert.equal(apiRes.status, 401)
    assert.ok(apiRes.headers.get('x-robots-tag')?.includes('noindex'))
    assert.ok(apiRes.headers.get('cache-control')?.includes('no-store'))
  })

  it('disallows /study in robots.js while preserving public Knowledge Hub indexing', async () => {
    const robotsModule = (await import('../../app/robots.js')) as {
      default: () => { rules: Array<{ allow: string; disallow: string[] }> }
    }
    const config = robotsModule.default()
    assert.ok(Array.isArray(config.rules))
    for (const rule of config.rules) {
      assert.equal(rule.allow, '/')
      assert.ok(rule.disallow.includes('/study'))
      assert.ok(rule.disallow.includes('/study/'))
    }
  })
})
