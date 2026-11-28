import type { Client } from '@notionhq/client'
import { getTranslationConfig } from '../config'
import { getMappedTargetPage, readJobCheckpoint } from '../checkpoint-store'
import { normalizeNotionId, withNotionRetry } from '../notion-client'
import { readRawNotionTree } from '../reader'
import type {
  DatabasePageIndices,
  ExistingTranslationInspection,
  IndexedDatabasePage,
  NotionBlockTree,
  NotionPageLike,
  PageWorkflowMeta,
} from '../types'
import { extractPageWorkflowMeta } from './state'
import type { InspectExistingTranslationOptions } from './types'

/**
 * Inspects whether a target page already exists for the source page and determines
 * whether the job should create a new page, resume an empty Draft page, resume a
 * partially written Draft page with a matching local checkpoint, or stop to prevent duplicates.
 *
 * Protection invariants:
 * - Never overwrites or resumes a Published (non-Draft) target page.
 * - Flags multiple existing target pages for the same group as `duplicate_exists`.
 * - Requires explicit job association (source target ID, checkpoint target ID, or group ID)
 *   before permitting resume of an empty or partially written Draft target page.
 */
export async function inspectExistingTranslationState(
  client: Client,
  sourceMeta: PageWorkflowMeta,
  translationGroupId: string,
  indices: DatabasePageIndices | null | undefined,
  targetLocale = 'vi',
  options: InspectExistingTranslationOptions = {}
): Promise<ExistingTranslationInspection> {
  const config = options.config || getTranslationConfig()
  const checkpoint =
    options.checkpoint !== undefined
      ? options.checkpoint
      : readJobCheckpoint(sourceMeta.id, config)

  const sourceNormId = normalizeNotionId(sourceMeta.id)
  const groupKey = String(translationGroupId || '').trim().toLowerCase()
  const candidatesMap = new Map<string, IndexedDatabasePage>()

  // 1. Check database pages with matching Translation Group ID + targetLocale
  if (groupKey && indices?.pagesByGroupAndLocale?.has(groupKey)) {
    const byLocale = indices.pagesByGroupAndLocale.get(groupKey)
    const matches = byLocale?.get(targetLocale) || []
    for (const entry of matches) {
      const normId = normalizeNotionId(entry.meta.id)
      if (normId && normId !== sourceNormId) {
        candidatesMap.set(normId, entry)
      }
    }
  }

  // 2. Also check explicit Translation Target Page ID on the source page, checkpoint targetPageId, or persistent resource-map
  const mappedTarget = getMappedTargetPage(sourceMeta.id, targetLocale, config)
  const explicitTargetIds = [
    sourceMeta.translationTargetPageId,
    checkpoint?.targetPageId,
    mappedTarget?.targetPageId,
  ].filter((val): val is string => Boolean(val))

  for (const rawTargetId of explicitTargetIds) {
    const targetId = String(rawTargetId).trim()
    const targetNormId = normalizeNotionId(targetId)
    if (
      targetNormId &&
      targetNormId !== sourceNormId &&
      !candidatesMap.has(targetNormId)
    ) {
      const known = indices?.metaByPageId?.get(targetNormId)
      if (known) {
        candidatesMap.set(targetNormId, known)
      } else if (typeof client?.pages?.retrieve === 'function') {
        try {
          const retrieved = (await withNotionRetry(
            () => client.pages.retrieve({ page_id: targetId }),
            {
              isIdempotent: true,
              label: `pages.retrieve(${targetId})`,
              logger: options.logger,
              ...options.retryOptions,
            }
          )) as NotionPageLike
          if (retrieved && !retrieved.in_trash && !retrieved.archived) {
            candidatesMap.set(targetNormId, {
              page: retrieved,
              meta: extractPageWorkflowMeta(retrieved, options.dataSourceInfo),
            })
          }
        } catch {
          // Target page ID no longer exists in Notion
        }
      }
    }
  }

  const candidateList = Array.from(candidatesMap.values())
  if (candidateList.length === 0) {
    return { action: 'create_new', checkpoint }
  }

  if (candidateList.length > 1) {
    const summary = candidateList
      .map(
        (c) =>
          `"${c.meta.title}" (id: ${c.meta.id}, slug: ${c.meta.slug}, status: ${c.meta.status})`
      )
      .join(', ')
    return {
      action: 'duplicate_exists',
      existingPages: candidateList,
      primaryPage: candidateList[0]!,
      reason: `Multiple (${candidateList.length}) ${targetLocale.toUpperCase()} pages already exist for Translation Group ID "${translationGroupId}": ${summary}`,
    }
  }

  const single = candidateList[0]!
  const singleNormId = normalizeNotionId(single.meta.id)
  const isTargetDraft = single.meta.status.toLowerCase() === 'draft'
  const matchesSourceTargetId =
    Boolean(sourceMeta.translationTargetPageId) &&
    normalizeNotionId(sourceMeta.translationTargetPageId) === singleNormId
  const matchesCheckpointTargetId =
    Boolean(checkpoint?.targetPageId) &&
    normalizeNotionId(checkpoint?.targetPageId) === singleNormId
  const matchesGroupId =
    Boolean(groupKey) &&
    single.meta.translationGroupId.trim().toLowerCase() === groupKey

  let existingBlocks: NotionBlockTree
  try {
    existingBlocks = await readRawNotionTree(single.meta.id, {
      client,
      config,
      logger: options.logger,
      retryOptions: options.retryOptions,
    })
  } catch {
    return {
      action: 'duplicate_exists',
      existingPages: [single],
      primaryPage: single,
      reason: `Existing ${targetLocale.toUpperCase()} page found: "${single.meta.title}" (id: ${single.meta.id}, slug: ${single.meta.slug}, status: ${single.meta.status}).`,
    }
  }

  // Never overwrite or resume a Published page
  if (!isTargetDraft) {
    return {
      action: 'duplicate_exists',
      existingPages: [single],
      primaryPage: single,
      existingTree: existingBlocks,
      reason: `Existing ${targetLocale.toUpperCase()} page "${single.meta.title}" (id: ${single.meta.id}) has status "${single.meta.status}" (not Draft) and will not be overwritten.`,
    }
  }

  // Safe resume 1: empty shell (0 blocks) associated with this job
  if (
    existingBlocks.length === 0 &&
    (matchesSourceTargetId || matchesCheckpointTargetId || matchesGroupId) &&
    options.allowResumeEmptyShell !== false
  ) {
    return {
      action: 'resume_empty',
      targetPageId: single.meta.id,
      existingPage: single,
      checkpoint,
    }
  }

  // Safe resume 2: partially written Draft target page with a matching local checkpoint record
  if (
    existingBlocks.length > 0 &&
    checkpoint &&
    matchesCheckpointTargetId &&
    (matchesSourceTargetId || matchesGroupId) &&
    options.allowResumePartial !== false
  ) {
    return {
      action: 'resume_partial',
      targetPageId: single.meta.id,
      existingPage: single,
      existingTree: existingBlocks,
      checkpoint,
    }
  }

  return {
    action: 'duplicate_exists',
    existingPages: [single],
    primaryPage: single,
    existingTree: existingBlocks,
    reason: `Existing ${targetLocale.toUpperCase()} page already exists for Translation Group ID "${translationGroupId}": "${single.meta.title}" (id: ${single.meta.id}, slug: ${single.meta.slug}, status: ${single.meta.status}, blocks: ${existingBlocks.totalBlocks ?? existingBlocks.length}).`,
  }
}
