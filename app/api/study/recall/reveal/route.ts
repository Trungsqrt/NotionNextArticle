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
import { revealRecallAnswer } from '../../../../../lib/study/services/recall-service'

export const dynamic = 'force-dynamic'

const revealBodySchema = z.object({
  questionId: stableIdSchema,
})

export async function POST(request: Request) {
  const rate = checkApiRateLimit(getClientIp(request), 'study-recall-reveal', 120, 60 * 1000)
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

  const parsed = revealBodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid questionId' }, { status: 400, headers: NO_STORE_PRIVATE_HEADERS })
  }

  try {
    const repos = createNotionStudyRepositories()
    const revealed = await revealRecallAnswer(parsed.data.questionId, repos)
    if (!revealed) {
      return NextResponse.json({ error: 'Question not found' }, { status: 404, headers: NO_STORE_PRIVATE_HEADERS })
    }
    return NextResponse.json(revealed, { status: 200, headers: NO_STORE_PRIVATE_HEADERS })
  } catch {
    return NextResponse.json(
      { error: 'Unable to reveal answer right now.' },
      { status: 503, headers: NO_STORE_PRIVATE_HEADERS }
    )
  }
}
