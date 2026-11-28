import type { BlockObjectRequest, Client } from '@notionhq/client'
import { withNotionRetry } from '../notion-client'
import { listAllRawBlockChildren } from '../reader'
import type { NotionBlockNode, NotionRawBlock, WorkerLogger } from '../types'
import { defaultLogger } from '../../../worker/logger'
import { buildSingleBlockRequest } from './block-converter'
import { computeBlockFingerprint } from './fingerprint'
import {
  reconcileExistingBatchBeforeAppend,
  reconcileUncertainAppendError,
} from './reconciliation'
import type {
  BlockWriteContext,
  ColumnFollowUp,
  PreparedBlockDescriptor,
} from './types'

export const MAX_APPEND_BATCH_BYTES = 400 * 1024 // 400 KB safety ceiling per append request

/**
 * Partitions prepared block requests into Notion-safe batches obeying both
 * the Notion 100-block limit and the 400 KB serialized JSON payload ceiling.
 */
export function chunkPreparedBlocks(
  preparedList: readonly PreparedBlockDescriptor[],
  maxBlocksPerAppend = 100,
  maxBytes: number = MAX_APPEND_BATCH_BYTES
): PreparedBlockDescriptor[][] {
  const limit = Math.min(100, Math.max(1, maxBlocksPerAppend))
  const batches: PreparedBlockDescriptor[][] = []
  let current: PreparedBlockDescriptor[] = []
  let currentBytes = 0

  for (const item of preparedList) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item.request), 'utf8')
    if (
      current.length > 0 &&
      (current.length >= limit || currentBytes + itemBytes > maxBytes)
    ) {
      batches.push(current)
      current = []
      currentBytes = 0
    }
    current.push(item)
    currentBytes += itemBytes
  }

  if (current.length > 0) {
    batches.push(current)
  }

  return batches
}

/**
 * Interleaves normal block segments and `child_page` creations at `depth === 0` so
 * child pages created via `pages.create(parent: { page_id })` land at their exact
 * original position inside the parent page.
 */
async function appendRootSegmentsWithChildPages(
  client: Client,
  parentBlockId: string,
  nodes: readonly NotionBlockNode[],
  context: BlockWriteContext,
  logger: WorkerLogger
): Promise<void> {
  const checkpoint = context.checkpoint || null
  const parentKey = context.parentKey || 'root'
  let runningExpectedIndex = Number(context.initialExistingChildCount) || 0
  let segmentIndex = 0
  let currentSegment: NotionBlockNode[] = []

  const flushSegment = async (segNodes: NotionBlockNode[], segIdx: number) => {
    if (segNodes.length === 0) return
    await appendTranslatedBlockTree(client, parentBlockId, segNodes, {
      ...context,
      onWriteChildPage: undefined,
      parentKey: `${parentKey}:seg:${segIdx}`,
      initialExistingChildCount: runningExpectedIndex,
    })
    runningExpectedIndex += segNodes.length
  }

  for (const node of nodes) {
    const nodeType = String(node?.type || node?.raw?.type || '')
    if (nodeType !== 'child_page') {
      currentSegment.push(node)
      continue
    }

    await flushSegment(currentSegment, segmentIndex)
    currentSegment = []
    segmentIndex += 1

    const sourceChildPageId = String(node.id || node.raw?.id || '')
    let existingTargetBlock: NotionRawBlock | null = null
    if (
      (context.isResuming ||
        checkpoint?.getChildTargetPageId?.(sourceChildPageId)) &&
      typeof client?.blocks?.children?.list === 'function'
    ) {
      try {
        const currentTargetBlocks = await listAllRawBlockChildren(
          client,
          parentBlockId,
          {
            ...(context.options || {}),
            logger,
            retryOptions: context.retryOptions,
          }
        )
        const blockAtPos = currentTargetBlocks[runningExpectedIndex]
        if (blockAtPos && blockAtPos.type === 'child_page') {
          existingTargetBlock = blockAtPos
        }
      } catch {
        existingTargetBlock = null
      }
    }

    const childResult = await context.onWriteChildPage!({
      sourceChildPageNode: node,
      sourceChildPageId,
      targetParentPageId: parentBlockId,
      expectedStartIndex: runningExpectedIndex,
      existingTargetBlock,
    })

    if (childResult?.targetChildPageId) {
      checkpoint?.recordChildTargetPageId?.(
        sourceChildPageId,
        childResult.targetChildPageId
      )
      context.linkedResources.push({
        id: sourceChildPageId,
        type: 'child_page',
        position: node.position || String(runningExpectedIndex),
        title: childResult.title || node.text || '',
        originalReferencedId: sourceChildPageId,
        resolvedTargetId: childResult.targetChildPageId,
        usedLocalizedCounterpart: true,
        note: `Created translated Vietnamese child page (${childResult.targetChildPageId})`,
      })
      context.stats.totalWrittenTopOrBatchBlocks += 1
      runningExpectedIndex += 1
    }
  }

  await flushSegment(currentSegment, segmentIndex)
}

async function appendColumnFollowUps(
  client: Client,
  createdColumnListId: string,
  columnFollowUps: readonly ColumnFollowUp[],
  parentKey: string,
  itemSourceKey: string,
  context: BlockWriteContext,
  logger: WorkerLogger
): Promise<void> {
  const createdColumns = await listAllRawBlockChildren(
    client,
    createdColumnListId,
    {
      ...(context.options || {}),
      logger,
      retryOptions: context.retryOptions,
    }
  )

  for (const followUp of columnFollowUps) {
    const targetCol = createdColumns[followUp.columnIndex]
    if (!targetCol?.id) continue
    if (followUp.firstChildDeferredChildren?.length > 0) {
      const colKids = await listAllRawBlockChildren(client, targetCol.id, {
        ...(context.options || {}),
        logger,
        retryOptions: context.retryOptions,
      })
      const firstKid = colKids[0]
      if (firstKid?.id) {
        await appendTranslatedBlockTree(
          client,
          firstKid.id,
          followUp.firstChildDeferredChildren,
          {
            ...context,
            depth: (context.depth || 0) + 3,
            parentKey: `${parentKey}:node:${itemSourceKey}:col:${followUp.columnIndex}:firstKid:${followUp.firstChildSourceId || 0}`,
            initialExistingChildCount: followUp.firstChildInlineCount || 0,
          }
        )
      }
    }
    if (followUp.remainingColumnChildren?.length > 0) {
      await appendTranslatedBlockTree(
        client,
        targetCol.id,
        followUp.remainingColumnChildren,
        {
          ...context,
          depth: (context.depth || 0) + 2,
          parentKey: `${parentKey}:node:${itemSourceKey}:col:${followUp.columnIndex}`,
          initialExistingChildCount: followUp.initialColumnChildCount || 0,
        }
      )
    }
  }
}

/**
 * Appends a tree of translated blocks recursively to `parentBlockId` in safe batches.
 * Supports durable checkpointing, partial-job resume, and deterministic reconciliation
 * of uncertain `blocks.children.append` operations.
 */
export async function appendTranslatedBlockTree(
  client: Client,
  parentBlockId: string,
  nodes: readonly NotionBlockNode[],
  context: BlockWriteContext
): Promise<void> {
  const logger = context.logger || defaultLogger
  const maxBlocksPerAppend = context.maxBlocksPerAppend || 100
  const checkpoint = context.checkpoint || null
  const parentKey = context.parentKey || 'root'

  // If onWriteChildPage is provided at depth === 0 and there are child_page nodes,
  // write segments in exact positional order so child_page blocks created via
  // pages.create(parent: { page_id }) appear at their exact position.
  if (
    (context.depth || 0) === 0 &&
    typeof context.onWriteChildPage === 'function' &&
    Array.isArray(nodes) &&
    nodes.some((n) => (n?.type || n?.raw?.type) === 'child_page')
  ) {
    await appendRootSegmentsWithChildPages(
      client,
      parentBlockId,
      nodes,
      context,
      logger
    )
    return
  }

  const preparedItems: PreparedBlockDescriptor[] = []

  for (const node of nodes || []) {
    const built = await buildSingleBlockRequest(node, context)
    if (built.request) {
      preparedItems.push({
        sourceNode: node,
        ...built,
        request: built.request,
      })
    }
  }

  if (preparedItems.length === 0) {
    return
  }

  const batches = chunkPreparedBlocks(preparedItems, maxBlocksPerAppend)
  const initialExistingChildCount =
    Number(context.initialExistingChildCount) || 0
  let expectedStartIndex = initialExistingChildCount
  let cachedExistingChildren: NotionRawBlock[] | null = null

  async function getExistingParentChildren(
    forceRefresh = false
  ): Promise<NotionRawBlock[]> {
    if (!forceRefresh && Array.isArray(cachedExistingChildren)) {
      return cachedExistingChildren
    }
    cachedExistingChildren = await listAllRawBlockChildren(
      client,
      parentBlockId,
      {
        ...(context.options || {}),
        logger,
        retryOptions: context.retryOptions,
      }
    )
    return cachedExistingChildren
  }

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx]!
    const batchKey = `${parentKey}:batch:${batchIdx}`
    const childrenPayload = batch.map(
      (item) => item.request as unknown as BlockObjectRequest
    )
    const sourceBlockIds = batch.map(
      (item, idx) =>
        item.sourceNode?.id ||
        item.sourceNode?.position ||
        `${batchKey}:${idx}`
    )
    const batchFingerprints = childrenPayload.map((req) =>
      computeBlockFingerprint(req)
    )

    const recordedBatch = checkpoint?.getCompletedBatch?.(batchKey) || null
    const pendingOp = checkpoint?.getPendingOperation?.() || null
    const isPendingThisBatch =
      pendingOp?.type === 'append_blocks' && pendingOp.batchKey === batchKey
    const shouldInspectExisting =
      Boolean(context.isResuming) ||
      Boolean(recordedBatch) ||
      Boolean(isPendingThisBatch) ||
      Array.isArray(cachedExistingChildren)

    let returnedBlocks: Array<{ id?: string }> | null = null
    let alreadyWritten = false

    if (
      shouldInspectExisting &&
      typeof client?.blocks?.children?.list === 'function'
    ) {
      const existingChildren = await getExistingParentChildren(false)
      const preCheck = reconcileExistingBatchBeforeAppend({
        existingChildren,
        parentBlockId,
        parentKey,
        batchKey,
        batchLength: batch.length,
        isFinalBatch: batchIdx === batches.length - 1,
        expectedStartIndex,
        batchFingerprints,
        recordedBatch,
        isPendingThisBatch,
        logger,
      })

      if (preCheck.alreadyWritten && preCheck.returnedBlocks) {
        returnedBlocks = preCheck.returnedBlocks
        alreadyWritten = true
        if (preCheck.shouldRecordCompletedBatch) {
          checkpoint?.recordCompletedBatch?.({
            batchKey,
            parentBlockId,
            batchIndex: batchIdx,
            expectedStartIndex,
            sourceBlockIds,
            targetBlockIds: returnedBlocks.map(
              (b, idx) => b.id || `${parentBlockId}-child-${batchIdx}-${idx}`
            ),
            blockFingerprints: batchFingerprints,
          })
        }
      }
    } else if (recordedBatch?.targetBlockIds?.length === batch.length) {
      returnedBlocks = recordedBatch.targetBlockIds.map((id) => ({ id }))
      alreadyWritten = true
    }

    if (!alreadyWritten) {
      // Checkpoint invariant: always record pending append BEFORE invoking Notion API
      checkpoint?.recordPendingOperation?.({
        type: 'append_blocks',
        batchKey,
        parentBlockId,
        batchIndex: batchIdx,
        expectedStartIndex,
        sourceBlockIds,
        blockFingerprints: batchFingerprints,
        startedAt: new Date().toISOString(),
      })

      try {
        const appendRes = await withNotionRetry(
          () =>
            client.blocks.children.append({
              block_id: parentBlockId,
              children: childrenPayload,
            }),
          {
            isIdempotent: false,
            label: `blocks.children.append(${parentBlockId} batch ${batchIdx + 1}/${batches.length})`,
            logger,
            ...context.retryOptions,
          }
        )
        returnedBlocks = appendRes?.results || []
        const currentCache = cachedExistingChildren as NotionRawBlock[] | null
        if (Array.isArray(currentCache)) {
          currentCache.push(...(returnedBlocks as NotionRawBlock[]))
        }
      } catch (appendErr) {
        const errMessage =
          appendErr instanceof Error ? appendErr.message : String(appendErr)

        if (typeof client?.blocks?.children?.list === 'function') {
          let latestChildren: NotionRawBlock[] | null = null
          try {
            latestChildren = await getExistingParentChildren(true)
          } catch {
            latestChildren = null
          }

          returnedBlocks = reconcileUncertainAppendError({
            latestChildren,
            parentBlockId,
            batchKey,
            batchLength: batch.length,
            expectedStartIndex,
            batchFingerprints,
            errMessage,
            logger,
          })
        }

        if (!returnedBlocks) {
          throw appendErr
        }
      }

      // Checkpoint invariant: record completed batch immediately once write/recovery is confirmed
      checkpoint?.recordCompletedBatch?.({
        batchKey,
        parentBlockId,
        batchIndex: batchIdx,
        expectedStartIndex,
        sourceBlockIds,
        targetBlockIds: (returnedBlocks || []).map(
          (b, idx) => b?.id || `${parentBlockId}-child-${batchIdx}-${idx}`
        ),
        blockFingerprints: batchFingerprints,
      })
    }

    expectedStartIndex += batch.length
    context.stats.totalWrittenTopOrBatchBlocks += childrenPayload.length

    for (let i = 0; i < batch.length; i++) {
      const item = batch[i]!
      const createdBlock = returnedBlocks?.[i]
      const createdBlockId =
        createdBlock?.id ||
        recordedBatch?.targetBlockIds?.[i] ||
        `${parentBlockId}-child-${batchIdx}-${i}`

      if (item.inlineCreatedCount) {
        context.stats.totalRecreatedNestedBlocks += item.inlineCreatedCount
      }

      if (context.depth > 0) {
        context.stats.totalRecreatedNestedBlocks += 1
      }

      const itemSourceKey =
        item.sourceNode?.id ||
        item.sourceNode?.position ||
        `${batchIdx}-${i}`

      if (item.deferredChildren && item.deferredChildren.length > 0) {
        await appendTranslatedBlockTree(
          client,
          createdBlockId,
          item.deferredChildren,
          {
            ...context,
            depth: (context.depth || 0) + 1,
            parentKey: `${parentKey}:node:${itemSourceKey}`,
            initialExistingChildCount: item.inlineCreatedCount || 0,
          }
        )
      }

      if (
        item.columnFollowUps &&
        item.columnFollowUps.length > 0 &&
        createdBlock?.id
      ) {
        await appendColumnFollowUps(
          client,
          createdBlock.id,
          item.columnFollowUps,
          parentKey,
          itemSourceKey,
          context,
          logger
        )
      }
    }
  }
}
