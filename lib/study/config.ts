/**
 * lib/study/config.ts — Server-only environment configuration for Private Study System
 * ──────────────────────────────────────────────────────────────────────────────────
 * Reads dedicated STUDY_NOTION_* environment variables. Intentionally NEVER falls
 * back to public NOTION_TOKEN or NOTION_ROOT_PAGE_ID so public and private Notion
 * boundaries remain strictly isolated.
 */

export interface StudyNotionConfig {
  token: string
  usersDbId: string
  examsDbId: string
  questionsDbId: string
  cardStatesDbId: string
  reviewEventsDbId: string
  /** Optional dedicated Study Bookmarks database ID (STUDY_NOTION_BOOKMARKS_DB_ID) */
  bookmarksDbId?: string
  timeoutMs: number
  maxRetries: number
  minIntervalMs: number
  maxPaginationPages: number
}

function assertServerOnly(moduleName: string): void {
  if ('window' in globalThis) {
    throw new Error(`${moduleName} is server-only and must never be executed in the browser`)
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback
  const parsed = Number.parseInt(raw.trim(), 10)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback
  return parsed
}

function readRequiredEnv(env: Record<string, string | undefined>, key: string): string {
  const value = (env[key] || '').trim()
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`)
  }
  return value
}

export function isStudyNotionConfigured(
  env: Record<string, string | undefined> = process.env
): boolean {
  return Boolean(
    env.STUDY_NOTION_TOKEN?.trim() &&
      env.STUDY_NOTION_USERS_DB_ID?.trim() &&
      env.STUDY_NOTION_EXAMS_DB_ID?.trim() &&
      env.STUDY_NOTION_QUESTIONS_DB_ID?.trim() &&
      env.STUDY_NOTION_CARD_STATES_DB_ID?.trim() &&
      env.STUDY_NOTION_REVIEW_EVENTS_DB_ID?.trim()
  )
}

export interface StudyAuthConfig {
  sessionSecret: string
  sessionTtlHours: number
  isProduction: boolean
}

export function getStudyAuthConfig(
  env: Record<string, string | undefined> = process.env
): StudyAuthConfig {
  assertServerOnly('lib/study/config')
  const sessionSecret = readRequiredEnv(env, 'STUDY_SESSION_SECRET')
  if (sessionSecret.length < 32) {
    throw new Error('STUDY_SESSION_SECRET must be at least 32 characters long')
  }
  return {
    sessionSecret,
    sessionTtlHours: parsePositiveInt(env.STUDY_SESSION_TTL_HOURS, 168, 1, 720),
    isProduction: env.NODE_ENV === 'production',
  }
}

export function isStudyAuthConfigured(
  env: Record<string, string | undefined> = process.env
): boolean {
  return (
    isStudyNotionConfigured(env) &&
    Boolean(env.STUDY_SESSION_SECRET && env.STUDY_SESSION_SECRET.trim().length >= 32)
  )
}

export function isStudyBookmarksConfigured(
  env: Record<string, string | undefined> = process.env
): boolean {
  return Boolean(isStudyNotionConfigured(env) && env.STUDY_NOTION_BOOKMARKS_DB_ID?.trim())
}

export function getStudyNotionConfig(
  env: Record<string, string | undefined> = process.env
): StudyNotionConfig {
  assertServerOnly('lib/study/config')

  const bookmarksDbId = (env.STUDY_NOTION_BOOKMARKS_DB_ID || '').trim() || undefined

  return {
    token: readRequiredEnv(env, 'STUDY_NOTION_TOKEN'),
    usersDbId: readRequiredEnv(env, 'STUDY_NOTION_USERS_DB_ID'),
    examsDbId: readRequiredEnv(env, 'STUDY_NOTION_EXAMS_DB_ID'),
    questionsDbId: readRequiredEnv(env, 'STUDY_NOTION_QUESTIONS_DB_ID'),
    cardStatesDbId: readRequiredEnv(env, 'STUDY_NOTION_CARD_STATES_DB_ID'),
    reviewEventsDbId: readRequiredEnv(env, 'STUDY_NOTION_REVIEW_EVENTS_DB_ID'),
    ...(bookmarksDbId ? { bookmarksDbId } : {}),
    timeoutMs: parsePositiveInt(env.STUDY_NOTION_TIMEOUT_MS, 15000, 1000, 60000),
    maxRetries: parsePositiveInt(env.STUDY_NOTION_MAX_RETRIES, 3, 0, 6),
    minIntervalMs: parsePositiveInt(env.STUDY_NOTION_MIN_INTERVAL_MS, 350, 0, 5000),
    maxPaginationPages: parsePositiveInt(env.STUDY_NOTION_MAX_PAGINATION_PAGES, 100, 1, 500),
  }
}
