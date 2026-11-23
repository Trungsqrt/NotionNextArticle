/**
 * app/api/study/images/[blockId]/route.ts — Authenticated private study image delivery
 * ────────────────────────────────────────────────────────────────────────────────────
 * Streams private Notion-hosted study images strictly to authenticated Study Room
 * sessions using the isolated `STUDY_NOTION_TOKEN` integration.
 *
 * Security model:
 * - Enforces server-side authentication via `requireStudyApiSession` (401/403).
 * - Accepts ONLY a strict Notion UUID `blockId` (never arbitrary external URLs).
 * - Fetches the short-lived Notion signed S3 URL server-side and streams the image
 *   bytes directly with `Cache-Control: private, no-store, max-age=0` and
 *   `X-Robots-Tag: noindex, nofollow`, so raw S3 signed URLs are NEVER exposed to
 *   the browser.
 * - Inherent limitation: an authorized user who can view an image in their browser
 *   can still copy or save the rendered image bytes locally.
 */

import { NextResponse } from 'next/server'
import { requireStudyApiSession } from '../../../../../lib/study/auth/guard'
import {
  NO_STORE_PRIVATE_HEADERS,
  getClientIp,
  checkApiRateLimitAsync,
} from '../../../../../lib/study/auth/security'
import { getStudyNotionConfig } from '../../../../../lib/study/config'
import { getDefaultStudyNotionClient } from '../../../../../lib/study/notion-client'

export const dynamic = 'force-dynamic'

const NOTION_UUID_REGEX =
  /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i

const ALLOWED_IMAGE_MIME_PREFIX = 'image/'
const MAX_STREAM_BYTES = 20 * 1024 * 1024 // 20 MB

export async function GET(
  request: Request,
  context: { params: Promise<{ blockId: string }> }
) {
  const rate = await checkApiRateLimitAsync(
    getClientIp(request),
    'study-image',
    120,
    60 * 1000
  )
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

  const { blockId } = await context.params
  const cleanBlockId = (blockId || '').trim()
  if (!NOTION_UUID_REGEX.test(cleanBlockId)) {
    return NextResponse.json(
      { error: 'Invalid image identifier' },
      { status: 400, headers: NO_STORE_PRIVATE_HEADERS }
    )
  }

  try {
    const config = getStudyNotionConfig()
    const client = getDefaultStudyNotionClient()
    if (!client.retrieveAuthorizedQuestionImageUrl) {
      return NextResponse.json(
        { error: 'Image delivery unavailable' },
        { status: 503, headers: NO_STORE_PRIVATE_HEADERS }
      )
    }

    const fresh = await client.retrieveAuthorizedQuestionImageUrl(cleanBlockId, {
      questionsDbId: config.questionsDbId,
      allowDraft: guard.user.role === 'admin',
    })
    if (!fresh?.url) {
      return NextResponse.json(
        { error: 'Image not available' },
        { status: 404, headers: NO_STORE_PRIVATE_HEADERS }
      )
    }

    const upstream = await fetch(fresh.url, {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    })

    if (!upstream.ok) {
      return NextResponse.json(
        { error: 'Unable to load image' },
        { status: 502, headers: NO_STORE_PRIVATE_HEADERS }
      )
    }

    const contentType = (upstream.headers.get('content-type') || 'application/octet-stream')
      .split(';')[0]
      .trim()
      .toLowerCase()

    if (!contentType.startsWith(ALLOWED_IMAGE_MIME_PREFIX)) {
      return NextResponse.json(
        { error: 'Unsupported asset type' },
        { status: 415, headers: NO_STORE_PRIVATE_HEADERS }
      )
    }

    const contentLengthHeader = upstream.headers.get('content-length')
    if (contentLengthHeader) {
      const length = Number.parseInt(contentLengthHeader, 10)
      if (Number.isFinite(length) && length > MAX_STREAM_BYTES) {
        return NextResponse.json(
          { error: 'Image exceeds maximum allowed size' },
          { status: 413, headers: NO_STORE_PRIVATE_HEADERS }
        )
      }
    }

    const buffer = await upstream.arrayBuffer()
    if (buffer.byteLength > MAX_STREAM_BYTES) {
      return NextResponse.json(
        { error: 'Image exceeds maximum allowed size' },
        { status: 413, headers: NO_STORE_PRIVATE_HEADERS }
      )
    }

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        ...NO_STORE_PRIVATE_HEADERS,
        'Content-Type': contentType,
        'X-Content-Type-Options': 'nosniff',
        'Content-Length': String(buffer.byteLength),
      },
    })
  } catch {
    return NextResponse.json(
      { error: 'Unable to retrieve image' },
      { status: 502, headers: NO_STORE_PRIVATE_HEADERS }
    )
  }
}
