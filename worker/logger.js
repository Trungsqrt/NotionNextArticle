'use strict'

const SECRET_PATTERNS = [
  /\b(secret_[A-Za-z0-9]{16,})\b/g,
  /\b(ntn_[A-Za-z0-9]{16,})\b/g,
  /\b(sk-[A-Za-z0-9_-]{16,})\b/g,
  /\b(AIza[A-Za-z0-9_-]{20,})\b/g,
  /("?(?:api[_-]?key|authorization|token|secret)"?\s*[:=]\s*"?)([^"\s,}]+)/gi,
]

function redactSecrets(input, explicitSecrets = []) {
  if (input === null || input === undefined) return ''
  let str = typeof input === 'string' ? input : JSON.stringify(input)
  for (const secret of explicitSecrets) {
    if (secret && typeof secret === 'string' && secret.length >= 6) {
      str = str.split(secret).join('[REDACTED]')
    }
  }
  for (const pattern of SECRET_PATTERNS) {
    str = str.replace(pattern, (match, g1, g2) => {
      if (g2 !== undefined) return `${g1}[REDACTED]`
      return '[REDACTED]'
    })
  }
  return str
}

function formatMeta(meta, explicitSecrets) {
  if (!meta || (typeof meta === 'object' && Object.keys(meta).length === 0)) {
    return ''
  }
  try {
    if (meta instanceof Error) {
      return ` ${redactSecrets(meta.message || String(meta), explicitSecrets)}`
    }
    return ` ${redactSecrets(JSON.stringify(meta), explicitSecrets)}`
  } catch {
    return ' [unserializable-meta]'
  }
}

function createLogger(options = {}) {
  const {
    prefix = 'translation-worker',
    level = process.env.LOG_LEVEL || 'info',
    secrets = [],
    sink = console,
    silent = false,
  } = options

  const levels = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 }
  const currentThreshold = silent ? 100 : (levels[String(level).toLowerCase()] ?? 20)

  const getExplicitSecrets = () => [
    ...secrets,
    process.env.NOTION_TOKEN,
    process.env.NOTION_API_SECRET,
    process.env.NOTION_TOKEN_V2,
    process.env.AI_API_KEY,
    process.env.OPENAI_API_KEY,
    process.env.GEMINI_API_KEY,
    process.env.GOOGLE_API_KEY,
    process.env.ANTHROPIC_API_KEY,
  ].filter(Boolean)

  function log(lvl, message, meta) {
    if ((levels[lvl] ?? 20) < currentThreshold) return
    const ts = new Date().toISOString()
    const explicit = getExplicitSecrets()
    const safeMsg = redactSecrets(String(message), explicit)
    const safeMeta = formatMeta(meta, explicit)
    const line = `[${ts}] [${lvl.toUpperCase()}] [${prefix}] ${safeMsg}${safeMeta}`

    if (lvl === 'error') {
      sink.error(line)
    } else if (lvl === 'warn') {
      sink.warn(line)
    } else {
      sink.log(line)
    }
  }

  return {
    debug: (msg, meta) => log('debug', msg, meta),
    info: (msg, meta) => log('info', msg, meta),
    warn: (msg, meta) => log('warn', msg, meta),
    error: (msg, meta) => log('error', msg, meta),
    child(subPrefix) {
      return createLogger({
        ...options,
        prefix: `${prefix}:${subPrefix}`,
      })
    },
  }
}

const defaultLogger = createLogger()

module.exports = {
  createLogger,
  defaultLogger,
  redactSecrets,
}

