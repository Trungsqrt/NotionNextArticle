import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { TranslationConfig } from '../config'

const SENSITIVE_KEY_PATTERN =
  /(token|secret|api[_-]?key|authorization|password|credential)/i

/**
 * Recursively strips any properties whose keys resemble secrets or tokens
 * before serializing local worker state files to disk.
 */
export function sanitizeCheckpointValue<T>(value: T): T {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeCheckpointValue(item)) as unknown as T
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) continue
      out[k] = sanitizeCheckpointValue(v)
    }
    return out as T
  }
  return value
}

export function getStateDirectoryPath(
  config: Partial<TranslationConfig> = {}
): string {
  return (
    config.stateDirPath ||
    process.env.TRANSLATION_STATE_DIR ||
    path.join(process.cwd(), '.translation-worker-state')
  )
}

/**
 * Atomically writes a sanitized JSON payload using a unique temp file + rename
 * so sudden crashes never leave a truncated or corrupted state file on disk.
 */
export function writeAtomicJsonFile<T>(filePath: string, payload: T): T {
  const dirPath = path.dirname(filePath)
  fs.mkdirSync(dirPath, { recursive: true })

  const safePayload = sanitizeCheckpointValue<T>(payload)
  const serialized = JSON.stringify(safePayload, null, 2)
  const rand = crypto.randomBytes(4).toString('hex')
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${rand}`

  fs.writeFileSync(tmpPath, serialized, 'utf8')
  try {
    fs.renameSync(tmpPath, filePath)
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath)
    } catch {
      // Ignore temp cleanup failure
    }
    throw err
  }
  return safePayload
}
