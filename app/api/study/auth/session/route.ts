import { NextResponse } from 'next/server'
import { requireStudyApiSession } from '../../../../../lib/study/auth/guard'
import {
  NO_STORE_PRIVATE_HEADERS,
  getClientIp,
  checkApiRateLimit,
} from '../../../../../lib/study/auth/security'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const rate = checkApiRateLimit(getClientIp(request), 'study-session', 60, 60 * 1000)
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

  return NextResponse.json(
    { user: guard.user },
    { status: 200, headers: NO_STORE_PRIVATE_HEADERS }
  )
}
