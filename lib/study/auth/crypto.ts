/**
 * lib/study/auth/crypto.ts — Cryptographic primitives for Study System auth
 * ─────────────────────────────────────────────────────────────────────────
 * Uses Node.js built-in `crypto` only (zero external crypto dependencies):
 * - Salted `scrypt` (N=16384, r=8, p=1, 32-byte key) for access key hashing.
 * - Constant-time `timingSafeEqual` for both password and HMAC verification.
 * - HMAC-SHA256 signed compact tokens for server-verified HttpOnly sessions.
 */

import {
  randomBytes,
  scryptSync,
  createHmac,
  timingSafeEqual,
} from 'node:crypto'
import type { AccessKeyHashVersion, StudyUserRole } from '../types'

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEY_LEN = 32
const SALT_BYTES = 16

// Precomputed dummy scrypt hash used to equalize timing when a username does not exist
const DUMMY_SALT_HEX = '0123456789abcdef0123456789abcdef'
const DUMMY_SCRYPT_HASH = `scrypt$${DUMMY_SALT_HEX}$${scryptSync('dummy-timing-equalizer', Buffer.from(DUMMY_SALT_HEX, 'hex'), SCRYPT_KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }).toString('hex')}`

export interface StudySessionPayload {
  /** Stable logical userId */
  sub: string
  /** Normalized username */
  usr: string
  /** User role */
  role: StudyUserRole
  /** Credential version at issuance (used for instant revocation) */
  cv: number
  /** Issued-at epoch seconds */
  iat: number
  /** Expiration epoch seconds */
  exp: number
}

/**
 * Generates a cryptographically strong random access key for manual user provisioning.
 */
export function generateAccessKey(byteLength: number = 24): string {
  const bytes = randomBytes(Math.max(byteLength, 16))
  return `sk_study_${bytes.toString('base64url')}`
}

/**
 * Hashes a plaintext access key using salted scrypt (`scrypt-v1`).
 * Never stores or logs the plaintext key.
 */
export function hashAccessKey(plainKey: string): {
  accessKeyHash: string
  hashVersion: AccessKeyHashVersion
} {
  if (typeof plainKey !== 'string' || plainKey.trim().length < 12) {
    throw new Error('Access key must be at least 12 characters long')
  }
  const salt = randomBytes(SALT_BYTES)
  const derived = scryptSync(plainKey, salt, SCRYPT_KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })
  return {
    accessKeyHash: `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`,
    hashVersion: 'scrypt-v1',
  }
}

/**
 * Verifies a plaintext access key against a stored salted hash in constant time.
 */
export function verifyAccessKey(
  plainKey: string,
  storedHash: string,
  hashVersion: AccessKeyHashVersion
): boolean {
  if (typeof plainKey !== 'string' || !plainKey || typeof storedHash !== 'string') {
    return false
  }
  if (hashVersion !== 'scrypt-v1') {
    return false
  }

  const parts = storedHash.trim().split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false
  }

  const [, saltHex, expectedHex] = parts
  if (!/^[0-9a-f]{32,128}$/i.test(saltHex) || !/^[0-9a-f]{64,256}$/i.test(expectedHex)) {
    return false
  }

  try {
    const salt = Buffer.from(saltHex, 'hex')
    const expected = Buffer.from(expectedHex, 'hex')
    const actual = scryptSync(plainKey, salt, expected.length, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    })
    if (actual.length !== expected.length) return false
    return timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

/**
 * Runs a constant-work dummy scrypt verification to mitigate username timing side-channels.
 */
export function runDummyKeyVerification(plainKey: string): void {
  verifyAccessKey(plainKey || 'dummy-input', DUMMY_SCRYPT_HASH, 'scrypt-v1')
}

function computeHmac(data: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(data).digest()
}

/**
 * Signs a session payload using HMAC-SHA256 (`v1.<payloadB64Url>.<sigB64Url>`).
 */
export function signSessionToken(payload: StudySessionPayload, secret: string): string {
  if (!secret || secret.length < 32) {
    throw new Error('Session secret must be at least 32 characters')
  }
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signingInput = `v1.${encodedPayload}`
  const sig = computeHmac(signingInput, secret).toString('base64url')
  return `${signingInput}.${sig}`
}

export type VerifyTokenResult =
  | { ok: true; payload: StudySessionPayload }
  | { ok: false; reason: 'malformed' | 'invalid_signature' | 'expired' }

/**
 * Verifies an HMAC-SHA256 signed session token in constant time and checks expiration.
 */
export function verifySessionToken(
  token: string,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000)
): VerifyTokenResult {
  if (typeof token !== 'string' || !token || !secret || secret.length < 32) {
    return { ok: false, reason: 'malformed' }
  }

  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') {
    return { ok: false, reason: 'malformed' }
  }

  const [, encodedPayload, providedSig] = parts
  if (!encodedPayload || !providedSig) {
    return { ok: false, reason: 'malformed' }
  }

  const signingInput = `v1.${encodedPayload}`
  const expectedSigBuf = computeHmac(signingInput, secret)
  let providedSigBuf: Buffer
  try {
    providedSigBuf = Buffer.from(providedSig, 'base64url')
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  if (
    providedSigBuf.length !== expectedSigBuf.length ||
    !timingSafeEqual(providedSigBuf, expectedSigBuf)
  ) {
    return { ok: false, reason: 'invalid_signature' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'malformed' }
  }

  const p = parsed as Record<string, unknown>
  if (
    typeof p.sub !== 'string' ||
    typeof p.usr !== 'string' ||
    (p.role !== 'admin' && p.role !== 'student') ||
    typeof p.cv !== 'number' ||
    !Number.isInteger(p.cv) ||
    p.cv < 1 ||
    typeof p.iat !== 'number' ||
    typeof p.exp !== 'number'
  ) {
    return { ok: false, reason: 'malformed' }
  }

  if (p.exp <= nowSec) {
    return { ok: false, reason: 'expired' }
  }

  return {
    ok: true,
    payload: {
      sub: p.sub,
      usr: p.usr,
      role: p.role,
      cv: p.cv,
      iat: p.iat,
      exp: p.exp,
    },
  }
}
