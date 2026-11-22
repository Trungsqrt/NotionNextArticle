/**
 * lib/study/repositories/review-event-repo.ts — Append-only Notion ReviewEventRepository
 * ──────────────────────────────────────────────────────────────────────────────────────
 * Review events are immutable, append-only records keyed by `eventId`.
 * Calling `appendIfNotExists` with a duplicate `eventId` returns the existing
 * record without creating a duplicate row, providing idempotency across retries.
 */

import type { ReviewEvent } from '../types'
import { reviewEventSchema } from '../schemas'
import type { StudyNotionClient } from '../notion-client'
import type {
  ReviewEventRepository,
  AppendReviewEventResult,
} from './interfaces'
import {
  REVIEW_EVENT_PROPS,
  mapNotionPageToReviewEvent,
  mapReviewEventToNotionProperties,
} from './mappers'

export function createNotionReviewEventRepository(
  client: StudyNotionClient,
  databaseId: string
): ReviewEventRepository {
  async function findPageByEventId(eventId: string) {
    const pages = await client.queryDatabaseAll(databaseId, {
      filter: {
        property: REVIEW_EVENT_PROPS.eventId,
        title: { equals: eventId.trim() },
      },
      pageSize: 2,
      maxPages: 1,
    })
    return pages[0] || null
  }

  return {
    async findByEventId(eventId: string): Promise<ReviewEvent | null> {
      const page = await findPageByEventId(eventId)
      return page ? mapNotionPageToReviewEvent(page) : null
    },

    async listByUser(
      userId: string,
      options?: { limit?: number }
    ): Promise<ReviewEvent[]> {
      const limit = options?.limit && options.limit > 0 ? options.limit : undefined
      const pages = await client.queryDatabaseAll(databaseId, {
        filter: {
          property: REVIEW_EVENT_PROPS.userId,
          rich_text: { equals: userId.trim() },
        },
        sorts: [{ property: REVIEW_EVENT_PROPS.reviewedAt, direction: 'descending' }],
        ...(limit ? { pageSize: Math.min(limit, 100), maxPages: Math.ceil(limit / 100) } : {}),
      })

      const mapped = pages.map(mapNotionPageToReviewEvent)
      return limit ? mapped.slice(0, limit) : mapped
    },

    async appendIfNotExists(event: ReviewEvent): Promise<AppendReviewEventResult> {
      const valid = reviewEventSchema.parse(event)
      const existing = await findPageByEventId(valid.eventId)
      if (existing) {
        return {
          event: mapNotionPageToReviewEvent(existing),
          created: false,
        }
      }

      const properties = mapReviewEventToNotionProperties(valid)
      const createdPage = await client.createPage(databaseId, properties)
      return {
        event: mapNotionPageToReviewEvent(createdPage),
        created: true,
      }
    },
  }
}
