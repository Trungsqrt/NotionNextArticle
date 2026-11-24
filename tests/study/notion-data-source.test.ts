import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createDataSourceResolver,
  DataSourceResolutionError,
  extractNotionErrorInfo,
  type DataSourceResolverAdapter,
  type DataSourceResolverLogger,
} from '../../lib/study/notion-data-source'

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
})
