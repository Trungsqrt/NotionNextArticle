/**
 * lib/study/importer/image-resolver.ts — Safe local image path & file resolver
 * ────────────────────────────────────────────────────────────────────────────
 * Resolves relative `<img src="...">` paths against the HTML file's directory,
 * prevents path traversal outside the source root, rejects remote/data/script
 * URLs, enforces allowed image extensions and Notion's 20MB upload limit, and
 * hashes local files with SHA-256 for deduplication.
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  NOTION_FREE_PLAN_MAX_FILE_BYTES,
  NOTION_SINGLE_PART_MAX_BYTES,
} from '../notion-client'

const ALLOWED_EXTENSIONS: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
}

const DISALLOWED_PROTOCOL_REGEX = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i

export type ResolveImageResult =
  | {
      ok: true
      absolutePath: string
      relativeToSourceRoot: string
      originalFilename: string
      contentType: string
      byteLength: number
      sha256: string
    }
  | {
      ok: false
      kind: 'invalid' | 'missing' | 'oversized'
      reason: string
      resolvedPath?: string
      byteLength?: number
      maxFileBytes?: number
    }

/**
 * Safely resolves and validates a single local image reference relative to
 * `htmlFilePath`, ensuring it stays strictly inside `sourceRootDir` and does
 * not exceed Notion's per-file upload limit (default 5 MB for Notion Free plan).
 * Combined folder size is intentionally NOT restricted.
 */
export function resolveLocalImageReference(
  rawSourceRef: string,
  htmlFilePath: string,
  sourceRootDir: string,
  options?: { maxFileBytes?: number }
): ResolveImageResult {
  const maxFileBytes = Math.min(
    options?.maxFileBytes ?? NOTION_FREE_PLAN_MAX_FILE_BYTES,
    NOTION_SINGLE_PART_MAX_BYTES
  )
  const trimmed = (rawSourceRef || '').trim()
  if (!trimmed) {
    return { ok: false, kind: 'invalid', reason: 'Empty image src attribute' }
  }

  // Strip query string / hash if present on a relative path
  const withoutQuery = trimmed.split(/[?#]/)[0]

  // Reject remote URLs (http/https/protocol-relative), data URIs, javascript:, file:
  if (DISALLOWED_PROTOCOL_REGEX.test(trimmed)) {
    return {
      ok: false,
      kind: 'invalid',
      reason: 'Remote or non-file image URLs are rejected by local import policy',
    }
  }

  // Reject null bytes or absolute paths
  if (withoutQuery.includes('\0') || path.isAbsolute(withoutQuery) || /^[a-zA-Z]:/.test(withoutQuery)) {
    return {
      ok: false,
      kind: 'invalid',
      reason: 'Absolute or malformed image path is not allowed',
    }
  }

  let decoded: string
  try {
    decoded = decodeURIComponent(withoutQuery)
  } catch {
    return { ok: false, kind: 'invalid', reason: 'Malformed URL-encoded image path' }
  }

  const canonicalRoot = path.resolve(sourceRootDir)
  const htmlDir = path.dirname(path.resolve(htmlFilePath))
  const resolvedPath = path.resolve(htmlDir, decoded)

  // Strict path traversal check: resolvedPath MUST stay inside canonicalRoot
  const relFromRoot = path.relative(canonicalRoot, resolvedPath)
  if (!relFromRoot || relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
    return {
      ok: false,
      kind: 'invalid',
      reason: 'Path traversal outside source directory is forbidden',
      resolvedPath,
    }
  }

  const ext = path.extname(resolvedPath).toLowerCase()
  const contentType = ALLOWED_EXTENSIONS[ext]
  if (!contentType) {
    return {
      ok: false,
      kind: 'invalid',
      reason: `Unsupported image extension "${ext || '(none)'}"`,
      resolvedPath,
    }
  }

  if (!fs.existsSync(resolvedPath)) {
    return {
      ok: false,
      kind: 'missing',
      reason: 'Referenced local image file does not exist',
      resolvedPath,
    }
  }

  let stat: fs.Stats
  try {
    stat = fs.statSync(resolvedPath)
  } catch {
    return {
      ok: false,
      kind: 'missing',
      reason: 'Unable to stat referenced local image file',
      resolvedPath,
    }
  }

  if (!stat.isFile()) {
    return {
      ok: false,
      kind: 'invalid',
      reason: 'Referenced image path is not a regular file',
      resolvedPath,
    }
  }

  if (stat.size <= 0) {
    return {
      ok: false,
      kind: 'invalid',
      reason: 'Image file is empty (0 bytes)',
      resolvedPath,
    }
  }

  if (stat.size > maxFileBytes) {
    const sizeMb = (stat.size / (1024 * 1024)).toFixed(2)
    const limitMb = (maxFileBytes / (1024 * 1024)).toFixed(2)
    return {
      ok: false,
      kind: 'oversized',
      reason: `Individual image file exceeds Notion per-file limit (${sizeMb} MB > ${limitMb} MB)`,
      resolvedPath,
      byteLength: stat.size,
      maxFileBytes,
    }
  }

  const buffer = fs.readFileSync(resolvedPath)
  const sha256 = createHash('sha256').update(buffer).digest('hex')

  return {
    ok: true,
    absolutePath: resolvedPath,
    relativeToSourceRoot: relFromRoot.replace(/\\/g, '/'),
    originalFilename: path.basename(resolvedPath),
    contentType,
    byteLength: stat.size,
    sha256,
  }
}
