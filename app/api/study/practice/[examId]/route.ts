import { NextResponse } from 'next/server'
import { requireStudyApiSession } from '../../../../../lib/study/auth/guard'
import {
  NO_STORE_PRIVATE_HEADERS,
  getClientIp,
  checkApiRateLimit,
} from '../../../../../lib/study/auth/security'
import { createNotionStudyRepositories } from '../../../../../lib/study/repositories'
import { stableIdSchema } from '../../../../../lib/study/schemas'
import { getPracticeExamPayload } from '../../../../../lib/study/services/practice-service'

export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  context: { params: Promise<{ examId: string }> }
) {
  const rate = checkApiRateLimit(getClientIp(request), 'study-practice-load', 60, 60 * 1000)
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { ...NO_STORE_PRIVATE_HEADERS, 'Retry-After': String(rate.retryAfterSec) } }
    )
  }

  const guard = await requireStudyApiSession(request)
  if (!guard.ok) return guard.response

  const { examId } = await context.params
  const parsed = stableIdSchema.safeParse(decodeURIComponent(examId || ''))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid examId' }, { status: 400, headers: NO_STORE_PRIVATE_HEADERS })
  }

  try {
    const repos = createNotionStudyRepositories()
    const payload = await getPracticeExamPayload(parsed.data, repos)
    if (!payload) {
      return NextResponse.json({ error: 'Exam collection not found' }, { status: 404, headers: NO_STORE_PRIVATE_HEADERS })
    }
    return NextResponse.json(payload, { status: 200, headers: NO_STORE_PRIVATE_HEADERS })
  } catch {
    return NextResponse.json(
      { error: 'Unable to load practice exam right now.' },
      { status: 503, headers: NO_STORE_PRIVATE_HEADERS }
    )
  }
}
