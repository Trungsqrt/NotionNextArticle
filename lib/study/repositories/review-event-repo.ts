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

const EXPECTED_REVIEW_EVENT_PROPS = [
  REVIEW_EVENT_PROPS.eventId,
  REVIEW_EVENT_PROPS.userId,
  REVIEW_EVENT_PROPS.questionId,
  REVIEW_EVENT_PROPS.reviewedAt,
] as const

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
      expectedProperties: EXPECTED_REVIEW_EVENT_PROPS,
    })
    return pages[0] || null
  }

  return {
    async findByEventId(eventId: string): Promise<ReviewEvent | null> {
      const page = await findPageByEventId(eventId)
      return page ? mapNotionPageToReviewEvent(page) : null
    },

    async findLatestByUserAndQuestion(
      userId: string,
      questionId: string
    ): Promise<ReviewEvent | null> {
      const pages = await client.queryDatabaseAll(databaseId, {
        filter: {
          and: [
            {
              property: REVIEW_EVENT_PROPS.userId,
              rich_text: { equals: userId.trim() },
            },
            {
              property: REVIEW_EVENT_PROPS.questionId,
              rich_text: { equals: questionId.trim() },
            },
          ],
        },
        sorts: [{ property: REVIEW_EVENT_PROPS.reviewedAt, direction: 'descending' }],
        pageSize: 1,
        maxPages: 1,
        expectedProperties: EXPECTED_REVIEW_EVENT_PROPS,
      })
      return pages[0] ? mapNotionPageToReviewEvent(pages[0]) : null
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
        expectedProperties: EXPECTED_REVIEW_EVENT_PROPS,
      })

      const mapped = pages.map(mapNotionPageToReviewEvent)
      return limit ? mapped.slice(0, limit) : mapped
    },

    async appendIfNotExists(
      event: ReviewEvent,
      options?: { skipExistenceCheck?: boolean }
    ): Promise<AppendReviewEventResult> {
      const valid = reviewEventSchema.parse(event)
      if (!options?.skipExistenceCheck) {
        const existing = await findPageByEventId(valid.eventId)
        if (existing) {
          return {
            event: mapNotionPageToReviewEvent(existing),
            created: false,
          }
        }
      }

      const properties = mapReviewEventToNotionProperties(valid)
      const createdPage = await client.createPage(databaseId, properties, {
        expectedProperties: EXPECTED_REVIEW_EVENT_PROPS,
      })
      return {
        event: mapNotionPageToReviewEvent(createdPage),
        created: true,
      }
    },
  }
}
