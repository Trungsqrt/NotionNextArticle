import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createNotionStudyRepositories } from '../../../../../lib/study/repositories'
import {
  requireStudyApiSession,
  assertUserDataAccess,
  ForbiddenError,
} from '../../../../../lib/study/auth/guard'
import { revokeUserSessions } from '../../../../../lib/study/auth/session'
import {
  NO_STORE_PRIVATE_HEADERS,
  getClientIp,
  checkApiRateLimit,
} from '../../../../../lib/study/auth/security'

export const dynamic = 'force-dynamic'

const revokeBodySchema = z.object({
  userId: z.string().trim().min(2).max(128).optional(),
})

export async function POST(request: Request) {
  const rate = checkApiRateLimit(getClientIp(request), 'study-revoke', 20, 60 * 1000)
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Too many requests' },
      {
        status: 429,
        headers: {
          ...NO_STORE_PRIVATE_HEADERS,
          'Retry-After': String(rate.retryAfterSec),
        },
      }
    )
  }

  const guard = await requireStudyApiSession(request)
  if (!guard.ok) return guard.response

  let targetUserId = guard.user.userId
  try {
    const raw = await request.json()
    const parsed = revokeBodySchema.safeParse(raw)
    if (parsed.success && parsed.data.userId) {
      targetUserId = parsed.data.userId
    }
  } catch {
    // Empty body defaults to revoking the authenticated user's own sessions
  }

  try {
    assertUserDataAccess(guard.user, targetUserId)
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return NextResponse.json(
        { error: 'Forbidden' },
        { status: 403, headers: NO_STORE_PRIVATE_HEADERS }
      )
    }
    throw err
  }

  try {
    const repos = createNotionStudyRepositories()
    const updated = await revokeUserSessions(targetUserId, repos.users)
    if (!updated) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404, headers: NO_STORE_PRIVATE_HEADERS }
      )
    }

    return NextResponse.json(
      { ok: true, credentialVersion: updated.credentialVersion },
      { status: 200, headers: NO_STORE_PRIVATE_HEADERS }
    )
  } catch {
    return NextResponse.json(
      { error: 'Unable to revoke sessions right now.' },
      { status: 503, headers: NO_STORE_PRIVATE_HEADERS }
    )
  }
}
