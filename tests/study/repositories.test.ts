import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type {
  StudyNotionClient,
  NotionPageRecord,
  QueryDatabaseOptions,
} from '../../lib/study/notion-client'
import {
  createNotionStudyRepositories,
  ConcurrencyConflictError,
  fromChunkedRichText,
} from '../../lib/study/repositories'
import {
  clearStudyContentCache,
  getCachedPublishedQuestion,
  setCachedPublishedQuestion,
} from '../../lib/study/cache/content-cache'
import type { StudyNotionConfig } from '../../lib/study/config'
import {
  SYNTHETIC_USER,
  SYNTHETIC_EXAM,
  SYNTHETIC_SINGLE_CHOICE_QUESTION,
  SYNTHETIC_MULTI_SELECT_QUESTION,
  SYNTHETIC_CARD_STATE,
  SYNTHETIC_REVIEW_EVENT,
} from './fixtures/synthetic-study-data'

function matchesFilter(
  page: NotionPageRecord,
  filter?: Record<string, unknown>
): boolean {
  if (!filter) return true
  if (Array.isArray(filter.and)) {
    return filter.and.every((sub) =>
      matchesFilter(page, sub as Record<string, unknown>)
    )
  }
  if (Array.isArray(filter.or)) {
    return filter.or.some((sub) =>
      matchesFilter(page, sub as Record<string, unknown>)
    )
  }

  const propName = filter.property as string | undefined
  if (!propName) return true
  const prop = page.properties[propName] as Record<string, unknown> | undefined

  if (filter.title && typeof filter.title === 'object') {
    const eq = (filter.title as { equals?: string }).equals
    return fromChunkedRichText(prop) === eq
  }
  if (filter.rich_text && typeof filter.rich_text === 'object') {
    const eq = (filter.rich_text as { equals?: string }).equals
    return fromChunkedRichText(prop) === eq
  }
  if (filter.select && typeof filter.select === 'object') {
    const eq = (filter.select as { equals?: string }).equals
    const actual = (prop?.select as { name?: string } | undefined)?.name || ''
    return actual === eq
  }
  if (filter.date && typeof filter.date === 'object') {
    const onOrBefore = (filter.date as { on_or_before?: string }).on_or_before
    const actual = (prop?.date as { start?: string } | undefined)?.start || ''
    if (!actual || !onOrBefore) return false
    return Date.parse(actual) <= Date.parse(onOrBefore)
  }
  return true
}

function createInMemoryStudyNotionClient(): StudyNotionClient & {
  getCount(dbId: string): number
} {
  const dbTables = new Map<string, NotionPageRecord[]>()
  let seq = 1

  return {
    getCount(dbId: string) {
      return (dbTables.get(dbId) || []).length
    },
    async queryDatabaseAll(
      databaseId: string,
      options: QueryDatabaseOptions = {}
    ): Promise<NotionPageRecord[]> {
      const rows = dbTables.get(databaseId) || []
      return rows.filter((row) => matchesFilter(row, options.filter))
    },
    async createPage(
      databaseId: string,
      properties: Record<string, unknown>
    ): Promise<NotionPageRecord> {
      const now = new Date().toISOString()
      const page: NotionPageRecord = {
        id: `mock-page-${seq++}`,
        created_time: now,
        last_edited_time: now,
        properties,
      }
      const rows = dbTables.get(databaseId) || []
      rows.push(page)
      dbTables.set(databaseId, rows)
      return page
    },
    async updatePage(
      pageId: string,
      properties: Record<string, unknown>
    ): Promise<NotionPageRecord> {
      for (const rows of dbTables.values()) {
        const idx = rows.findIndex((r) => r.id === pageId)
        if (idx !== -1) {
          const updated: NotionPageRecord = {
            ...rows[idx],
            last_edited_time: new Date().toISOString(),
            properties: { ...rows[idx].properties, ...properties },
          }
          rows[idx] = updated
          return updated
        }
      }
      throw new Error(`Mock page not found: ${pageId}`)
    },
    async retrievePage(pageId: string): Promise<NotionPageRecord> {
      for (const rows of dbTables.values()) {
        const found = rows.find((r) => r.id === pageId)
        if (found) return found
      }
      throw new Error(`Mock page not found: ${pageId}`)
    },
  }
}

const TEST_CONFIG: StudyNotionConfig = {
  token: 'secret_synthetic_test_only',
  usersDbId: 'db-users',
  examsDbId: 'db-exams',
  questionsDbId: 'db-questions',
  cardStatesDbId: 'db-card-states',
  reviewEventsDbId: 'db-review-events',
  timeoutMs: 5000,
  maxRetries: 0,
  minIntervalMs: 0,
  maxPaginationPages: 10,
}

describe('Study System Notion repositories', () => {
  beforeEach(() => {
    clearStudyContentCache()
  })

  it('upserts and finds StudyUser by normalized username without duplicates', async () => {
    const client = createInMemoryStudyNotionClient()
    const repos = createNotionStudyRepositories(client, TEST_CONFIG)

    await repos.users.upsert(SYNTHETIC_USER)
    await repos.users.upsert({ ...SYNTHETIC_USER, credentialVersion: 2 })

    assert.equal(client.getCount('db-users'), 1)

    const found = await repos.users.findByUsername('  DEMO.STUDENT ')
    assert.ok(found)
    assert.equal(found.credentialVersion, 2)
    assert.equal(found.userId, SYNTHETIC_USER.userId)
  })

  it('lists published ExamCollections and filters QuestionBank by examId & questionIds', async () => {
    const client = createInMemoryStudyNotionClient()
    const repos = createNotionStudyRepositories(client, TEST_CONFIG)

    await repos.exams.upsert(SYNTHETIC_EXAM)
    await repos.exams.upsert({ ...SYNTHETIC_EXAM, examId: 'exam-draft-02', status: 'draft' })

    const publishedExams = await repos.exams.list({ status: 'published' })
    assert.equal(publishedExams.length, 1)
    assert.equal(publishedExams[0].examId, SYNTHETIC_EXAM.examId)

    await repos.questions.upsert(SYNTHETIC_SINGLE_CHOICE_QUESTION)
    await repos.questions.upsert(SYNTHETIC_MULTI_SELECT_QUESTION)

    const byExam = await repos.questions.listByExamId('exam-synth-01', { status: 'published' })
    assert.equal(byExam.length, 2)

    const byIds = await repos.questions.listByQuestionIds(['q-synth-002', 'q-synth-001', 'q-synth-001'])
    assert.equal(byIds.length, 2)
  })

  it('enforces optimistic revision concurrency on FsrsCardStateRepository.save', async () => {
    const client = createInMemoryStudyNotionClient()
    const repos = createNotionStudyRepositories(client, TEST_CONFIG)

    // Initial create (revision 1)
    const created = await repos.cardStates.save(SYNTHETIC_CARD_STATE, { expectedRevision: 0 })
    assert.equal(created.revision, 1)

    // Valid update (expectedRevision 1 -> revision 2)
    const rev2 = await repos.cardStates.save(
      { ...SYNTHETIC_CARD_STATE, revision: 2 },
      { expectedRevision: 1 }
    )
    assert.equal(rev2.revision, 2)

    // Stale concurrent writer still thinking revision is 1 -> throws ConcurrencyConflictError
    await assert.rejects(
      () =>
        repos.cardStates.save(
          { ...SYNTHETIC_CARD_STATE, revision: 2 },
          { expectedRevision: 1 }
        ),
      (err: unknown) =>
        err instanceof ConcurrencyConflictError &&
        err.expectedRevision === 1 &&
        err.actualRevision === 2
    )

    // Due query respects userId + due timestamp
    const due = await repos.cardStates.listDueByUser(
      SYNTHETIC_USER.userId,
      '2026-02-03T00:00:00.000Z'
    )
    assert.equal(due.length, 1)
  })

  it('appends ReviewEvents idempotently by eventId without duplicating rows', async () => {
    const client = createInMemoryStudyNotionClient()
    const repos = createNotionStudyRepositories(client, TEST_CONFIG)

    const first = await repos.reviewEvents.appendIfNotExists(SYNTHETIC_REVIEW_EVENT)
    assert.equal(first.created, true)
    assert.equal(client.getCount('db-review-events'), 1)

    const duplicate = await repos.reviewEvents.appendIfNotExists(SYNTHETIC_REVIEW_EVENT)
    assert.equal(duplicate.created, false)
    assert.equal(duplicate.event.eventId, SYNTHETIC_REVIEW_EVENT.eventId)
    assert.equal(client.getCount('db-review-events'), 1)

    const history = await repos.reviewEvents.listByUser(SYNTHETIC_USER.userId, { limit: 10 })
    assert.equal(history.length, 1)
  })

  it('caches published questions/exams with TTL, skips Notion on warm hits, never caches drafts, and invalidates on upsert', async () => {
    const baseClient = createInMemoryStudyNotionClient()
    let queryCount = 0
    const countedClient: StudyNotionClient = {
      async queryDatabaseAll(dbId, opts) {
        queryCount += 1
        return baseClient.queryDatabaseAll(dbId, opts)
      },
      createPage: baseClient.createPage,
      updatePage: baseClient.updatePage,
      retrievePage: baseClient.retrievePage,
    }
    const repos = createNotionStudyRepositories(countedClient, TEST_CONFIG)

    await repos.exams.upsert(SYNTHETIC_EXAM)
    await repos.questions.upsert(SYNTHETIC_SINGLE_CHOICE_QUESTION)
    await repos.questions.upsert({
      ...SYNTHETIC_MULTI_SELECT_QUESTION,
      questionId: 'q-draft-only',
      status: 'draft',
    })

    // Draft question must NEVER be cached
    assert.equal(getCachedPublishedQuestion('q-draft-only'), null)

    // Cold listByExamId hits Notion once and warms individual questionById cache
    clearStudyContentCache()
    queryCount = 0
    const list1 = await repos.questions.listByExamId('exam-synth-01', { status: 'published' })
    assert.equal(list1.length, 1)
    assert.equal(queryCount, 1)

    // Warm listByExamId & findByQuestionId make ZERO Notion queries
    const list2 = await repos.questions.listByExamId('exam-synth-01', { status: 'published' })
    const qHit = await repos.questions.findByQuestionId('q-synth-001')
    assert.equal(list2.length, 1)
    assert.ok(qHit && qHit.questionId === 'q-synth-001')
    assert.equal(queryCount, 1)

    // Upsert invalidates cached exam list and updates cached question
    await repos.questions.upsert({
      ...SYNTHETIC_SINGLE_CHOICE_QUESTION,
      explanation: 'Updated explanation after edit',
    })
    const afterUpdate = await repos.questions.findByQuestionId('q-synth-001')
    assert.equal(afterUpdate?.explanation, 'Updated explanation after edit')

    // TTL expiration evicts stale entry
    const t0 = 1_700_000_000_000
    setCachedPublishedQuestion(SYNTHETIC_SINGLE_CHOICE_QUESTION, t0)
    assert.ok(getCachedPublishedQuestion('q-synth-001', t0 + 1000))
    assert.equal(getCachedPublishedQuestion('q-synth-001', t0 + 10 * 60 * 1000), null)
  })
})
