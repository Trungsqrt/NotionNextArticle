/**
 * lib/study/repositories/question-repo.ts — Notion-backed QuestionBankRepository
 */

import type { StudyQuestion, QuestionStatus } from '../types'
import { studyQuestionSchema } from '../schemas'
import type { StudyNotionClient } from '../notion-client'
import type { QuestionBankRepository } from './interfaces'
import {
  QUESTION_PROPS,
  mapNotionPageToStudyQuestion,
  mapStudyQuestionToNotionProperties,
} from './mappers'
import {
  getCachedPublishedQuestion,
  setCachedPublishedQuestion,
  getCachedPublishedQuestionsByExam,
  setCachedPublishedQuestionsByExam,
  invalidateCachedQuestion,
} from '../cache/content-cache'

// Notion compound `or` filters support at most 100 conditions; chunk safely at 50
const QUESTION_ID_QUERY_CHUNK_SIZE = 50

export function createNotionQuestionBankRepository(
  client: StudyNotionClient,
  databaseId: string,
  repoOptions?: { useContentCache?: boolean }
): QuestionBankRepository {
  const useCache = Boolean(repoOptions?.useContentCache)

  async function findPageByQuestionId(questionId: string) {
    const pages = await client.queryDatabaseAll(databaseId, {
      filter: {
        property: QUESTION_PROPS.questionId,
        title: { equals: questionId.trim() },
      },
      pageSize: 2,
      maxPages: 1,
    })
    return pages[0] || null
  }

  return {
    async findByQuestionId(questionId: string): Promise<StudyQuestion | null> {
      const cleanId = questionId.trim()
      if (useCache) {
        const cached = getCachedPublishedQuestion(cleanId)
        if (cached) return cached
      }

      const page = await findPageByQuestionId(cleanId)
      if (!page) return null
      const mapped = mapNotionPageToStudyQuestion(page)
      if (useCache && mapped.status === 'published') {
        setCachedPublishedQuestion(mapped)
      }
      return mapped
    },

    async listByExamId(
      examId: string,
      options?: { status?: QuestionStatus }
    ): Promise<StudyQuestion[]> {
      const cleanExamId = examId.trim()
      if (useCache && options?.status === 'published') {
        const cached = getCachedPublishedQuestionsByExam(cleanExamId)
        if (cached) return cached
      }

      const filters: Array<Record<string, unknown>> = [
        {
          property: QUESTION_PROPS.examId,
          rich_text: { equals: cleanExamId },
        },
      ]

      if (options?.status) {
        filters.push({
          property: QUESTION_PROPS.status,
          select: { equals: options.status },
        })
      }

      const filter = filters.length === 1 ? filters[0] : { and: filters }
      const pages = await client.queryDatabaseAll(databaseId, {
        filter,
        sorts: [{ property: QUESTION_PROPS.questionId, direction: 'ascending' }],
      })

      const mapped = pages.map(mapNotionPageToStudyQuestion)
      if (useCache && options?.status === 'published') {
        setCachedPublishedQuestionsByExam(cleanExamId, mapped)
      }
      return mapped
    },

    async listByQuestionIds(questionIds: string[]): Promise<StudyQuestion[]> {
      const uniqueIds = [...new Set(questionIds.map((id) => id.trim()).filter(Boolean))]
      if (uniqueIds.length === 0) return []

      const results: StudyQuestion[] = []
      const missingIds: string[] = []

      if (useCache) {
        for (const id of uniqueIds) {
          const cached = getCachedPublishedQuestion(id)
          if (cached) results.push(cached)
          else missingIds.push(id)
        }
      } else {
        missingIds.push(...uniqueIds)
      }

      for (let i = 0; i < missingIds.length; i += QUESTION_ID_QUERY_CHUNK_SIZE) {
        const slice = missingIds.slice(i, i + QUESTION_ID_QUERY_CHUNK_SIZE)
        const filter =
          slice.length === 1
            ? { property: QUESTION_PROPS.questionId, title: { equals: slice[0] } }
            : {
                or: slice.map((id) => ({
                  property: QUESTION_PROPS.questionId,
                  title: { equals: id },
                })),
              }

        const pages = await client.queryDatabaseAll(databaseId, { filter })
        for (const page of pages) {
          const mapped = mapNotionPageToStudyQuestion(page)
          if (useCache && mapped.status === 'published') {
            setCachedPublishedQuestion(mapped)
          }
          results.push(mapped)
        }
      }

      return results
    },

    async upsert(question: StudyQuestion): Promise<StudyQuestion> {
      const valid = studyQuestionSchema.parse(question)
      const properties = mapStudyQuestionToNotionProperties(valid)
      const existing = await findPageByQuestionId(valid.questionId)

      const saved = existing
        ? await client.updatePage(existing.id, properties)
        : await client.createPage(databaseId, properties)

      const mapped = mapNotionPageToStudyQuestion(saved)
      if (useCache) {
        invalidateCachedQuestion(mapped.questionId, mapped.examId)
        if (mapped.status === 'published') {
          setCachedPublishedQuestion(mapped)
        }
      }
      return mapped
    },
  }
}
