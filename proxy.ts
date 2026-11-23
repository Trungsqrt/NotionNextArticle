/**
 * proxy.ts — Next.js 16 edge routing guard for Private Study Room
 * ────────────────────────────────────────────────────────────────
 * Applies defense-in-depth headers (`X-Robots-Tag`, `Cache-Control: no-store`)
 * and fast unauthenticated gating on `/study/*` and `/api/study/*`.
 *
 * IMPORTANT: Full cryptographic signature verification, Notion status checks,
 * credential-version revocation, and role/cross-user authorization are ALSO
 * enforced at the server-side data-access boundary in `lib/study/auth/guard.ts`.
 */

import { NextResponse, type NextRequest } from 'next/server'

const COOKIE_PROD = '__Host-study_session'
const COOKIE_DEV = 'study_session'

function applyPrivateHeaders(response: NextResponse): NextResponse {
  response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet')
  response.headers.set('Cache-Control', 'private, no-store, max-age=0')
  return response
}

function hasSessionCookie(request: NextRequest): boolean {
  return Boolean(
    request.cookies.get(COOKIE_PROD)?.value ||
      request.cookies.get(COOKIE_DEV)?.value
  )
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // 1. Protect /api/study/* (allow login & logout endpoints without an existing cookie)
  if (pathname.startsWith('/api/study/')) {
    const isPublicAuthEndpoint =
      pathname === '/api/study/auth/login' || pathname === '/api/study/auth/logout'

    if (!isPublicAuthEndpoint && !hasSessionCookie(request)) {
      return applyPrivateHeaders(
        NextResponse.json({ error: 'Authentication required' }, { status: 401 })
      )
    }

    return applyPrivateHeaders(NextResponse.next())
  }

  // 2. Protect /study and /study/* (allow /study/login without a cookie)
  if (pathname === '/study' || pathname.startsWith('/study/')) {
    if (pathname === '/study/login') {
      return applyPrivateHeaders(NextResponse.next())
    }

    if (!hasSessionCookie(request)) {
      const loginUrl = request.nextUrl.clone()
      loginUrl.pathname = '/study/login'
      loginUrl.search = `?next=${encodeURIComponent(pathname)}`
      return applyPrivateHeaders(NextResponse.redirect(loginUrl))
    }

    return applyPrivateHeaders(NextResponse.next())
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/study', '/study/:path*', '/api/study/:path*'],
}
