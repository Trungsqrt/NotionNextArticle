/**
 * lib/study/auth/guard.ts — Server-side authorization & data-access guards
 * ────────────────────────────────────────────────────────────────────────
 * Enforces authentication, role checks, and cross-user isolation at the
 * server-side data-access boundary (RSC pages and Route Handlers), never
 * relying solely on edge routing/proxy checks.
 */

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { NextResponse } from 'next/server'
import type { SafeStudyUser, StudyUserRole } from '../types'
import { isStudyAuthConfigured, getStudyAuthConfig } from '../config'
import { createNotionStudyRepositories } from '../repositories'
import {
  getStudySessionCookieName,
  STUDY_COOKIE_NAME_DEV,
  STUDY_COOKIE_NAME_PROD,
  validateStudySessionToken,
} from './session'
import { NO_STORE_PRIVATE_HEADERS, verifyCsrfOrigin } from './security'

export class ForbiddenError extends Error {
  readonly status = 403
  constructor(message: string = 'Forbidden') {
    super(message)
    this.name = 'ForbiddenError'
  }
}

/**
 * Prevents cross-user data access (IDOR).
 * Students may only access records owned by their own `userId`;
 * admins may access records across users when explicitly permitted.
 */
export function assertUserDataAccess(
  sessionUser: SafeStudyUser,
  targetUserId: string
): void {
  if (!targetUserId || !sessionUser?.userId) {
    throw new ForbiddenError('Forbidden')
  }
  if (sessionUser.role === 'admin') return
  if (sessionUser.userId !== targetUserId.trim()) {
    throw new ForbiddenError('Cross-user data access is not permitted')
  }
}

export function hasRequiredRole(
  sessionUser: SafeStudyUser,
  allowedRoles?: StudyUserRole[]
): boolean {
  if (!allowedRoles || allowedRoles.length === 0) return true
  return allowedRoles.includes(sessionUser.role)
}

function readCookieFromHeader(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null
  const parts = cookieHeader.split(';')
  for (const part of parts) {
    const eqIdx = part.indexOf('=')
    if (eqIdx === -1) continue
    const k = part.slice(0, eqIdx).trim()
    if (k === name) {
      try {
        return decodeURIComponent(part.slice(eqIdx + 1).trim())
      } catch {
        return part.slice(eqIdx + 1).trim()
      }
    }
  }
  return null
}

export function extractSessionTokenFromRequest(request: Request): string | null {
  const cookieHeader = request.headers.get('cookie')
  const primaryName = getStudySessionCookieName()
  return (
    readCookieFromHeader(cookieHeader, primaryName) ||
    readCookieFromHeader(cookieHeader, STUDY_COOKIE_NAME_PROD) ||
    readCookieFromHeader(cookieHeader, STUDY_COOKIE_NAME_DEV)
  )
}

/**
 * Reads and validates the current Study session inside a Server Component.
 * Returns null if unauthenticated, expired, revoked, or unconfigured.
 */
export async function getStudyPageSession(): Promise<SafeStudyUser | null> {
  if (!isStudyAuthConfigured()) return null

  const cookieStore = await cookies()
  const primaryName = getStudySessionCookieName()
  const token =
    cookieStore.get(primaryName)?.value ||
    cookieStore.get(STUDY_COOKIE_NAME_PROD)?.value ||
    cookieStore.get(STUDY_COOKIE_NAME_DEV)?.value ||
    null

  if (!token) return null

  try {
    const repos = createNotionStudyRepositories()
    const result = await validateStudySessionToken(token, {
      userRepo: repos.users,
      authConfig: getStudyAuthConfig(),
    })
    return result.ok ? result.user : null
  } catch {
    return null
  }
}

/**
 * Enforces authentication (and optional role authorization) for Server Component pages.
 * Unauthenticated requests redirect to `/study/login`.
 */
export async function requireStudyPageSession(options?: {
  allowedRoles?: StudyUserRole[]
  returnTo?: string
}): Promise<SafeStudyUser> {
  const user = await getStudyPageSession()
  if (!user) {
    const nextPath =
      options?.returnTo && options.returnTo.startsWith('/study')
        ? `?next=${encodeURIComponent(options.returnTo)}`
        : ''
    redirect(`/study/login${nextPath}`)
  }

  if (!hasRequiredRole(user, options?.allowedRoles)) {
    redirect('/study')
  }

  return user
}

export type ApiGuardResult =
  | { ok: true; user: SafeStudyUser }
  | { ok: false; response: NextResponse }

/**
 * Enforces authentication, CSRF (on state-changing methods), and role checks
 * for `/api/study/*` Route Handlers:
 * - Unauthenticated -> 401
 * - Authenticated but unauthorized / CSRF failed -> 403
 */
export async function requireStudyApiSession(
  request: Request,
  options?: { allowedRoles?: StudyUserRole[] }
): Promise<ApiGuardResult> {
  const csrf = verifyCsrfOrigin(request)
  if (!csrf.ok) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Forbidden' },
        { status: 403, headers: NO_STORE_PRIVATE_HEADERS }
      ),
    }
  }

  if (!isStudyAuthConfigured()) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Study Room authentication is not configured' },
        { status: 503, headers: NO_STORE_PRIVATE_HEADERS }
      ),
    }
  }

  const token = extractSessionTokenFromRequest(request)
  if (!token) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Authentication required' },
        { status: 401, headers: NO_STORE_PRIVATE_HEADERS }
      ),
    }
  }

  try {
    const repos = createNotionStudyRepositories()
    const result = await validateStudySessionToken(token, {
      userRepo: repos.users,
      authConfig: getStudyAuthConfig(),
    })

    if (!result.ok) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: 'Authentication required' },
          { status: 401, headers: NO_STORE_PRIVATE_HEADERS }
        ),
      }
    }

    if (!hasRequiredRole(result.user, options?.allowedRoles)) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: 'Forbidden' },
          { status: 403, headers: NO_STORE_PRIVATE_HEADERS }
        ),
      }
    }

    return { ok: true, user: result.user }
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Unable to validate session' },
        { status: 503, headers: NO_STORE_PRIVATE_HEADERS }
      ),
    }
  }
}
