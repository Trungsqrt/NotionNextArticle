import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireStudyApiSession } from '../../../../lib/study/auth/guard'
import {
  NO_STORE_PRIVATE_HEADERS,
  getClientIp,
  checkApiRateLimitAsync,
} from '../../../../lib/study/auth/security'
import {
  createNotionStudyRepositories,
  ConcurrencyConflictError,
} from '../../../../lib/study/repositories'
import { stableIdSchema } from '../../../../lib/study/schemas'
import {
  BookmarkServiceError,
  getUserBookmarksForExam,
  importLegacyBookmarks,
  listAllUserBookmarks,
  mutateUserBookmark,
  syncUserBookmarks,
} from '../../../../lib/study/services/bookmark-service'

export const dynamic = 'force-dynamic'

const bookmarkMutationSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.enum(['add', 'remove']),
    examId: stableIdSchema,
    questionId: stableIdSchema,
  }),
  z.object({
    action: z.literal('sync'),
    examId: stableIdSchema,
    add: z.array(stableIdSchema).max(500).default([]),
    remove: z.array(stableIdSchema).max(500).default([]),
  }),
  z.object({
    action: z.literal('import'),
    examId: stableIdSchema,
    questionIds: z.array(stableIdSchema).max(500),
  }),
])

function buildRateLimitedResponse(err: unknown): NextResponse | null {
  if (!err || typeof err !== 'object') return null
  const e = err as { status?: number; notionCode?: string; retryAfterSec?: number }
  if (e.status === 429 || e.notionCode === 'rate_limited') {
    const retryAfterSec =
      typeof e.retryAfterSec === 'number' && Number.isFinite(e.retryAfterSec) && e.retryAfterSec > 0
        ? Math.min(Math.ceil(e.retryAfterSec), 60)
        : 2
    return NextResponse.json(
      { error: 'Bookmark storage is busy. Please retry shortly.', code: 'RATE_LIMITED' },
      {
        status: 429,
        headers: { ...NO_STORE_PRIVATE_HEADERS, 'Retry-After': String(retryAfterSec) },
      }
    )
  }
  return null
}

export async function GET(request: Request) {
  const rate = await checkApiRateLimitAsync(
    getClientIp(request),
    'study-bookmarks-read',
    120,
    60 * 1000
  )
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Too many requests' },
      {
        status: 429,
        headers: { ...NO_STORE_PRIVATE_HEADERS, 'Retry-After': String(rate.retryAfterSec) },
      }
    )
  }

  const guard = await requireStudyApiSession(request)
  if (!guard.ok) return guard.response

  const { searchParams } = new URL(request.url)
  const rawExamId = searchParams.get('examId')?.trim() || ''

  try {
    const repos = createNotionStudyRepositories()
    if (rawExamId) {
      const parsedExamId = stableIdSchema.safeParse(rawExamId)
      if (!parsedExamId.success) {
        return NextResponse.json(
          { error: 'Invalid examId' },
          { status: 400, headers: NO_STORE_PRIVATE_HEADERS }
        )
      }
      const result = await getUserBookmarksForExam(guard.user.userId, parsedExamId.data, repos)
      return NextResponse.json(result, { status: 200, headers: NO_STORE_PRIVATE_HEADERS })
    }

    const result = await listAllUserBookmarks(guard.user.userId, repos)
    return NextResponse.json(result, { status: 200, headers: NO_STORE_PRIVATE_HEADERS })
  } catch (err) {
    if (err instanceof BookmarkServiceError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status, headers: NO_STORE_PRIVATE_HEADERS }
      )
    }
    const rateLimited = buildRateLimitedResponse(err)
    if (rateLimited) return rateLimited
    return NextResponse.json(
      { error: 'Unable to load bookmarks right now.' },
      { status: 503, headers: NO_STORE_PRIVATE_HEADERS }
    )
  }
}

export async function POST(request: Request) {
  const rate = await checkApiRateLimitAsync(
    getClientIp(request),
    'study-bookmarks-write',
    120,
    60 * 1000
  )
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Too many requests' },
      {
        status: 429,
        headers: { ...NO_STORE_PRIVATE_HEADERS, 'Retry-After': String(rate.retryAfterSec) },
      }
    )
  }

  const guard = await requireStudyApiSession(request)
  if (!guard.ok) return guard.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: 'Invalid request body' },
      { status: 400, headers: NO_STORE_PRIVATE_HEADERS }
    )
  }

  const parsed = bookmarkMutationSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid bookmark payload' },
      { status: 400, headers: NO_STORE_PRIVATE_HEADERS }
    )
  }

  try {
    const repos = createNotionStudyRepositories()
    if (parsed.data.action === 'import') {
      const result = await importLegacyBookmarks(
        {
          userId: guard.user.userId,
          examId: parsed.data.examId,
          questionIds: parsed.data.questionIds,
        },
        repos
      )
      return NextResponse.json(result, { status: 200, headers: NO_STORE_PRIVATE_HEADERS })
    }

    if (parsed.data.action === 'sync') {
      const result = await syncUserBookmarks(
        {
          userId: guard.user.userId,
          examId: parsed.data.examId,
          add: parsed.data.add,
          remove: parsed.data.remove,
        },
        repos
      )
      return NextResponse.json(result, { status: 200, headers: NO_STORE_PRIVATE_HEADERS })
    }

    const result = await mutateUserBookmark(
      {
        userId: guard.user.userId,
        examId: parsed.data.examId,
        questionId: parsed.data.questionId,
        action: parsed.data.action,
      },
      repos
    )
    return NextResponse.json(result, { status: 200, headers: NO_STORE_PRIVATE_HEADERS })
  } catch (err) {
    if (err instanceof BookmarkServiceError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status, headers: NO_STORE_PRIVATE_HEADERS }
      )
    }
    if (err instanceof ConcurrencyConflictError) {
      return NextResponse.json(
        {
          error: 'Bookmarks were updated concurrently. Please retry.',
          code: err.code,
        },
        { status: 409, headers: NO_STORE_PRIVATE_HEADERS }
      )
    }
    const rateLimited = buildRateLimitedResponse(err)
    if (rateLimited) return rateLimited
    return NextResponse.json(
      { error: 'Unable to synchronize bookmark right now.' },
      { status: 503, headers: NO_STORE_PRIVATE_HEADERS }
    )
  }
}
