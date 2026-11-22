import { NextResponse } from 'next/server'
import { z } from 'zod'
import { isStudyAuthConfigured, getStudyAuthConfig } from '../../../../../lib/study/config'
import { createNotionStudyRepositories } from '../../../../../lib/study/repositories'
import {
  authenticateWithAccessKey,
  getStudySessionCookieName,
  buildSessionCookieOptions,
} from '../../../../../lib/study/auth/session'
import {
  NO_STORE_PRIVATE_HEADERS,
  getClientIp,
  checkLoginRateLimitAsync,
  resetLoginRateLimitAsync,
  verifyCsrfOrigin,
} from '../../../../../lib/study/auth/security'

export const dynamic = 'force-dynamic'

const loginBodySchema = z.object({
  username: z.string().trim().min(1).max(64),
  accessKey: z.string().min(1).max(256),
})

export async function POST(request: Request) {
  const csrf = verifyCsrfOrigin(request)
  if (!csrf.ok) {
    return NextResponse.json(
      { error: 'Forbidden' },
      { status: 403, headers: NO_STORE_PRIVATE_HEADERS }
    )
  }

  if (!isStudyAuthConfigured()) {
    return NextResponse.json(
      { error: 'Study Room authentication is not configured yet.' },
      { status: 503, headers: NO_STORE_PRIVATE_HEADERS }
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: 'Invalid request body' },
      { status: 400, headers: NO_STORE_PRIVATE_HEADERS }
    )
  }

  const parsed = loginBodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Please enter both username and access key.' },
      { status: 400, headers: NO_STORE_PRIVATE_HEADERS }
    )
  }

  const { username, accessKey } = parsed.data
  const ip = getClientIp(request)
  const rate = await checkLoginRateLimitAsync(ip, username)
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Too many login attempts. Please wait before trying again.' },
      {
        status: 429,
        headers: {
          ...NO_STORE_PRIVATE_HEADERS,
          'Retry-After': String(rate.retryAfterSec),
        },
      }
    )
  }

  try {
    const authConfig = getStudyAuthConfig()
    const repos = createNotionStudyRepositories()
    const result = await authenticateWithAccessKey(username, accessKey, {
      userRepo: repos.users,
      authConfig,
    })

    if (!result.ok) {
      // Return a uniform error message to avoid leaking whether a username exists or is revoked
      return NextResponse.json(
        { error: 'Invalid username or access key.' },
        { status: 401, headers: NO_STORE_PRIVATE_HEADERS }
      )
    }

    await resetLoginRateLimitAsync(ip, username)

    const response = NextResponse.json(
      { user: result.user },
      { status: 200, headers: NO_STORE_PRIVATE_HEADERS }
    )
    response.cookies.set(
      getStudySessionCookieName(authConfig.isProduction),
      result.token,
      buildSessionCookieOptions(result.maxAgeSec, authConfig.isProduction)
    )
    return response
  } catch {
    return NextResponse.json(
      { error: 'Unable to sign in right now. Please try again shortly.' },
      { status: 503, headers: NO_STORE_PRIVATE_HEADERS }
    )
  }
}
