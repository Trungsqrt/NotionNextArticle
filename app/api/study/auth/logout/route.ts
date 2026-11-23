import { NextResponse } from 'next/server'
import { isStudyAuthConfigured, getStudyAuthConfig } from '../../../../../lib/study/config'
import { createNotionStudyRepositories } from '../../../../../lib/study/repositories'
import {
  STUDY_COOKIE_NAME_DEV,
  STUDY_COOKIE_NAME_PROD,
  buildExpiredCookieOptions,
  validateStudySessionToken,
  revokeUserSessions,
  invalidateCachedStudyUser,
} from '../../../../../lib/study/auth/session'
import { extractSessionTokenFromRequest } from '../../../../../lib/study/auth/guard'
import { NO_STORE_PRIVATE_HEADERS, verifyCsrfOrigin } from '../../../../../lib/study/auth/security'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const csrf = verifyCsrfOrigin(request)
  if (!csrf.ok) {
    return NextResponse.json(
      { error: 'Forbidden' },
      { status: 403, headers: NO_STORE_PRIVATE_HEADERS }
    )
  }

  let revokeAll = false
  try {
    const body = (await request.json()) as { revokeAll?: unknown }
    revokeAll = body?.revokeAll === true
  } catch {
    // Empty body is valid for standard logout
  }

  // If authenticated and revokeAll is requested, bump credentialVersion in Notion
  if (isStudyAuthConfigured()) {
    const token = extractSessionTokenFromRequest(request)
    if (token) {
      try {
        const authConfig = getStudyAuthConfig()
        const repos = createNotionStudyRepositories()
        const verified = await validateStudySessionToken(token, {
          userRepo: repos.users,
          authConfig,
        })
        if (verified.ok) {
          if (revokeAll) {
            await revokeUserSessions(verified.user.userId, repos.users)
          } else {
            invalidateCachedStudyUser(verified.user.userId)
          }
        }
      } catch {
        // Still clear local cookies even if Notion is temporarily unreachable
      }
    }
  }

  const response = NextResponse.json(
    { ok: true },
    { status: 200, headers: NO_STORE_PRIVATE_HEADERS }
  )
  response.cookies.set(STUDY_COOKIE_NAME_PROD, '', buildExpiredCookieOptions(true))
  response.cookies.set(STUDY_COOKIE_NAME_DEV, '', buildExpiredCookieOptions(false))
  return response
}
