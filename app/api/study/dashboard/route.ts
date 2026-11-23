import { NextResponse } from 'next/server'
import { requireStudyApiSession } from '../../../../lib/study/auth/guard'
import {
  NO_STORE_PRIVATE_HEADERS,
  getClientIp,
  checkApiRateLimit,
} from '../../../../lib/study/auth/security'
import { createNotionStudyRepositories } from '../../../../lib/study/repositories'
import { getStudyDashboardData } from '../../../../lib/study/services/dashboard-service'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const rate = checkApiRateLimit(getClientIp(request), 'study-dashboard', 60, 60 * 1000)
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { ...NO_STORE_PRIVATE_HEADERS, 'Retry-After': String(rate.retryAfterSec) } }
    )
  }

  const guard = await requireStudyApiSession(request)
  if (!guard.ok) return guard.response

  try {
    const repos = createNotionStudyRepositories()
    const dashboard = await getStudyDashboardData(guard.user.userId, repos)
    return NextResponse.json(dashboard, { status: 200, headers: NO_STORE_PRIVATE_HEADERS })
  } catch {
    return NextResponse.json(
      { error: 'Unable to load study dashboard right now.' },
      { status: 503, headers: NO_STORE_PRIVATE_HEADERS }
    )
  }
}
