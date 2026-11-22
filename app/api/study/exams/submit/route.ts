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
import { submitExamSession } from '../../../../../lib/study/services/exam-service'

export const dynamic = 'force-dynamic'

const submitBodySchema = z.object({
  examToken: z.string().min(20).max(20000),
  answers: z.record(z.string(), z.array(z.string().trim().min(1).max(16)).max(10)),
})

export async function POST(request: Request) {
  const rate = checkApiRateLimit(getClientIp(request), 'study-exam-submit', 30, 60 * 1000)
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

  const parsed = submitBodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid exam submission payload' }, { status: 400, headers: NO_STORE_PRIVATE_HEADERS })
  }

  try {
    const authConfig = getStudyAuthConfig()
    const repos = createNotionStudyRepositories()
    const graded = await submitExamSession(
      {
        userId: guard.user.userId,
        examToken: parsed.data.examToken,
        answers: parsed.data.answers,
        sessionSecret: authConfig.sessionSecret,
      },
      repos
    )
    return NextResponse.json(graded, { status: 200, headers: NO_STORE_PRIVATE_HEADERS })
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    if (msg.includes('another user')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: NO_STORE_PRIVATE_HEADERS })
    }
    if (msg.includes('Invalid exam') || msg.includes('expired')) {
      return NextResponse.json({ error: msg }, { status: 400, headers: NO_STORE_PRIVATE_HEADERS })
    }
    return NextResponse.json(
      { error: 'Unable to grade exam right now.' },
      { status: 503, headers: NO_STORE_PRIVATE_HEADERS }
    )
  }
}
