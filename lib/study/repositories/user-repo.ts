/**
 * lib/study/repositories/user-repo.ts — Notion-backed StudyUserRepository
 */

import type { StudyUser } from '../types'
import { normalizeUsername, studyUserSchema } from '../schemas'
import type { StudyNotionClient } from '../notion-client'
import type { StudyUserRepository } from './interfaces'
import {
  USER_PROPS,
  mapNotionPageToStudyUser,
  mapStudyUserToNotionProperties,
} from './mappers'

const EXPECTED_USER_PROPS = [
  USER_PROPS.userId,
  USER_PROPS.username,
  USER_PROPS.accessKeyHash,
  USER_PROPS.status,
  USER_PROPS.credentialVersion,
] as const

export function createNotionStudyUserRepository(
  client: StudyNotionClient,
  databaseId: string
): StudyUserRepository {
  async function findPageByUserId(userId: string) {
    const pages = await client.queryDatabaseAll(databaseId, {
      filter: {
        property: USER_PROPS.userId,
        title: { equals: userId.trim() },
      },
      pageSize: 2,
      maxPages: 1,
      expectedProperties: EXPECTED_USER_PROPS,
    })
    return pages[0] || null
  }

  return {
    async findByUsername(rawUsername: string): Promise<StudyUser | null> {
      let username: string
      try {
        username = normalizeUsername(rawUsername)
      } catch {
        return null
      }

      const pages = await client.queryDatabaseAll(databaseId, {
        filter: {
          property: USER_PROPS.username,
          rich_text: { equals: username },
        },
        pageSize: 2,
        maxPages: 1,
        expectedProperties: EXPECTED_USER_PROPS,
      })

      if (pages.length === 0) return null
      return mapNotionPageToStudyUser(pages[0])
    },

    async findByUserId(userId: string): Promise<StudyUser | null> {
      const page = await findPageByUserId(userId)
      return page ? mapNotionPageToStudyUser(page) : null
    },

    async upsert(user: StudyUser): Promise<StudyUser> {
      const valid = studyUserSchema.parse(user)
      const properties = mapStudyUserToNotionProperties(valid)
      const existing = await findPageByUserId(valid.userId)

      const saved = existing
        ? await client.updatePage(existing.id, properties)
        : await client.createPage(databaseId, properties, {
            expectedProperties: EXPECTED_USER_PROPS,
          })

      return mapNotionPageToStudyUser(saved)
    },
  }
}
