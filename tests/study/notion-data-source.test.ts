import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createDataSourceResolver,
  DataSourceResolutionError,
  extractNotionErrorInfo,
  parseTypedNotionIdentifier,
  type DataSourceResolverAdapter,
  type DataSourceResolverLogger,
} from '../../lib/study/notion-data-source'
import { createNotionStudyRepositories } from '../../lib/study/repositories'
import { getPracticeExamPayload } from '../../lib/study/services/practice-service'
import {
  mapExamCollectionToNotionProperties,
  mapStudyQuestionToNotionProperties,
} from '../../lib/study/repositories/mappers'
import type { StudyNotionClient, NotionPageRecord } from '../../lib/study/notion-client'
import type { StudyNotionConfig } from '../../lib/study/config'
import {
  SYNTHETIC_EXAM,
  SYNTHETIC_SINGLE_CHOICE_QUESTION,
  SYNTHETIC_CARD_STATE,
} from './fixtures/synthetic-study-data'
import { clearStudyContentCache } from '../../lib/study/cache/content-cache'

function createSilentLogger() {
  const events: Array<{ level: string; event: string; meta: Record<string, unknown> }> = []
  const logger: DataSourceResolverLogger = {
    info: (event, meta) => events.push({ level: 'info', event, meta }),
    warn: (event, meta) => events.push({ level: 'warn', event, meta }),
    error: (event, meta) => events.push({ level: 'error', event, meta }),
  }
  return { logger, events }
}

function makeNotionErr(status: number, code: string, message: string) {
  const err = new Error(message) as Error & { status: number; code: string }
  err.status = status
  err.code = code
  return err
}

describe('Notion Database / Data Source ID Resolution & Cache Safety', () => {
  it('resolves a valid database ID and caches with bounded TTL', async () => {
    let now = 1_700_000_000_000
    let dbCalls = 0
    const { logger } = createSilentLogger()

    const adapter: DataSourceResolverAdapter = {
      async retrieveDatabase(id) {
        dbCalls += 1
        return {
          id,
          data_sources: [{ id: 'ds-questions-001', name: 'Question Bank' }],
        }
      },
      async retrieveDataSource(dsId) {
        return {
          id: dsId,
          name: 'Question Bank',
          properties: { 'Question ID': {}, 'Exam ID': {} },
        }
      },
    }

    const resolver = createDataSourceResolver(adapter, {
      ttlMs: 60_000,
      nowFn: () => now,
      logger,
    })

    const first = await resolver.resolve('db-questions-001')
    assert.equal(first.inputKind, 'database_id')
    assert.equal(first.dataSourceId, 'ds-questions-001')
    assert.equal(dbCalls, 1)

    // Warm cache hit
    const second = await resolver.resolve('db-questions-001')
    assert.equal(second.dataSourceId, 'ds-questions-001')
    assert.equal(dbCalls, 1)

    // After TTL expiration, resolves fresh
    now += 61_000
    const third = await resolver.resolve('db-questions-001')
    assert.equal(third.dataSourceId, 'ds-questions-001')
    assert.equal(dbCalls, 2)
  })

  it('resolves a valid data_source_id when databases.retrieve returns 404 object_not_found', async () => {
    const { logger } = createSilentLogger()
    let dsCalls = 0

    const adapter: DataSourceResolverAdapter = {
      async retrieveDatabase() {
        throw makeNotionErr(404, 'object_not_found', 'Could not find database')
      },
      async retrieveDataSource(dsId) {
        dsCalls += 1
        return {
          id: dsId,
          name: 'Public Child DB',
          parent: { type: 'database_id', database_id: 'db-parent-001' },
          properties: { Name: {}, Order: {} },
        }
      },
    }

    const resolver = createDataSourceResolver(adapter, { logger })
    const res = await resolver.resolve('35dac39b-0efb-8072-bd21-000b9f247718')
    assert.equal(res.inputKind, 'data_source_id')
    assert.equal(res.dataSourceId, '35dac39b-0efb-8072-bd21-000b9f247718')
    assert.equal(res.databaseId, 'db-parent-001')
    assert.equal(dsCalls, 1)

    // Cached on 2nd call
    const cached = await resolver.resolve('35dac39b-0efb-8072-bd21-000b9f247718')
    assert.equal(cached.dataSourceId, '35dac39b-0efb-8072-bd21-000b9f247718')
    assert.equal(dsCalls, 1)
  })

  it('never poisons cache after a transient timeout and recovers cleanly on the next call', async () => {
    const { logger } = createSilentLogger()
    let attempt = 0
    let dsRetrieveCalled = false

    const adapter: DataSourceResolverAdapter = {
      async retrieveDatabase(id) {
        attempt += 1
        if (attempt === 1) {
          const timeoutErr = new Error('Request to Notion API has timed out') as Error & {
            code: string
          }
          timeoutErr.code = 'notionhq_client_request_timeout'
          throw timeoutErr
        }
        return {
          id,
          data_sources: [{ id: '420ac39b-0efb-80f9-b2f6-000ba675f4b6', name: 'Question Bank' }],
        }
      },
      async retrieveDataSource() {
        dsRetrieveCalled = true
        throw new Error('Should not be called on transient timeout')
      },
    }

    const resolver = createDataSourceResolver(adapter, { logger })

    // First call hits transient timeout -> throws transient error, does NOT fall through, does NOT cache!
    await assert.rejects(
      () => resolver.resolve('420ac39b-0efb-804c-9334-eff9900065a3'),
      (err: unknown) =>
        err instanceof DataSourceResolutionError && err.category === 'transient'
    )
    assert.equal(dsRetrieveCalled, false)
    assert.equal(resolver.getCacheSize(), 0)

    // Subsequent call recovers cleanly with the verified data_source_id!
    const recovered = await resolver.resolve('420ac39b-0efb-804c-9334-eff9900065a3')
    assert.equal(recovered.dataSourceId, '420ac39b-0efb-80f9-b2f6-000ba675f4b6')
    assert.equal(resolver.getCacheSize(), 1)
  })

  it('invalidates stale cached data_source_id and recovers on forced re-resolution', async () => {
    const { logger } = createSilentLogger()
    let version = 1

    const adapter: DataSourceResolverAdapter = {
      async retrieveDatabase(id) {
        return {
          id,
          data_sources: [{ id: `ds-v${version}`, name: 'Question Bank' }],
        }
      },
    }

    const resolver = createDataSourceResolver(adapter, { logger })
    const v1 = await resolver.resolve('db-q')
    assert.equal(v1.dataSourceId, 'ds-v1')

    // Simulate Notion rotating/moving data_source_id -> query returns 404 object_not_found -> invalidate & re-resolve
    version = 2
    resolver.invalidate('db-q', 'query_object_not_found')
    const v2 = await resolver.resolve('db-q', { forceRefresh: true })
    assert.equal(v2.dataSourceId, 'ds-v2')
  })

  it('rejects invalid IDs and permission errors without caching', async () => {
    const { logger } = createSilentLogger()

    // 404 on both database and data_source -> invalid ID
    const invalidResolver = createDataSourceResolver(
      {
        async retrieveDatabase() {
          throw makeNotionErr(404, 'object_not_found', 'Not a DB')
        },
        async retrieveDataSource() {
          throw makeNotionErr(404, 'object_not_found', 'Not a DS')
        },
      },
      { logger }
    )
    await assert.rejects(
      () => invalidResolver.resolve('00000000-0000-4000-8000-000000000000'),
      (err: unknown) =>
        err instanceof DataSourceResolutionError && err.category === 'not_found'
    )
    assert.equal(invalidResolver.getCacheSize(), 0)

    // 403 restricted_resource -> permission error (does not fall through, does not cache)
    let dsCalled = false
    const permResolver = createDataSourceResolver(
      {
        async retrieveDatabase() {
          throw makeNotionErr(403, 'restricted_resource', 'Missing integration permission')
        },
        async retrieveDataSource() {
          dsCalled = true
          return { id: 'should-not-run' }
        },
      },
      { logger }
    )
    await assert.rejects(
      () => permResolver.resolve('db-private'),
      (err: unknown) =>
        err instanceof DataSourceResolutionError && err.category === 'permission'
    )
    assert.equal(dsCalled, false)
    assert.equal(permResolver.getCacheSize(), 0)
  })

  it('selects the schema-matching data source when multiple data sources exist and rejects ambiguous selection', async () => {
    const { logger } = createSilentLogger()

    const adapter: DataSourceResolverAdapter = {
      async retrieveDatabase(id) {
        return {
          id,
          data_sources: [
            { id: 'ds-wrong-01', name: 'Archive' },
            { id: 'ds-right-02', name: 'Question Bank' },
          ],
        }
      },
      async retrieveDataSource(dsId) {
        if (dsId === 'ds-wrong-01') {
          return { id: dsId, name: 'Archive', properties: { Name: {} } }
        }
        return {
          id: dsId,
          name: 'Question Bank',
          properties: { 'Question ID': {}, 'Exam ID': {}, 'Question Text': {} },
        }
      },
    }

    const resolver = createDataSourceResolver(adapter, { logger })

    // Without expectedProperties, refuses to blindly pick data_sources[0]
    await assert.rejects(
      () => resolver.resolve('db-multi'),
      (err: unknown) =>
        err instanceof DataSourceResolutionError && err.category === 'ambiguous_data_source'
    )

    // With expectedProperties, picks ds-right-02 (NOT ds-wrong-01!)
    const resolved = await resolver.resolve('db-multi', {
      expectedProperties: ['Question ID', 'Exam ID'],
    })
    assert.equal(resolved.dataSourceId, 'ds-right-02')
  })

  it('deduplicates concurrent cache misses with single-flight resolution', async () => {
    const { logger } = createSilentLogger()
    let dbCalls = 0

    const adapter: DataSourceResolverAdapter = {
      async retrieveDatabase(id) {
        dbCalls += 1
        await new Promise((r) => setTimeout(r, 25))
        return { id, data_sources: [{ id: 'ds-concurrent-1' }] }
      },
    }

    const resolver = createDataSourceResolver(adapter, { logger })
    const results = await Promise.all([
      resolver.resolve('db-concurrent'),
      resolver.resolve('db-concurrent'),
      resolver.resolve('db-concurrent'),
      resolver.resolve('db-concurrent'),
      resolver.resolve('db-concurrent'),
    ])

    assert.equal(dbCalls, 1)
    for (const r of results) {
      assert.equal(r.dataSourceId, 'ds-concurrent-1')
    }
  })

  it('detects missing required properties (e.g. Due / Reviewed At) and logs schema_mismatch', async () => {
    const { logger, events } = createSilentLogger()

    const adapter: DataSourceResolverAdapter = {
      async retrieveDatabase(id) {
        return { id, data_sources: [{ id: 'ds-card-states' }] }
      },
      async retrieveDataSource(dsId) {
        return { id: dsId, name: 'FSRS Card States', properties: { Name: {} } }
      },
    }

    const resolver = createDataSourceResolver(adapter, { logger })

    // Default mode: logs schema_mismatch warning clearly without poisoning error classification
    const res = await resolver.resolve('db-card-states', {
      expectedProperties: ['State Key', 'Due'],
    })
    assert.equal(res.dataSourceId, 'ds-card-states')
    const warnEvent = events.find((e) => e.event === 'schema_mismatch')
    assert.ok(warnEvent)
    assert.deepEqual(warnEvent.meta.missingProperties, ['State Key', 'Due'])

    // Strict mode: throws schema_mismatch
    await assert.rejects(
      () =>
        resolver.resolve('db-card-states', {
          expectedProperties: ['State Key', 'Due'],
          requireSchemaMatch: true,
          forceRefresh: true,
        }),
      (err: unknown) =>
        err instanceof DataSourceResolutionError && err.category === 'schema_mismatch'
    )

    // Verify helper error classification
    assert.equal(
      extractNotionErrorInfo(makeNotionErr(429, 'rate_limited', 'Slow down')).category,
      'transient'
    )
  })

  it('enforces strict schema validation on cached entries and rejects missing/empty schema metadata', async () => {
    const { logger } = createSilentLogger()

    // Case A: Cached entry with incomplete schema cannot bypass a stricter caller
    const partialResolver = createDataSourceResolver(
      {
        async retrieveDatabase(id) {
          return { id, data_sources: [{ id: 'ds-partial' }] }
        },
        async retrieveDataSource(dsId) {
          return { id: dsId, properties: { Name: {} } }
        },
      },
      { logger }
    )

    // Non-strict caller caches ds-partial
    const loose = await partialResolver.resolve('db-partial', {
      expectedProperties: ['State Key', 'Due'],
      requireSchemaMatch: false,
    })
    assert.equal(loose.dataSourceId, 'ds-partial')
    assert.equal(partialResolver.getCacheSize(), 1)

    // Stricter caller hitting the same cache key MUST be rejected with schema_mismatch
    await assert.rejects(
      () =>
        partialResolver.resolve('db-partial', {
          expectedProperties: ['State Key', 'Due'],
          requireSchemaMatch: true,
        }),
      (err: unknown) =>
        err instanceof DataSourceResolutionError && err.category === 'schema_mismatch'
    )

    // Case B: Empty/missing schema metadata is rejected when requireSchemaMatch is true (never cached!)
    const emptySchemaResolver = createDataSourceResolver(
      {
        async retrieveDatabase(id) {
          return { id, data_sources: [{ id: 'ds-empty-schema' }] }
        },
        async retrieveDataSource(dsId) {
          return { id: dsId, properties: {} }
        },
      },
      { logger }
    )
    await assert.rejects(
      () =>
        emptySchemaResolver.resolve('db-empty-schema', {
          expectedProperties: ['Due'],
          requireSchemaMatch: true,
        }),
      (err: unknown) =>
        err instanceof DataSourceResolutionError && err.category === 'schema_mismatch'
    )
    assert.equal(emptySchemaResolver.getCacheSize(), 0)
  })

  it('deduplicates concurrent forceRefresh calls and prevents stale in-flight resolution from overwriting after invalidation', async () => {
    const { logger } = createSilentLogger()
    let refreshCalls = 0

    const refreshResolver = createDataSourceResolver(
      {
        async retrieveDatabase(id) {
          refreshCalls += 1
          await new Promise((r) => setTimeout(r, 25))
          return { id, data_sources: [{ id: `ds-refresh-${refreshCalls}` }] }
        },
      },
      { logger }
    )

    // 5 concurrent forced refreshes share ONE upstream databases.retrieve call
    const refreshed = await Promise.all([
      refreshResolver.resolve('db-force', { forceRefresh: true }),
      refreshResolver.resolve('db-force', { forceRefresh: true }),
      refreshResolver.resolve('db-force', { forceRefresh: true }),
      refreshResolver.resolve('db-force', { forceRefresh: true }),
      refreshResolver.resolve('db-force', { forceRefresh: true }),
    ])
    assert.equal(refreshCalls, 1)
    for (const r of refreshed) {
      assert.equal(r.dataSourceId, 'ds-refresh-1')
    }

    // Stale in-flight resolution started before invalidate() MUST NOT overwrite newer verified mapping
    let callNum = 0
    let resolveFirst!: (val: { id: string; data_sources: Array<{ id: string }> }) => void
    const raceResolver = createDataSourceResolver(
      {
        retrieveDatabase(id) {
          callNum += 1
          if (callNum === 1) {
            return new Promise((r) => {
              resolveFirst = r
            })
          }
          return Promise.resolve({ id, data_sources: [{ id: 'ds-newer-v2' }] })
        },
      },
      { logger }
    )

    const p1 = raceResolver.resolve('db-race')
    // While p1 is still in flight, invalidate() runs and p2 resolves the newer v2 mapping
    raceResolver.invalidate('db-race', 'stale_detected')
    const p2Result = await raceResolver.resolve('db-race', { forceRefresh: true })
    assert.equal(p2Result.dataSourceId, 'ds-newer-v2')

    // Now p1 finishes late with stale v1 — it MUST NOT overwrite ds-newer-v2 in cache!
    resolveFirst({ id: 'db-race', data_sources: [{ id: 'ds-stale-v1' }] })
    await p1
    const afterRace = await raceResolver.resolve('db-race')
    assert.equal(afterRace.dataSourceId, 'ds-newer-v2')
  })

  it('supports explicit ds:/db: prefixes to eliminate unnecessary databases.retrieve probes', async () => {
    const { logger } = createSilentLogger()
    let dbCalls = 0
    let dsCalls = 0

    assert.deepEqual(parseTypedNotionIdentifier('ds:35dac39b-0efb-8072-bd21-000b9f247718'), {
      id: '35dac39b-0efb-8072-bd21-000b9f247718',
      explicitKind: 'data_source_id',
    })
    assert.deepEqual(parseTypedNotionIdentifier('420ac39b-0efb-804c-9334-eff9900065a3'), {
      id: '420ac39b-0efb-804c-9334-eff9900065a3',
      explicitKind: null,
    })

    const resolver = createDataSourceResolver(
      {
        async retrieveDatabase() {
          dbCalls += 1
          throw new Error('Should not probe databases.retrieve for explicit ds: prefix')
        },
        async retrieveDataSource(dsId) {
          dsCalls += 1
          return { id: dsId, properties: { Name: {} } }
        },
      },
      { logger }
    )

    const res = await resolver.resolve('ds:35dac39b-0efb-8072-bd21-000b9f247718')
    assert.equal(res.inputKind, 'data_source_id')
    assert.equal(res.dataSourceId, '35dac39b-0efb-8072-bd21-000b9f247718')
    assert.equal(dbCalls, 0)
    assert.equal(dsCalls, 1)
  })

  it('loads Practice exam & creates FSRS pages using the verified schema-matching data source across multi-data-source DBs', async () => {
    clearStudyContentCache()
    const { logger } = createSilentLogger()

    const resolver = createDataSourceResolver(
      {
        async retrieveDatabase(id) {
          if (id === 'db-questions') {
            return {
              id,
              data_sources: [
                { id: 'ds-wrong-archive', name: 'Archive' },
                { id: 'ds-questions-real', name: 'Question Bank' },
              ],
            }
          }
          if (id === 'db-exams') {
            return { id, data_sources: [{ id: 'ds-exams-real', name: 'Exam Collections' }] }
          }
          if (id === 'db-card-states') {
            return {
              id,
              data_sources: [
                { id: 'ds-card-wrong', name: 'Notes' },
                { id: 'ds-card-real', name: 'FSRS Card States' },
              ],
            }
          }
          return { id, data_sources: [{ id: `ds-${id}` }] }
        },
        async retrieveDataSource(dsId) {
          if (dsId === 'ds-questions-real') {
            return {
              id: dsId,
              properties: {
                'Question ID': {},
                'Exam ID': {},
                'Question Text': {},
                'Options JSON': {},
                'Correct Option IDs': {},
              },
            }
          }
          if (dsId === 'ds-exams-real') {
            return { id: dsId, properties: { 'Exam ID': {}, Title: {}, Status: {} } }
          }
          if (dsId === 'ds-card-real') {
            return {
              id: dsId,
              properties: { 'State Key': {}, 'User ID': {}, 'Question ID': {}, Due: {}, Revision: {} },
            }
          }
          return { id: dsId, properties: { Name: {} } }
        },
      },
      { logger }
    )

    const queriedDataSources: string[] = []
    const createdParents: Array<{ type: 'data_source_id'; data_source_id: string }> = []

    const examPage: NotionPageRecord = {
      id: 'page-exam-1',
      properties: mapExamCollectionToNotionProperties(SYNTHETIC_EXAM),
    }
    const questionPage: NotionPageRecord = {
      id: 'page-q-1',
      properties: mapStudyQuestionToNotionProperties(SYNTHETIC_SINGLE_CHOICE_QUESTION),
    }

    const client: StudyNotionClient = {
      async queryDatabaseAll(dbId, opts = {}) {
        const resolved = await resolver.resolve(dbId, {
          expectedProperties: opts.expectedProperties,
          requireSchemaMatch: Boolean(opts.expectedProperties?.length),
        })
        queriedDataSources.push(resolved.dataSourceId)
        if (resolved.dataSourceId === 'ds-exams-real') return [examPage]
        if (resolved.dataSourceId === 'ds-questions-real') return [questionPage]
        return []
      },
      async createPage(dbId, properties, opts) {
        const resolved = await resolver.resolve(dbId, {
          expectedProperties: opts?.expectedProperties,
          requireSchemaMatch: Boolean(opts?.expectedProperties?.length),
        })
        createdParents.push({ type: 'data_source_id', data_source_id: resolved.dataSourceId })
        return { id: 'page-created-1', properties }
      },
      async updatePage(pageId, properties) {
        return { id: pageId, properties }
      },
      async retrievePage(pageId) {
        return { id: pageId, properties: {} }
      },
    }

    const config: StudyNotionConfig = {
      token: 'secret_test',
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

    const repos = createNotionStudyRepositories(client, config, { useContentCache: false })

    // Practice exam loading selects ds-questions-real (NOT ds-wrong-archive)
    const payload = await getPracticeExamPayload(SYNTHETIC_EXAM.examId, repos)
    assert.ok(payload)
    assert.equal(payload.questions.length, 1)
    assert.ok(queriedDataSources.includes('ds-questions-real'))
    assert.equal(queriedDataSources.includes('ds-wrong-archive'), false)

    // FSRS Card State creation targets the verified ds-card-real data source (NOT ds-card-wrong)
    await repos.cardStates.save(SYNTHETIC_CARD_STATE, { expectedRevision: 0 })
    assert.deepEqual(createdParents, [
      { type: 'data_source_id', data_source_id: 'ds-card-real' },
    ])
  })

  it('recovers stale nested public child database data_source_id via parent database_id on 404 object_not_found', async () => {
    const notionMod = (await import('../../lib/notion-datasource-recovery.js')) as {
      executePublicDataSourceQueryWithRecovery: (args: {
        targetId: string
        isDataSourceId?: boolean
        parentDatabaseId?: string | null
        resolveDataSource: (id: string, forceRefresh?: boolean) => Promise<string>
        invalidateMapping?: (id: string) => void
        runQuery: (dsId: string) => Promise<{ results: Array<{ id: string }> }>
      }) => Promise<{ results: Array<{ id: string }> }>
    }

    const invalidated: string[] = []
    const queried: string[] = []
    let resolveForceCalls = 0

    const res = await notionMod.executePublicDataSourceQueryWithRecovery({
      targetId: 'ds-nested-stale-v1',
      isDataSourceId: true,
      parentDatabaseId: 'db-nested-parent',
      invalidateMapping: (id) => invalidated.push(id),
      resolveDataSource: async (_id, force) => {
        if (force) resolveForceCalls += 1
        return 'ds-nested-fresh-v2'
      },
      runQuery: async (dsId) => {
        queried.push(dsId)
        if (dsId === 'ds-nested-stale-v1') {
          throw makeNotionErr(404, 'object_not_found', 'Could not find data_source')
        }
        return { results: [{ id: 'row-1' }] }
      },
    })

    assert.deepEqual(invalidated, ['db-nested-parent'])
    assert.equal(resolveForceCalls, 1)
    assert.deepEqual(queried, ['ds-nested-stale-v1', 'ds-nested-fresh-v2'])
    assert.equal(res.results.length, 1)
  })
})
