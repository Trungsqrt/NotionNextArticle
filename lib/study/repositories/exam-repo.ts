/**
 * lib/study/repositories/exam-repo.ts — Notion-backed ExamCollectionRepository
 */

import type { ExamCollection, ExamCollectionStatus } from '../types'
import { examCollectionSchema } from '../schemas'
import type { StudyNotionClient } from '../notion-client'
import type { ExamCollectionRepository } from './interfaces'
import {
  EXAM_PROPS,
  mapNotionPageToExamCollection,
  mapExamCollectionToNotionProperties,
} from './mappers'

export function createNotionExamCollectionRepository(
  client: StudyNotionClient,
  databaseId: string
): ExamCollectionRepository {
  async function findPageByExamId(examId: string) {
    const pages = await client.queryDatabaseAll(databaseId, {
      filter: {
        property: EXAM_PROPS.examId,
        title: { equals: examId.trim() },
      },
      pageSize: 2,
      maxPages: 1,
    })
    return pages[0] || null
  }

  return {
    async findByExamId(examId: string): Promise<ExamCollection | null> {
      const page = await findPageByExamId(examId)
      return page ? mapNotionPageToExamCollection(page) : null
    },

    async list(options?: { status?: ExamCollectionStatus }): Promise<ExamCollection[]> {
      const filter = options?.status
        ? {
            property: EXAM_PROPS.status,
            select: { equals: options.status },
          }
        : undefined

      const pages = await client.queryDatabaseAll(databaseId, {
        filter,
        sorts: [{ property: EXAM_PROPS.examId, direction: 'ascending' }],
      })

      return pages.map(mapNotionPageToExamCollection)
    },

    async upsert(exam: ExamCollection): Promise<ExamCollection> {
      const valid = examCollectionSchema.parse(exam)
      const properties = mapExamCollectionToNotionProperties(valid)
      const existing = await findPageByExamId(valid.examId)

      const saved = existing
        ? await client.updatePage(existing.id, properties)
        : await client.createPage(databaseId, properties)

      return mapNotionPageToExamCollection(saved)
    },
  }
}
