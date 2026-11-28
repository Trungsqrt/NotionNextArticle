import { normalizeNotionId } from '../notion-client'

/**
 * Single source of truth tracking Notion page IDs currently being processed
 * as part of an active (root or hierarchical) translation job in this worker process.
 */
const activeJobResourceIds = new Set<string>()

export function isPageInActiveTranslationJob(pageId: string): boolean {
  const norm = normalizeNotionId(pageId)
  return Boolean(norm && activeJobResourceIds.has(norm))
}

export function markPageActiveInTranslationJob(pageId: string): void {
  const norm = normalizeNotionId(pageId)
  if (norm) activeJobResourceIds.add(norm)
}

export function unmarkPageActiveInTranslationJob(pageId: string): void {
  const norm = normalizeNotionId(pageId)
  if (norm) activeJobResourceIds.delete(norm)
}
