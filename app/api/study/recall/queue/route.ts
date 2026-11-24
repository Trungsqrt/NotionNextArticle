import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireStudyApiSession } from '../../../../../lib/study/auth/guard'
import {
  NO_STORE_PRIVATE_HEADERS,
  getClientIp,
  checkApiRateLimit,
} from '../../../../../lib/study/auth/security'
import { createNotionStudyRepositories } from '../../../../../lib/study/repositories'
import { getRecallQueue } from '../../../../../lib/study/services/recall-service'

export const dynamic = 'force-dynamic'

const recallQueuePostSchema = z.object({
  examId: z.string().trim().max(128).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  questionIds: z.array(z.string().trim().min(1).max(128)).max(500).default([]),
})

export async function GET(request: Request) {
  const rate = checkApiRateLimit(getClientIp(request), 'study-recall-queue', 60, 60 * 1000)
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { ...NO_STORE_PRIVATE_HEADERS, 'Retry-After': String(rate.retryAfterSec) } }
    )
  }

  const guard = await requireStudyApiSession(request)
  if (!guard.ok) return guard.response

  const { searchParams } = new URL(request.url)
  const examId = searchParams.get('examId')?.trim() || undefined
  const rawLimit = Number.parseInt(searchParams.get('limit') || '20', 10)
  const limit = Number.isFinite(rawLimit) ? rawLimit : 20
  const rawIds = searchParams.get('questionIds') || ''
  const bookmarkedQuestionIds = rawIds
    ? rawIds
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
        .slice(0, 500)
    : []

  try {
    const repos = createNotionStudyRepositories()
    const queue = await getRecallQueue(guard.user.userId, repos, {
      examId,
      limit,
      bookmarkedQuestionIds,
    })
    return NextResponse.json(queue, { status: 200, headers: NO_STORE_PRIVATE_HEADERS })
  } catch {
    return NextResponse.json(
      { error: 'Unable to load recall queue right now.' },
      { status: 503, headers: NO_STORE_PRIVATE_HEADERS }
    )
  }
}

export async function POST(request: Request) {
  const rate = checkApiRateLimit(getClientIp(request), 'study-recall-queue', 60, 60 * 1000)
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
    return NextResponse.json(
      { error: 'Invalid JSON request body.' },
      { status: 400, headers: NO_STORE_PRIVATE_HEADERS }
    )
  }

  const parsed = recallQueuePostSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid recall queue request parameters.' },
      { status: 400, headers: NO_STORE_PRIVATE_HEADERS }
    )
  }

  try {
    const repos = createNotionStudyRepositories()
    const queue = await getRecallQueue(guard.user.userId, repos, {
      examId: parsed.data.examId || undefined,
      limit: parsed.data.limit ?? 20,
      bookmarkedQuestionIds: parsed.data.questionIds,
    })
    return NextResponse.json(queue, { status: 200, headers: NO_STORE_PRIVATE_HEADERS })
  } catch {
    return NextResponse.json(
      { error: 'Unable to load recall queue right now.' },
      { status: 503, headers: NO_STORE_PRIVATE_HEADERS }
    )
  }
}
