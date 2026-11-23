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
  checkLoginRateLimitAsync,
  checkApiRateLimitAsync,
  resetLoginRateLimit,
  clearAllStudyRateLimits,
  verifyCsrfOrigin,
} from '../../lib/study/auth/security'
import { verifyAuthorizedQuestionImageBlock } from '../../lib/study/notion-client'
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

  it('enforces distributed Upstash Redis rate limiting when configured', async () => {
    const origUrl = process.env.UPSTASH_REDIS_REST_URL
    const origToken = process.env.UPSTASH_REDIS_REST_TOKEN
    const origFetch = globalThis.fetch

    try {
      process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.example'
      process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token'

      const counters = new Map<string, number>()
      globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
        const commands = JSON.parse(String(init?.body || '[]')) as string[][]
        const key = commands[0]?.[1] || ''
        const nextCount = (counters.get(key) || 0) + 1
        counters.set(key, nextCount)
        return new Response(
          JSON.stringify([{ result: nextCount }, { result: 1 }, { result: 60000 }]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }) as typeof fetch

      const ok1 = await checkApiRateLimitAsync('198.51.100.1', 'study-image', 2, 60000)
      const ok2 = await checkApiRateLimitAsync('198.51.100.1', 'study-image', 2, 60000)
      const blocked = await checkApiRateLimitAsync('198.51.100.1', 'study-image', 2, 60000)
      assert.equal(ok1.allowed, true)
      assert.equal(ok2.allowed, true)
      assert.equal(blocked.allowed, false)
      assert.equal(blocked.retryAfterSec, 60)

      // Login async rate limit uses Upstash pipeline as well
      const loginOk = await checkLoginRateLimitAsync('198.51.100.2', 'student.dist', Date.now(), {
        failClosed: true,
      })
      assert.equal(loginOk.allowed, true)

      // Fail-closed behavior when Upstash returns 500 -> blocks with unavailable=true instead of silently falling back
      globalThis.fetch = (async () => new Response('Internal Error', { status: 500 })) as typeof fetch
      const failedClosed = await checkLoginRateLimitAsync('198.51.100.2', 'student.dist', Date.now(), {
        failClosed: true,
      })
      assert.equal(failedClosed.allowed, false)
      assert.equal(failedClosed.unavailable, true)

      // Fail-closed behavior when Upstash env vars are missing in production
      delete process.env.UPSTASH_REDIS_REST_URL
      delete process.env.UPSTASH_REDIS_REST_TOKEN
      const unconfiguredClosed = await checkLoginRateLimitAsync(
        '198.51.100.3',
        'student.prod',
        Date.now(),
        { failClosed: true }
      )
      assert.equal(unconfiguredClosed.allowed, false)
      assert.equal(unconfiguredClosed.unavailable, true)
    } finally {
      globalThis.fetch = origFetch
      if (origUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL
      else process.env.UPSTASH_REDIS_REST_URL = origUrl
      if (origToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN
      else process.env.UPSTASH_REDIS_REST_TOKEN = origToken
    }
  })

  it('rejects image blocks that do not belong to an authorized Study Question page', async () => {
    const QUESTIONS_DB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const OTHER_DB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

    const blocks: Record<string, Parameters<typeof verifyAuthorizedQuestionImageBlock>[1]['retrieveBlock'] extends (id: string) => Promise<infer R> ? R : never> = {
      'blk-published': {
        type: 'image',
        parent: { type: 'page_id', page_id: 'page-published' },
        image: { type: 'file', file: { url: 'https://s3.example/pub.png', expiry_time: null as unknown as string } },
      },
      'blk-draft': {
        type: 'image',
        parent: { type: 'page_id', page_id: 'page-draft' },
        image: { type: 'file', file: { url: 'https://s3.example/draft.png' } },
      },
      'blk-other-db': {
        type: 'image',
        parent: { type: 'page_id', page_id: 'page-other-db' },
        image: { type: 'file', file: { url: 'https://s3.example/secret.png' } },
      },
    }

    const pages: Record<string, Parameters<typeof verifyAuthorizedQuestionImageBlock>[1]['retrievePage'] extends (id: string) => Promise<infer R> ? R : never> = {
      'page-published': {
        id: 'page-published',
        parent: { type: 'database_id', database_id: QUESTIONS_DB },
        properties: { Status: { select: { name: 'published' } } },
      },
      'page-draft': {
        id: 'page-draft',
        parent: { type: 'database_id', database_id: QUESTIONS_DB },
        properties: { Status: { select: { name: 'draft' } } },
      },
      'page-other-db': {
        id: 'page-other-db',
        parent: { type: 'database_id', database_id: OTHER_DB },
        properties: { Status: { select: { name: 'published' } } },
      },
    }

    const deps = {
      allowedQuestionsDbIds: [QUESTIONS_DB],
      retrieveBlock: async (id: string) => blocks[id] || null,
      retrievePage: async (id: string) => pages[id] || null,
    }

    // Student can access image attached to a published Question in QUESTIONS_DB
    const pub = await verifyAuthorizedQuestionImageBlock('blk-published', { ...deps, allowDraft: false })
    assert.ok(pub && pub.url === 'https://s3.example/pub.png')

    // Student is DENIED image attached to a draft Question
    const draftForStudent = await verifyAuthorizedQuestionImageBlock('blk-draft', { ...deps, allowDraft: false })
    assert.equal(draftForStudent, null)

    // Admin is ALLOWED image attached to a draft Question
    const draftForAdmin = await verifyAuthorizedQuestionImageBlock('blk-draft', { ...deps, allowDraft: true })
    assert.ok(draftForAdmin && draftForAdmin.url === 'https://s3.example/draft.png')

    // Even admin is DENIED an image block owned by a page outside STUDY_NOTION_QUESTIONS_DB_ID
    const foreignBlock = await verifyAuthorizedQuestionImageBlock('blk-other-db', { ...deps, allowDraft: true })
    assert.equal(foreignBlock, null)
  })
})
