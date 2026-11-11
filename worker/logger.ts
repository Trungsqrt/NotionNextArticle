import pino from 'pino'
import type { WorkerLogger } from '../lib/notion-translation/types'

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(secret_[A-Za-z0-9]{16,})\b/g,
  /\b(ntn_[A-Za-z0-9]{16,})\b/g,
  /\b(sk-[A-Za-z0-9_-]{16,})\b/g,
  /\b(AIza[A-Za-z0-9_-]{20,})\b/g,
  /("?(?:api[_-]?key|authorization|token|secret)"?\s*[:=]\s*"?)([^"\s,}]+)/gi,
]

export function redactSecrets(
  input: unknown,
  explicitSecrets: readonly string[] = []
): string {
  if (input === null || input === undefined) return ''
  let str = typeof input === 'string' ? input : JSON.stringify(input)

  for (const secret of explicitSecrets) {
    if (secret && typeof secret === 'string' && secret.length >= 6) {
      str = str.split(secret).join('[REDACTED]')
    }
  }

  for (const pattern of SECRET_PATTERNS) {
    str = str.replace(pattern, (_match, g1: string | undefined, g2: string | undefined) => {
      if (g2 !== undefined && g1 !== undefined) return `${g1}[REDACTED]`
      return '[REDACTED]'
    })
  }
  return str
}

export interface CreateLoggerOptions {
  prefix?: string
  level?: string
  secrets?: string[]
  silent?: boolean
}

export function createLogger(options: CreateLoggerOptions = {}): WorkerLogger {
  const {
    prefix = 'translation-worker',
    level = process.env.LOG_LEVEL || 'info',
    secrets = [],
    silent = false,
  } = options

  const pinoInstance = pino({
    name: prefix,
    level: silent ? 'silent' : level.toLowerCase(),
    redact: {
      paths: [
        'notionToken',
        'aiApiKey',
        'apiKey',
        'token',
        'secret',
        'authorization',
        'headers.authorization',
        'headers.Authorization',
        '*.notionToken',
        '*.aiApiKey',
        '*.apiKey',
        '*.token',
        '*.secret',
      ],
      censor: '[REDACTED]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  })

  function collectSecrets(): string[] {
    return [
      ...secrets,
      process.env.NOTION_TOKEN,
      process.env.NOTION_API_SECRET,
      process.env.NOTION_TOKEN_V2,
      process.env.AI_API_KEY,
      process.env.OPENAI_API_KEY,
      process.env.GEMINI_API_KEY,
      process.env.GOOGLE_API_KEY,
      process.env.ANTHROPIC_API_KEY,
    ].filter((val): val is string => Boolean(val && val.length >= 6))
  }

  function sanitizeMeta(
    meta?: Record<string, unknown> | Error
  ): Record<string, unknown> | undefined {
    if (!meta) return undefined
    const explicit = collectSecrets()
    if (meta instanceof Error) {
      return {
        error: redactSecrets(meta.message || String(meta), explicit),
        code: (meta as { code?: unknown }).code,
      }
    }
    try {
      const redactedJson = redactSecrets(JSON.stringify(meta), explicit)
      return JSON.parse(redactedJson) as Record<string, unknown>
    } catch {
      return { meta: '[unserializable-meta]' }
    }
  }

  function write(
    lvl: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    meta?: Record<string, unknown> | Error
  ): void {
    const safeMsg = redactSecrets(String(message), collectSecrets())
    const safeMeta = sanitizeMeta(meta)
    if (safeMeta && Object.keys(safeMeta).length > 0) {
      pinoInstance[lvl](safeMeta, safeMsg)
    } else {
      pinoInstance[lvl](safeMsg)
    }
  }

  return {
    debug: (msg, meta) => write('debug', msg, meta),
    info: (msg, meta) => write('info', msg, meta),
    warn: (msg, meta) => write('warn', msg, meta),
    error: (msg, meta) => write('error', msg, meta),
    child(subPrefix: string): WorkerLogger {
      return createLogger({
        ...options,
        prefix: `${prefix}:${subPrefix}`,
      })
    },
  }
}

export const defaultLogger: WorkerLogger = createLogger()

