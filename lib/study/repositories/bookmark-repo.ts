/**
 * lib/study/repositories/bookmark-repo.ts — Notion-backed StudyBookmarkRepository
 * ────────────────────────────────────────────────────────────────────────────────
 * Stores one record per authenticated `(userId, examId)` pair keyed by
 * `Bookmark Key = "${userId}::${examId}"`. Only question IDs are persisted
 * (never question content or answer keys).
 */

import type { StudyBookmarkRecord } from '../types'
import { buildBookmarkKey, studyBookmarkRecordSchema } from '../schemas'
import type { StudyNotionClient } from '../notion-client'
import type { StudyBookmarkRepository } from './interfaces'
import {
  BOOKMARK_PROPS,
  mapNotionPageToStudyBookmarkRecord,
  mapStudyBookmarkRecordToNotionProperties,
} from './mappers'

const EXPECTED_BOOKMARK_PROPS = [
  BOOKMARK_PROPS.bookmarkKey,
  BOOKMARK_PROPS.userId,
  BOOKMARK_PROPS.examId,
  BOOKMARK_PROPS.bookmarkedQuestionsJson,
  BOOKMARK_PROPS.updatedAt,
] as const

export function createNotionStudyBookmarkRepository(
  client: StudyNotionClient,
  databaseId: string
): StudyBookmarkRepository {
  // Remembers resolved Notion page IDs within this repository instance to avoid
  // an extra query when findByUserAndExam() is immediately followed by save().
  const knownPageIds = new Map<string, string>()

  async function findPageByBookmarkKey(bookmarkKey: string) {
    const pages = await client.queryDatabaseAll(databaseId, {
      filter: {
        property: BOOKMARK_PROPS.bookmarkKey,
        title: { equals: bookmarkKey },
      },
      pageSize: 2,
      maxPages: 1,
      expectedProperties: EXPECTED_BOOKMARK_PROPS,
    })
    const page = pages[0] || null
    if (page) {
      knownPageIds.set(bookmarkKey, page.id)
    }
    return page
  }

  return {
    async findByUserAndExam(
      userId: string,
      examId: string
    ): Promise<StudyBookmarkRecord | null> {
      const key = buildBookmarkKey(userId, examId)
      const page = await findPageByBookmarkKey(key)
      return page ? mapNotionPageToStudyBookmarkRecord(page) : null
    },

    async listByUser(userId: string): Promise<StudyBookmarkRecord[]> {
      const pages = await client.queryDatabaseAll(databaseId, {
        filter: {
          property: BOOKMARK_PROPS.userId,
          rich_text: { equals: userId.trim() },
        },
        expectedProperties: EXPECTED_BOOKMARK_PROPS,
      })
      return pages.map((page) => {
        const record = mapNotionPageToStudyBookmarkRecord(page)
        knownPageIds.set(record.bookmarkKey, page.id)
        return record
      })
    },

    async save(record: StudyBookmarkRecord): Promise<StudyBookmarkRecord> {
      const valid = studyBookmarkRecordSchema.parse(record)
      const properties = mapStudyBookmarkRecordToNotionProperties(valid)
      const existingPageId =
        knownPageIds.get(valid.bookmarkKey) ??
        (await findPageByBookmarkKey(valid.bookmarkKey))?.id ??
        null

      const saved = existingPageId
        ? await client.updatePage(existingPageId, properties)
        : await client.createPage(databaseId, properties, {
            expectedProperties: EXPECTED_BOOKMARK_PROPS,
          })

      knownPageIds.set(valid.bookmarkKey, saved.id)
      return mapNotionPageToStudyBookmarkRecord(saved)
    },
  }
}
