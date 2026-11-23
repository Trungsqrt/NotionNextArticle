import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireStudyApiSession } from '../../../../../lib/study/auth/guard'
import {
  NO_STORE_PRIVATE_HEADERS,
  getClientIp,
  checkApiRateLimit,
} from '../../../../../lib/study/auth/security'
import { createNotionStudyRepositories } from '../../../../../lib/study/repositories'
import { stableIdSchema } from '../../../../../lib/study/schemas'
import { checkPracticeAnswer } from '../../../../../lib/study/services/practice-service'

export const dynamic = 'force-dynamic'

const checkBodySchema = z.object({
  questionId: stableIdSchema,
  selectedOptionIds: z.array(z.string().trim().min(1).max(16)).min(1).max(10),
})

export async function POST(request: Request) {
  const rate = checkApiRateLimit(getClientIp(request), 'study-practice-check', 120, 60 * 1000)
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

  const parsed = checkBodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid answer payload' }, { status: 400, headers: NO_STORE_PRIVATE_HEADERS })
  }

  try {
    const repos = createNotionStudyRepositories()
    const result = await checkPracticeAnswer(
      parsed.data.questionId,
      parsed.data.selectedOptionIds,
      repos
    )
    if (!result) {
      return NextResponse.json({ error: 'Question not found' }, { status: 404, headers: NO_STORE_PRIVATE_HEADERS })
    }
    return NextResponse.json(result, { status: 200, headers: NO_STORE_PRIVATE_HEADERS })
  } catch {
    return NextResponse.json(
      { error: 'Unable to check answer right now.' },
      { status: 503, headers: NO_STORE_PRIVATE_HEADERS }
    )
  }
}
