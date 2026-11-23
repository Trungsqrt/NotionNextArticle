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
import {
  getCachedPublishedExam,
  setCachedPublishedExam,
  getCachedPublishedExamsList,
  setCachedPublishedExamsList,
  invalidateCachedExam,
} from '../cache/content-cache'

export function createNotionExamCollectionRepository(
  client: StudyNotionClient,
  databaseId: string,
  repoOptions?: { useContentCache?: boolean }
): ExamCollectionRepository {
  const useCache = Boolean(repoOptions?.useContentCache)

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
      const cleanId = examId.trim()
      if (useCache) {
        const cached = getCachedPublishedExam(cleanId)
        if (cached) return cached
      }
      const page = await findPageByExamId(cleanId)
      if (!page) return null
      const mapped = mapNotionPageToExamCollection(page)
      if (useCache && mapped.status === 'published') {
        setCachedPublishedExam(mapped)
      }
      return mapped
    },

    async list(options?: { status?: ExamCollectionStatus }): Promise<ExamCollection[]> {
      if (useCache && options?.status === 'published') {
        const cached = getCachedPublishedExamsList()
        if (cached) return cached
      }

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

      const mapped = pages.map(mapNotionPageToExamCollection)
      if (useCache && options?.status === 'published') {
        setCachedPublishedExamsList(mapped)
      }
      return mapped
    },

    async upsert(exam: ExamCollection): Promise<ExamCollection> {
      const valid = examCollectionSchema.parse(exam)
      const properties = mapExamCollectionToNotionProperties(valid)
      const existing = await findPageByExamId(valid.examId)

      const saved = existing
        ? await client.updatePage(existing.id, properties)
        : await client.createPage(databaseId, properties)

      const mapped = mapNotionPageToExamCollection(saved)
      if (useCache) {
        invalidateCachedExam(mapped.examId)
        if (mapped.status === 'published') {
          setCachedPublishedExam(mapped)
        }
      }
      return mapped
    },
  }
}
