import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireStudyApiSession } from '../../../../../lib/study/auth/guard'
import {
  NO_STORE_PRIVATE_HEADERS,
  getClientIp,
  checkApiRateLimit,
} from '../../../../../lib/study/auth/security'
import {
  createNotionStudyRepositories,
  ConcurrencyConflictError,
} from '../../../../../lib/study/repositories'
import { stableIdSchema, studyRatingSchema } from '../../../../../lib/study/schemas'
import { submitRecallReview } from '../../../../../lib/study/services/recall-service'

export const dynamic = 'force-dynamic'

const reviewBodySchema = z.object({
  questionId: stableIdSchema,
  rating: studyRatingSchema,
  eventId: stableIdSchema,
  expectedRevision: z.number().int().min(0).optional(),
})

export async function POST(request: Request) {
  const rate = checkApiRateLimit(getClientIp(request), 'study-recall-review', 120, 60 * 1000)
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

  const parsed = reviewBodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid review payload' }, { status: 400, headers: NO_STORE_PRIVATE_HEADERS })
  }

  try {
    const repos = createNotionStudyRepositories()
    const result = await submitRecallReview(
      {
        userId: guard.user.userId,
        questionId: parsed.data.questionId,
        rating: parsed.data.rating,
        eventId: parsed.data.eventId,
        expectedRevision: parsed.data.expectedRevision,
      },
      repos
    )
    return NextResponse.json(result, { status: 200, headers: NO_STORE_PRIVATE_HEADERS })
  } catch (err) {
    if (err instanceof ConcurrencyConflictError) {
      return NextResponse.json(
        {
          error: 'This card was updated on another device or tab. Please refresh the queue.',
          code: err.code,
          expectedRevision: err.expectedRevision,
          actualRevision: err.actualRevision,
        },
        { status: 409, headers: NO_STORE_PRIVATE_HEADERS }
      )
    }
    return NextResponse.json(
      { error: 'Unable to save review right now.' },
      { status: 503, headers: NO_STORE_PRIVATE_HEADERS }
    )
  }
}
