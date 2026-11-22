import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireStudyApiSession } from '../../../../../lib/study/auth/guard'
import {
  NO_STORE_PRIVATE_HEADERS,
  getClientIp,
  checkApiRateLimit,
} from '../../../../../lib/study/auth/security'
import { getStudyAuthConfig } from '../../../../../lib/study/config'
import { createNotionStudyRepositories } from '../../../../../lib/study/repositories'
import { stableIdSchema } from '../../../../../lib/study/schemas'
import { startExamSession } from '../../../../../lib/study/services/exam-service'

export const dynamic = 'force-dynamic'

const startBodySchema = z.object({
  examId: stableIdSchema,
  durationMinutes: z.number().int().min(5).max(180).optional(),
})

export async function POST(request: Request) {
  const rate = checkApiRateLimit(getClientIp(request), 'study-exam-start', 30, 60 * 1000)
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { ...NO_STORE_PRIVATE_HEADERS, 'Retry-After': String(rate.retryAfterSec) } }
    )
  }

  const guard = await requireStudyApiSession(request)
  if (!guard.ok) return guard.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400, headers: NO_STORE_PRIVATE_HEADERS })
  }

  const parsed = startBodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid exam start parameters' }, { status: 400, headers: NO_STORE_PRIVATE_HEADERS })
  }

  try {
    const authConfig = getStudyAuthConfig()
    const repos = createNotionStudyRepositories()
    const started = await startExamSession(
      {
        userId: guard.user.userId,
        examId: parsed.data.examId,
        durationMinutes: parsed.data.durationMinutes,
        sessionSecret: authConfig.sessionSecret,
      },
      repos
    )
    if (!started) {
      return NextResponse.json({ error: 'Exam collection not found or empty' }, { status: 404, headers: NO_STORE_PRIVATE_HEADERS })
    }
    return NextResponse.json(started, { status: 200, headers: NO_STORE_PRIVATE_HEADERS })
  } catch {
    return NextResponse.json(
      { error: 'Unable to start exam right now.' },
      { status: 503, headers: NO_STORE_PRIVATE_HEADERS }
    )
  }
}
