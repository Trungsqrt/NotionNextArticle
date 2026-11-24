/**
 * lib/study/repositories/card-state-repo.ts — Notion-backed FsrsCardStateRepository
 * ─────────────────────────────────────────────────────────────────────────────────
 * Implements optimistic concurrency checking via `revision` / `expectedRevision`.
 * Because Notion does not support SQL transactions or atomic compare-and-swap,
 * this repository performs a read-before-write revision check to detect stale
 * concurrent updates and pairs with append-only ReviewEvent logs so history
 * cannot be silently lost.
 */

import type { FsrsCardState } from '../types'
import { buildCardStateKey, fsrsCardStateSchema } from '../schemas'
import type { StudyNotionClient } from '../notion-client'
import {
  ConcurrencyConflictError,
  type FsrsCardStateRepository,
  type SaveCardStateOptions,
} from './interfaces'
import {
  CARD_STATE_PROPS,
  mapNotionPageToFsrsCardState,
  mapFsrsCardStateToNotionProperties,
} from './mappers'

const EXPECTED_CARD_STATE_PROPS = [
  CARD_STATE_PROPS.stateKey,
  CARD_STATE_PROPS.userId,
  CARD_STATE_PROPS.questionId,
  CARD_STATE_PROPS.due,
] as const

export function createNotionFsrsCardStateRepository(
  client: StudyNotionClient,
  databaseId: string
): FsrsCardStateRepository {
  async function findPageByStateKey(stateKey: string) {
    const pages = await client.queryDatabaseAll(databaseId, {
      filter: {
        property: CARD_STATE_PROPS.stateKey,
        title: { equals: stateKey },
      },
      pageSize: 2,
      maxPages: 1,
      expectedProperties: EXPECTED_CARD_STATE_PROPS,
    })
    return pages[0] || null
  }

  return {
    async findByUserAndQuestion(
      userId: string,
      questionId: string
    ): Promise<FsrsCardState | null> {
      const stateKey = buildCardStateKey(userId, questionId)
      const page = await findPageByStateKey(stateKey)
      return page ? mapNotionPageToFsrsCardState(page) : null
    },

    async listByUser(userId: string): Promise<FsrsCardState[]> {
      const pages = await client.queryDatabaseAll(databaseId, {
        filter: {
          property: CARD_STATE_PROPS.userId,
          rich_text: { equals: userId.trim() },
        },
        sorts: [{ property: CARD_STATE_PROPS.due, direction: 'ascending' }],
        expectedProperties: EXPECTED_CARD_STATE_PROPS,
      })
      return pages.map(mapNotionPageToFsrsCardState)
    },

    async listDueByUser(userId: string, asOfIso: string): Promise<FsrsCardState[]> {
      const pages = await client.queryDatabaseAll(databaseId, {
        filter: {
          and: [
            {
              property: CARD_STATE_PROPS.userId,
              rich_text: { equals: userId.trim() },
            },
            {
              property: CARD_STATE_PROPS.due,
              date: { on_or_before: asOfIso },
            },
          ],
        },
        sorts: [{ property: CARD_STATE_PROPS.due, direction: 'ascending' }],
        expectedProperties: EXPECTED_CARD_STATE_PROPS,
      })
      return pages.map(mapNotionPageToFsrsCardState)
    },

    async save(
      state: FsrsCardState,
      options: SaveCardStateOptions = {}
    ): Promise<FsrsCardState> {
      const valid = fsrsCardStateSchema.parse(state)
      const existingPage = await findPageByStateKey(valid.stateKey)

      if (existingPage) {
        const current = mapNotionPageToFsrsCardState(existingPage)
        if (
          typeof options.expectedRevision === 'number' &&
          current.revision !== options.expectedRevision
        ) {
          throw new ConcurrencyConflictError(
            valid.stateKey,
            options.expectedRevision,
            current.revision
          )
        }
        if (valid.revision <= current.revision) {
          throw new ConcurrencyConflictError(
            valid.stateKey,
            current.revision,
            valid.revision
          )
        }
        const incomingMs = Date.parse(valid.updatedAt)
        const currentMs = Date.parse(current.updatedAt)
        if (!Number.isNaN(incomingMs) && !Number.isNaN(currentMs) && incomingMs < currentMs) {
          throw new ConcurrencyConflictError(
            valid.stateKey,
            current.revision,
            valid.revision
          )
        }

        const properties = mapFsrsCardStateToNotionProperties(valid)
        const updated = await client.updatePage(existingPage.id, properties)
        return mapNotionPageToFsrsCardState(updated)
      }

      if (typeof options.expectedRevision === 'number' && options.expectedRevision > 0) {
        throw new ConcurrencyConflictError(valid.stateKey, options.expectedRevision, 0)
      }

      const properties = mapFsrsCardStateToNotionProperties(valid)
      const created = await client.createPage(databaseId, properties, {
        expectedProperties: EXPECTED_CARD_STATE_PROPS,
      })
      return mapNotionPageToFsrsCardState(created)
    },
  }
}
