import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeNotionId } from '../../lib/notion-datasource-recovery'
import type { NotionPageParent } from '../../lib/notion-types'
import { notion } from '../../lib/notion/client'
import { isPublicNotionPage } from '../../lib/notion/access'
import { getArticleTranslations, localizeInternalLinks } from '../../lib/notion/translations'
import { getPageBySlug } from '../../lib/notion/articles'

// Valid 32-hex Notion UUID fixtures (synthetic, offline-only)
const IDS = {
  ROOT_DB: '10000000-0000-4000-8000-000000000001',
  ROOT_DS_PUBLIC: '10000000-0000-4000-8000-000000000002',
  ROOT_DS_SIBLING_PRIVATE: '10000000-0000-4000-8000-000000000003',
  MAPPING_DB: '20000000-0000-4000-8000-000000000001',
  MAPPING_DS: '20000000-0000-4000-8000-000000000002',
  PRIVATE_DB: '30000000-0000-4000-8000-000000000001',
  PRIVATE_DS: '30000000-0000-4000-8000-000000000002',
  NESTED_DB: '40000000-0000-4000-8000-000000000001',
  NESTED_DS: '40000000-0000-4000-8000-000000000002',
  ARCHIVED_DB: '50000000-0000-4000-8000-000000000001',
  ARCHIVED_DS: '50000000-0000-4000-8000-000000000002',
  ACTIVE_DB_ARCHIVED_DS_DB: '50000000-0000-4000-8000-000000000003',
  ACTIVE_DB_ARCHIVED_DS: '50000000-0000-4000-8000-000000000004',

  PAGE_EN_ROOT: 'a0000000-0000-4000-8000-000000000001',
  PAGE_VI_ROOT: 'a0000000-0000-4000-8000-000000000002',
  PAGE_VI_DRAFT: 'a0000000-0000-4000-8000-000000000003',
  PAGE_EN_CHILD: 'b0000000-0000-4000-8000-000000000001',
  PAGE_VI_CHILD: 'b0000000-0000-4000-8000-000000000002',
  PAGE_NESTED_EN: 'c0000000-0000-4000-8000-000000000001',
  PAGE_NESTED_VI: 'c0000000-0000-4000-8000-000000000002',
  PAGE_NESTED_VI_WIP: 'c0000000-0000-4000-8000-000000000003',
  PAGE_PRIVATE: 'd0000000-0000-4000-8000-000000000001',
  PAGE_SIBLING_DS: 'd0000000-0000-4000-8000-000000000002',
  PAGE_ARCHIVED_DB_ROW: 'd0000000-0000-4000-8000-000000000003',
  PAGE_ARCHIVED_DS_ROW: 'd0000000-0000-4000-8000-000000000004',
  PAGE_NO_OWNER_DS_ROW: 'd0000000-0000-4000-8000-000000000005',
  NO_OWNER_DS: '50000000-0000-4000-8000-000000000005',
  PAGE_DS_ONLY_ROOT_ROW: 'e0000000-0000-4000-8000-000000000001',
  PAGE_COLLISION_EN: 'f0000000-0000-4000-8000-000000000001',
  PAGE_COLLISION_VI: 'f0000000-0000-4000-8000-000000000002',
} as const

type MockPage = Record<string, unknown>
type MockDatabase = Record<string, unknown>
type MockDataSource = Record<string, unknown>

function richText(content: string) {
  return [{ type: 'text', plain_text: content, text: { content, link: null }, annotations: {} }]
}

function makeDbPage(opts: {
  id: string
  title: string
  slug?: string
  status?: string | null
  locale?: string
  translationGroupId?: string
  parent: Record<string, unknown>
  archived?: boolean
  in_trash?: boolean
}): MockPage {
  const properties: Record<string, unknown> = {
    Name: { type: 'title', title: richText(opts.title) },
  }
  if (opts.slug !== undefined) {
    properties.Slug = { type: 'rich_text', rich_text: opts.slug ? richText(opts.slug) : [] }
  }
  if (opts.status !== undefined) {
    properties.Status = {
      type: 'status',
      status: opts.status ? { name: opts.status } : null,
    }
  }
  if (opts.locale !== undefined) {
    properties.Locale = { type: 'select', select: { name: opts.locale } }
  }
  if (opts.translationGroupId !== undefined) {
    properties['Translation Group ID'] = {
      type: 'rich_text',
      rich_text: opts.translationGroupId ? richText(opts.translationGroupId) : [],
    }
  }
  return {
    object: 'page',
    id: opts.id,
    archived: Boolean(opts.archived),
    in_trash: Boolean(opts.in_trash),
    parent: opts.parent,
    properties,
    created_time: '2026-11-01T00:00:00.000Z',
    last_edited_time: '2026-11-01T00:00:00.000Z',
  }
}

function makeChildPage(opts: {
  id: string
  title: string
  parentPageId: string
  archived?: boolean
  in_trash?: boolean
}): MockPage {
  // Real Notion child_page objects only carry `title` (no Slug / Status / Locale properties)
  return {
    object: 'page',
    id: opts.id,
    archived: Boolean(opts.archived),
    in_trash: Boolean(opts.in_trash),
    parent: { type: 'page_id', page_id: opts.parentPageId },
    properties: {
      title: { type: 'title', title: richText(opts.title) },
    },
    created_time: '2026-11-01T00:00:00.000Z',
    last_edited_time: '2026-11-01T00:00:00.000Z',
  }
}

function makeMappingRow(opts: {
  rowId: string
  name: string
  enPageId: string
  viPageId: string
  status: string
}): MockPage {
  return {
    object: 'page',
    id: opts.rowId,
    properties: {
      Name: { type: 'title', title: richText(opts.name) },
      'EN Page ID': { type: 'rich_text', rich_text: richText(opts.enPageId) },
      'VI Page ID': { type: 'rich_text', rich_text: richText(opts.viPageId) },
      Status: { type: 'status', status: { name: opts.status } },
    },
  }
}

function makeParagraphBlock(blockId: string, text: string) {
  return {
    object: 'block',
    id: blockId,
    type: 'paragraph',
    has_children: false,
    archived: false,
    in_trash: false,
    paragraph: {
      rich_text: richText(text),
      color: 'default',
    },
  }
}

interface MockNotionWorld {
  pages: Map<string, MockPage>
  databases: Map<string, MockDatabase>
  dataSources: Map<string, MockDataSource>
  dataSourceRows: Map<string, MockPage[]>
  blocksByParent: Map<string, unknown[]>
  searchCalls: number
}

function createEmptyWorld(): MockNotionWorld {
  return {
    pages: new Map(),
    databases: new Map(),
    dataSources: new Map(),
    dataSourceRows: new Map(),
    blocksByParent: new Map(),
    searchCalls: 0,
  }
}

describe('Knowledge Hub EN/VI language switching & public data_source authorization', () => {
  const originalEnv = {
    NOTION_ROOT_PAGE_ID: process.env.NOTION_ROOT_PAGE_ID,
    NOTION_DATABASE_ID: process.env.NOTION_DATABASE_ID,
    NOTION_TRANSLATION_MAPPING_DATABASE_ID: process.env.NOTION_TRANSLATION_MAPPING_DATABASE_ID,
  }

  const notionAny = notion as unknown as {
    pages: { retrieve: (args: { page_id: string }) => Promise<unknown> }
    databases: { retrieve: (args: { database_id: string }) => Promise<unknown> }
    dataSources: {
      retrieve: (args: { data_source_id: string }) => Promise<unknown>
      query: (args: { data_source_id: string }) => Promise<unknown>
    }
    blocks: {
      retrieve: (args: { block_id: string }) => Promise<unknown>
      children: { list: (args: { block_id: string }) => Promise<unknown> }
    }
    search: (args: unknown) => Promise<unknown>
  }

  const savedMethods = {
    pagesRetrieve: notionAny.pages.retrieve,
    databasesRetrieve: notionAny.databases.retrieve,
    dataSourcesRetrieve: notionAny.dataSources.retrieve,
    dataSourcesQuery: notionAny.dataSources.query,
    blocksRetrieve: notionAny.blocks.retrieve,
    blocksChildrenList: notionAny.blocks.children.list,
    search: notionAny.search,
  }

  let world: MockNotionWorld

  function installWorld(w: MockNotionWorld) {
    world = w
    notionAny.pages.retrieve = async ({ page_id }) => {
      const found = world.pages.get(normalizeNotionId(page_id))
      if (!found) {
        const err = new Error(`Page not found: ${page_id}`) as Error & { status: number; code: string }
        err.status = 404
        err.code = 'object_not_found'
        throw err
      }
      return found
    }
    notionAny.databases.retrieve = async ({ database_id }) => {
      const found = world.databases.get(normalizeNotionId(database_id))
      if (!found) {
        const err = new Error(`Database not found: ${database_id}`) as Error & {
          status: number
          code: string
        }
        err.status = 404
        err.code = 'object_not_found'
        throw err
      }
      return found
    }
    notionAny.dataSources.retrieve = async ({ data_source_id }) => {
      const found = world.dataSources.get(normalizeNotionId(data_source_id))
      if (!found) {
        const err = new Error(`Data source not found: ${data_source_id}`) as Error & {
          status: number
          code: string
        }
        err.status = 404
        err.code = 'object_not_found'
        throw err
      }
      return found
    }
    notionAny.dataSources.query = async ({ data_source_id }) => {
      const rows = world.dataSourceRows.get(normalizeNotionId(data_source_id)) || []
      return { results: rows, has_more: false, next_cursor: null }
    }
    notionAny.blocks.retrieve = async ({ block_id }) => {
      const err = new Error(`Block not found: ${block_id}`) as Error & { status: number; code: string }
      err.status = 404
      err.code = 'object_not_found'
      throw err
    }
    notionAny.blocks.children.list = async ({ block_id }) => {
      const blocks = world.blocksByParent.get(normalizeNotionId(block_id)) || [
        makeParagraphBlock(`blk-${normalizeNotionId(block_id).slice(0, 8)}`, 'Article body content.'),
      ]
      return { results: blocks, has_more: false, next_cursor: null }
    }
    notionAny.search = async () => {
      world.searchCalls += 1
      return { results: [], has_more: false, next_cursor: null }
    }
  }

  beforeEach(() => {
    globalThis.__notionCache?.clear()
    globalThis.__notionI18nWarnings?.clear()
    process.env.NOTION_ROOT_PAGE_ID = IDS.ROOT_DB
    delete process.env.NOTION_DATABASE_ID
    process.env.NOTION_TRANSLATION_MAPPING_DATABASE_ID = IDS.MAPPING_DB

    const w = createEmptyWorld()

    // Root database with two data sources (public + private sibling)
    w.databases.set(normalizeNotionId(IDS.ROOT_DB), {
      id: IDS.ROOT_DB,
      archived: false,
      in_trash: false,
      data_sources: [{ id: IDS.ROOT_DS_PUBLIC }, { id: IDS.ROOT_DS_SIBLING_PRIVATE }],
      parent: { type: 'workspace', workspace: true },
    })
    w.dataSources.set(normalizeNotionId(IDS.ROOT_DS_PUBLIC), {
      id: IDS.ROOT_DS_PUBLIC,
      archived: false,
      in_trash: false,
      parent: { type: 'database_id', database_id: IDS.ROOT_DB },
      database_parent: { type: 'workspace', workspace: true },
    })
    w.dataSources.set(normalizeNotionId(IDS.ROOT_DS_SIBLING_PRIVATE), {
      id: IDS.ROOT_DS_SIBLING_PRIVATE,
      archived: false,
      in_trash: false,
      parent: { type: 'database_id', database_id: IDS.ROOT_DB },
      database_parent: { type: 'workspace', workspace: true },
    })

    // Mapping database
    w.databases.set(normalizeNotionId(IDS.MAPPING_DB), {
      id: IDS.MAPPING_DB,
      archived: false,
      in_trash: false,
      data_sources: [{ id: IDS.MAPPING_DS }],
      parent: { type: 'workspace', workspace: true },
    })
    w.dataSources.set(normalizeNotionId(IDS.MAPPING_DS), {
      id: IDS.MAPPING_DS,
      archived: false,
      in_trash: false,
      parent: { type: 'database_id', database_id: IDS.MAPPING_DB },
      database_parent: { type: 'workspace', workspace: true },
    })

    // Private external database outside public root
    w.databases.set(normalizeNotionId(IDS.PRIVATE_DB), {
      id: IDS.PRIVATE_DB,
      archived: false,
      in_trash: false,
      data_sources: [{ id: IDS.PRIVATE_DS }],
      parent: { type: 'workspace', workspace: true },
    })
    w.dataSources.set(normalizeNotionId(IDS.PRIVATE_DS), {
      id: IDS.PRIVATE_DS,
      archived: false,
      in_trash: false,
      parent: { type: 'database_id', database_id: IDS.PRIVATE_DB },
      database_parent: { type: 'workspace', workspace: true },
    })

    // Nested inline course database inside a published public article
    w.databases.set(normalizeNotionId(IDS.NESTED_DB), {
      id: IDS.NESTED_DB,
      archived: false,
      in_trash: false,
      data_sources: [{ id: IDS.NESTED_DS }],
      parent: { type: 'page_id', page_id: IDS.PAGE_EN_ROOT },
    })
    w.dataSources.set(normalizeNotionId(IDS.NESTED_DS), {
      id: IDS.NESTED_DS,
      archived: false,
      in_trash: false,
      parent: { type: 'database_id', database_id: IDS.NESTED_DB },
      database_parent: { type: 'page_id', page_id: IDS.PAGE_EN_ROOT },
    })

    // Archived database with active data source (must be rejected)
    w.databases.set(normalizeNotionId(IDS.ARCHIVED_DB), {
      id: IDS.ARCHIVED_DB,
      archived: true,
      in_trash: false,
      data_sources: [{ id: IDS.ARCHIVED_DS }],
      parent: { type: 'page_id', page_id: IDS.PAGE_EN_ROOT },
    })
    w.dataSources.set(normalizeNotionId(IDS.ARCHIVED_DS), {
      id: IDS.ARCHIVED_DS,
      archived: false,
      in_trash: false,
      parent: { type: 'database_id', database_id: IDS.ARCHIVED_DB },
      database_parent: { type: 'page_id', page_id: IDS.PAGE_EN_ROOT },
    })

    // Active database with trashed/archived data source (must be rejected)
    w.databases.set(normalizeNotionId(IDS.ACTIVE_DB_ARCHIVED_DS_DB), {
      id: IDS.ACTIVE_DB_ARCHIVED_DS_DB,
      archived: false,
      in_trash: false,
      data_sources: [{ id: IDS.ACTIVE_DB_ARCHIVED_DS }],
      parent: { type: 'page_id', page_id: IDS.PAGE_EN_ROOT },
    })
    w.dataSources.set(normalizeNotionId(IDS.ACTIVE_DB_ARCHIVED_DS), {
      id: IDS.ACTIVE_DB_ARCHIVED_DS,
      archived: false,
      in_trash: true,
      parent: { type: 'database_id', database_id: IDS.ACTIVE_DB_ARCHIVED_DS_DB },
      database_parent: { type: 'page_id', page_id: IDS.PAGE_EN_ROOT },
    })

    // Data source missing owning database metadata (must fail closed)
    w.dataSources.set(normalizeNotionId(IDS.NO_OWNER_DS), {
      id: IDS.NO_OWNER_DS,
      archived: false,
      in_trash: false,
      parent: null,
      database_parent: { type: 'page_id', page_id: IDS.PAGE_EN_ROOT },
    })

    // Base published EN root article
    const rootEnPage = makeDbPage({
      id: IDS.PAGE_EN_ROOT,
      title: 'ServiceNow CSA Guide',
      slug: 'servicenow-csa',
      status: 'Published',
      locale: 'en',
      parent: { type: 'data_source_id', data_source_id: IDS.ROOT_DS_PUBLIC },
    })
    w.pages.set(normalizeNotionId(IDS.PAGE_EN_ROOT), rootEnPage)
    w.dataSourceRows.set(normalizeNotionId(IDS.ROOT_DS_PUBLIC), [rootEnPage])

    installWorld(w)
  })

  afterEach(() => {
    notionAny.pages.retrieve = savedMethods.pagesRetrieve
    notionAny.databases.retrieve = savedMethods.databasesRetrieve
    notionAny.dataSources.retrieve = savedMethods.dataSourcesRetrieve
    notionAny.dataSources.query = savedMethods.dataSourcesQuery
    notionAny.blocks.retrieve = savedMethods.blocksRetrieve
    notionAny.blocks.children.list = savedMethods.blocksChildrenList
    notionAny.search = savedMethods.search

    if (originalEnv.NOTION_ROOT_PAGE_ID === undefined) delete process.env.NOTION_ROOT_PAGE_ID
    else process.env.NOTION_ROOT_PAGE_ID = originalEnv.NOTION_ROOT_PAGE_ID
    if (originalEnv.NOTION_DATABASE_ID === undefined) delete process.env.NOTION_DATABASE_ID
    else process.env.NOTION_DATABASE_ID = originalEnv.NOTION_DATABASE_ID
    if (originalEnv.NOTION_TRANSLATION_MAPPING_DATABASE_ID === undefined) {
      delete process.env.NOTION_TRANSLATION_MAPPING_DATABASE_ID
    } else {
      process.env.NOTION_TRANSLATION_MAPPING_DATABASE_ID =
        originalEnv.NOTION_TRANSLATION_MAPPING_DATABASE_ID
    }

    globalThis.__notionCache?.clear()
    globalThis.__notionI18nWarnings?.clear()
  })

  describe('Defect 1 — Public authorization for data_source_id-only parents', () => {
    it('authorizes published pages whose parent has data_source_id without database_id under the root DB and nested public DBs', async () => {
      const rootDsOnlyRow = makeDbPage({
        id: IDS.PAGE_DS_ONLY_ROOT_ROW,
        title: 'Root DS-only Published Page',
        slug: 'root-ds-only',
        status: 'Published',
        locale: 'vi',
        // Intentionally omit database_id and omit from root query fast path to exercise parent traversal
        parent: { type: 'data_source_id', data_source_id: IDS.ROOT_DS_PUBLIC },
      })
      const nestedDsOnlyRow = makeDbPage({
        id: IDS.PAGE_NESTED_VI,
        title: 'Tổng quan về ServiceNow',
        slug: 'tong-quan-ve-servicenow',
        status: 'Published',
        locale: 'vi',
        parent: { type: 'data_source_id', data_source_id: IDS.NESTED_DS },
      })
      world.pages.set(normalizeNotionId(IDS.PAGE_DS_ONLY_ROOT_ROW), rootDsOnlyRow)
      world.pages.set(normalizeNotionId(IDS.PAGE_NESTED_VI), nestedDsOnlyRow)

      assert.equal(await isPublicNotionPage(IDS.PAGE_DS_ONLY_ROOT_ROW), true)
      assert.equal(await isPublicNotionPage(IDS.PAGE_NESTED_VI), true)
    })

    it('rejects private databases, archived databases, trashed data sources, and missing ownership metadata', async () => {
      world.pages.set(
        normalizeNotionId(IDS.PAGE_PRIVATE),
        makeDbPage({
          id: IDS.PAGE_PRIVATE,
          title: 'Private Study Question',
          status: 'Published',
          parent: { type: 'data_source_id', data_source_id: IDS.PRIVATE_DS },
        })
      )
      world.pages.set(
        normalizeNotionId(IDS.PAGE_ARCHIVED_DB_ROW),
        makeDbPage({
          id: IDS.PAGE_ARCHIVED_DB_ROW,
          title: 'Row inside Archived DB',
          status: 'Published',
          parent: { type: 'data_source_id', data_source_id: IDS.ARCHIVED_DS },
        })
      )
      world.pages.set(
        normalizeNotionId(IDS.PAGE_ARCHIVED_DS_ROW),
        makeDbPage({
          id: IDS.PAGE_ARCHIVED_DS_ROW,
          title: 'Row inside Trashed Data Source',
          status: 'Published',
          parent: { type: 'data_source_id', data_source_id: IDS.ACTIVE_DB_ARCHIVED_DS },
        })
      )
      world.pages.set(
        normalizeNotionId(IDS.PAGE_NO_OWNER_DS_ROW),
        makeDbPage({
          id: IDS.PAGE_NO_OWNER_DS_ROW,
          title: 'Row with Unverifiable DS Ownership',
          status: 'Published',
          parent: { type: 'data_source_id', data_source_id: IDS.NO_OWNER_DS },
        })
      )

      assert.equal(await isPublicNotionPage(IDS.PAGE_PRIVATE), false)
      assert.equal(await isPublicNotionPage(IDS.PAGE_ARCHIVED_DB_ROW), false)
      assert.equal(await isPublicNotionPage(IDS.PAGE_ARCHIVED_DS_ROW), false)
      assert.equal(await isPublicNotionPage(IDS.PAGE_NO_OWNER_DS_ROW), false)
    })

    it('does not treat sibling data sources in the same database as public when root explicitly specifies ds:<id>', async () => {
      process.env.NOTION_ROOT_PAGE_ID = `ds:${IDS.ROOT_DS_PUBLIC}`

      const siblingDsPage = makeDbPage({
        id: IDS.PAGE_SIBLING_DS,
        title: 'Internal Notes in Sibling Data Source',
        status: 'Published',
        parent: {
          type: 'data_source_id',
          data_source_id: IDS.ROOT_DS_SIBLING_PRIVATE,
          database_id: IDS.ROOT_DB,
        },
      })
      const dbOnlyParentPage = makeDbPage({
        id: IDS.PAGE_DS_ONLY_ROOT_ROW,
        title: 'Database-Only Parent Without Proof of Explicit Data Source',
        status: 'Published',
        parent: { type: 'database_id', database_id: IDS.ROOT_DB },
      })
      const nestedInsideExplicitDsArticle = makeDbPage({
        id: IDS.PAGE_NESTED_VI,
        title: 'Nested Lesson Inside Public Article',
        status: 'Published',
        parent: { type: 'data_source_id', data_source_id: IDS.NESTED_DS },
      })

      world.pages.set(normalizeNotionId(IDS.PAGE_SIBLING_DS), siblingDsPage)
      world.pages.set(normalizeNotionId(IDS.PAGE_DS_ONLY_ROOT_ROW), dbOnlyParentPage)
      world.pages.set(normalizeNotionId(IDS.PAGE_NESTED_VI), nestedInsideExplicitDsArticle)

      // Sibling data source in the same DB MUST be rejected
      assert.equal(await isPublicNotionPage(IDS.PAGE_SIBLING_DS), false)
      // database_id-only parent cannot prove membership in explicit ds:<id> -> fail closed
      assert.equal(await isPublicNotionPage(IDS.PAGE_DS_ONLY_ROOT_ROW), false)
      // Nested database inside an article belonging to ds:<id> remains authorized
      assert.equal(await isPublicNotionPage(IDS.PAGE_NESTED_VI), true)
    })
  })

  describe('Defect 2 — Reliable routing for nested & mapped Vietnamese translation pages', () => {
    it('routes mapped Vietnamese child pages via compact UUID so getPageBySlug resolves both directions without workspace search', async () => {
      const enChild = makeChildPage({
        id: IDS.PAGE_EN_CHILD,
        title: 'Introduction to ServiceNow',
        parentPageId: IDS.PAGE_EN_ROOT,
      })
      const viChild = makeChildPage({
        id: IDS.PAGE_VI_CHILD,
        title: 'Giới thiệu về ServiceNow',
        parentPageId: IDS.PAGE_EN_ROOT,
      })
      world.pages.set(normalizeNotionId(IDS.PAGE_EN_CHILD), enChild)
      world.pages.set(normalizeNotionId(IDS.PAGE_VI_CHILD), viChild)
      world.dataSourceRows.set(normalizeNotionId(IDS.MAPPING_DS), [
        makeMappingRow({
          rowId: '90000000-0000-4000-8000-000000000001',
          name: 'Intro Lesson',
          enPageId: IDS.PAGE_EN_CHILD,
          viPageId: IDS.PAGE_VI_CHILD,
          status: 'Ready',
        }),
      ])

      const enResolved = await getPageBySlug(normalizeNotionId(IDS.PAGE_EN_CHILD))
      assert.ok(enResolved)
      assert.equal(enResolved.id, IDS.PAGE_EN_CHILD)
      assert.equal(enResolved.locale, 'en')

      // Switching EN -> VI produces compact UUID (never broken "gi-i-thi-u-v-servicenow")
      const enTranslations = await getArticleTranslations(enResolved)
      assert.ok(enTranslations.vi)
      assert.equal(enTranslations.vi.id, IDS.PAGE_VI_CHILD)
      assert.equal(enTranslations.vi.slug, normalizeNotionId(IDS.PAGE_VI_CHILD))

      // Navigating to the generated VI link resolves directly to the exact VI page & locale
      const viResolved = await getPageBySlug(enTranslations.vi.slug)
      assert.ok(viResolved)
      assert.equal(viResolved.id, IDS.PAGE_VI_CHILD)
      assert.equal(viResolved.locale, 'vi')
      assert.equal(viResolved.slug, normalizeNotionId(IDS.PAGE_VI_CHILD))

      // Switching VI -> EN resolves cleanly back to the exact EN child page
      const viTranslations = await getArticleTranslations(viResolved)
      assert.ok(viTranslations.en)
      assert.equal(viTranslations.en.id, IDS.PAGE_EN_CHILD)
      assert.equal(viTranslations.en.slug, normalizeNotionId(IDS.PAGE_EN_CHILD))

      const backToEn = await getPageBySlug(viTranslations.en.slug)
      assert.ok(backToEn)
      assert.equal(backToEn.id, IDS.PAGE_EN_CHILD)
      assert.equal(backToEn.locale, 'en')
      assert.equal(world.searchCalls, 0)
    })

    it('routes nested database Translation Group pairs with data_source_id-only parents via compact UUIDs', async () => {
      const nestedEn = makeDbPage({
        id: IDS.PAGE_NESTED_EN,
        title: 'Flow Designer Basics',
        slug: 'flow-designer-basics',
        status: 'Published',
        locale: 'en',
        translationGroupId: 'grp-nested-flow',
        parent: { type: 'data_source_id', data_source_id: IDS.NESTED_DS },
      })
      const nestedVi = makeDbPage({
        id: IDS.PAGE_NESTED_VI,
        title: 'Cơ bản về Flow Designer',
        slug: 'co-ban-ve-flow-designer',
        status: 'Published',
        locale: 'vi',
        translationGroupId: 'grp-nested-flow',
        parent: { type: 'data_source_id', data_source_id: IDS.NESTED_DS },
      })
      world.pages.set(normalizeNotionId(IDS.PAGE_NESTED_EN), nestedEn)
      world.pages.set(normalizeNotionId(IDS.PAGE_NESTED_VI), nestedVi)
      world.dataSourceRows.set(normalizeNotionId(IDS.NESTED_DS), [nestedEn, nestedVi])

      const enResolved = await getPageBySlug(normalizeNotionId(IDS.PAGE_NESTED_EN))
      assert.ok(enResolved)
      const translations = await getArticleTranslations(enResolved)
      assert.ok(translations.vi)
      assert.equal(translations.vi.id, IDS.PAGE_NESTED_VI)
      assert.equal(translations.vi.slug, normalizeNotionId(IDS.PAGE_NESTED_VI))

      const viResolved = await getPageBySlug(translations.vi.slug)
      assert.ok(viResolved)
      assert.equal(viResolved.id, IDS.PAGE_NESTED_VI)
      assert.equal(viResolved.locale, 'vi')
      assert.equal(world.searchCalls, 0)
    })
  })

  describe('Defect 3 — Authorization checks before exposing translation links & localized internal links', () => {
    it('hides Ready translation mappings targeting Draft or private pages from getArticleTranslations and localizeInternalLinks', async () => {
      const viDraft = makeDbPage({
        id: IDS.PAGE_VI_DRAFT,
        title: 'Bản nháp CSA',
        slug: 'ban-nhap-csa',
        status: 'Draft',
        locale: 'vi',
        parent: { type: 'data_source_id', data_source_id: IDS.ROOT_DS_PUBLIC },
      })
      const enChild = makeChildPage({
        id: IDS.PAGE_EN_CHILD,
        title: 'Public Lesson',
        parentPageId: IDS.PAGE_EN_ROOT,
      })
      const privatePage = makeDbPage({
        id: IDS.PAGE_PRIVATE,
        title: 'Private Page Mapped as Ready',
        slug: 'private-page',
        status: 'Published',
        locale: 'vi',
        parent: { type: 'data_source_id', data_source_id: IDS.PRIVATE_DS },
      })

      world.pages.set(normalizeNotionId(IDS.PAGE_VI_DRAFT), viDraft)
      world.pages.set(normalizeNotionId(IDS.PAGE_EN_CHILD), enChild)
      world.pages.set(normalizeNotionId(IDS.PAGE_PRIVATE), privatePage)
      world.dataSourceRows.set(normalizeNotionId(IDS.MAPPING_DS), [
        makeMappingRow({
          rowId: '90000000-0000-4000-8000-000000000010',
          name: 'Draft VI Mapping',
          enPageId: IDS.PAGE_EN_ROOT,
          viPageId: IDS.PAGE_VI_DRAFT,
          status: 'Ready',
        }),
        makeMappingRow({
          rowId: '90000000-0000-4000-8000-000000000011',
          name: 'Private VI Mapping',
          enPageId: IDS.PAGE_EN_CHILD,
          viPageId: IDS.PAGE_PRIVATE,
          status: 'Ready',
        }),
      ])

      // 1. Draft VI target must NOT appear in LanguageSwitcher / hreflang / JSON-LD
      const rootTranslations = await getArticleTranslations({
        id: IDS.PAGE_EN_ROOT,
        locale: 'en',
        translationGroupId: '',
        parent: {
          type: 'data_source_id',
          data_source_id: IDS.ROOT_DS_PUBLIC,
        } as unknown as NotionPageParent,
      })
      assert.equal(rootTranslations.vi, null)

      // 2. Private target with Ready mapping must NOT appear or gain public access
      const childTranslations = await getArticleTranslations({
        id: IDS.PAGE_EN_CHILD,
        locale: 'en',
        translationGroupId: '',
        parent: { type: 'page_id', page_id: IDS.PAGE_EN_ROOT },
      })
      assert.equal(childTranslations.vi, null)
      assert.equal(await getPageBySlug(normalizeNotionId(IDS.PAGE_VI_DRAFT)), null)
      assert.equal(await getPageBySlug(normalizeNotionId(IDS.PAGE_PRIVATE)), null)

      // 3. localizeInternalLinks must NOT rewrite links toward Draft or private targets
      const inputHtml = `<a href="/${normalizeNotionId(IDS.PAGE_EN_ROOT)}">Root</a> <a href="/${normalizeNotionId(IDS.PAGE_EN_CHILD)}">Child</a>`
      const localized = await localizeInternalLinks(inputHtml, 'vi')
      assert.equal(localized, inputHtml)
    })

    it('hides nested database translations whose Status is not Published', async () => {
      const nestedEn = makeDbPage({
        id: IDS.PAGE_NESTED_EN,
        title: 'ACL Rules',
        slug: 'acl-rules',
        status: 'Published',
        locale: 'en',
        translationGroupId: 'grp-acl',
        parent: { type: 'data_source_id', data_source_id: IDS.NESTED_DS },
      })
      const nestedViWip = makeDbPage({
        id: IDS.PAGE_NESTED_VI_WIP,
        title: 'Quy tắc ACL',
        slug: 'quy-tac-acl',
        status: 'In Progress',
        locale: 'vi',
        translationGroupId: 'grp-acl',
        parent: { type: 'data_source_id', data_source_id: IDS.NESTED_DS },
      })
      world.pages.set(normalizeNotionId(IDS.PAGE_NESTED_EN), nestedEn)
      world.pages.set(normalizeNotionId(IDS.PAGE_NESTED_VI_WIP), nestedViWip)
      world.dataSourceRows.set(normalizeNotionId(IDS.NESTED_DS), [nestedEn, nestedViWip])

      const translations = await getArticleTranslations({
        id: IDS.PAGE_NESTED_EN,
        locale: 'en',
        translationGroupId: 'grp-acl',
        parent: {
          type: 'data_source_id',
          data_source_id: IDS.NESTED_DS,
        } as unknown as NotionPageParent,
      })
      assert.equal(translations.vi, null)
      assert.equal(await getPageBySlug(normalizeNotionId(IDS.PAGE_NESTED_VI_WIP)), null)
    })
  })

  describe('Defect 4 — Disambiguated catalog slug reuse for top-level published articles', () => {
    it('reuses the disambiguated -vi catalog slug when top-level published articles share a raw slug and are paired via Translation Mapping DB', async () => {
      const rootEn = world.pages.get(normalizeNotionId(IDS.PAGE_EN_ROOT))!
      const rootViSameRawSlug = makeDbPage({
        id: IDS.PAGE_VI_ROOT,
        title: 'Hướng dẫn ServiceNow CSA',
        slug: 'servicenow-csa', // Same raw slug as EN; getAllPublishedPosts() disambiguates to servicenow-csa-vi
        status: 'Published',
        locale: 'vi',
        parent: { type: 'data_source_id', data_source_id: IDS.ROOT_DS_PUBLIC },
      })
      world.pages.set(normalizeNotionId(IDS.PAGE_VI_ROOT), rootViSameRawSlug)
      world.dataSourceRows.set(normalizeNotionId(IDS.ROOT_DS_PUBLIC), [rootEn, rootViSameRawSlug])
      world.dataSourceRows.set(normalizeNotionId(IDS.MAPPING_DS), [
        makeMappingRow({
          rowId: '90000000-0000-4000-8000-000000000020',
          name: 'CSA Mapping',
          enPageId: IDS.PAGE_EN_ROOT,
          viPageId: IDS.PAGE_VI_ROOT,
          status: 'Ready',
        }),
      ])

      const translations = await getArticleTranslations({
        id: IDS.PAGE_EN_ROOT,
        locale: 'en',
        translationGroupId: '',
        parent: {
          type: 'data_source_id',
          data_source_id: IDS.ROOT_DS_PUBLIC,
        } as unknown as NotionPageParent,
      })
      assert.ok(translations.vi)
      assert.equal(translations.vi.id, IDS.PAGE_VI_ROOT)
      assert.equal(translations.vi.slug, 'servicenow-csa-vi')

      const viPage = await getPageBySlug(translations.vi.slug)
      assert.ok(viPage)
      assert.equal(viPage.id, IDS.PAGE_VI_ROOT)
      assert.equal(viPage.locale, 'vi')
      assert.equal(viPage.slug, 'servicenow-csa-vi')

      // Internal links also reuse the canonical disambiguated slug
      const localized = await localizeInternalLinks('<a href="/servicenow-csa">CSA</a>', 'vi')
      assert.equal(localized, '<a href="/servicenow-csa-vi">CSA</a>')
    })

    it('falls back to compact UUID if two top-level catalog posts still collide on the same final slug', async () => {
      const colEn = makeDbPage({
        id: IDS.PAGE_COLLISION_EN,
        title: 'Guide EN',
        slug: 'guide-vi', // Already ends in -vi, colliding with VI after disambiguation
        status: 'Published',
        locale: 'en',
        translationGroupId: 'grp-collision',
        parent: { type: 'data_source_id', data_source_id: IDS.ROOT_DS_PUBLIC },
      })
      const colVi = makeDbPage({
        id: IDS.PAGE_COLLISION_VI,
        title: 'Guide VI',
        slug: 'guide-vi',
        status: 'Published',
        locale: 'vi',
        translationGroupId: 'grp-collision',
        parent: { type: 'data_source_id', data_source_id: IDS.ROOT_DS_PUBLIC },
      })
      world.pages.set(normalizeNotionId(IDS.PAGE_COLLISION_EN), colEn)
      world.pages.set(normalizeNotionId(IDS.PAGE_COLLISION_VI), colVi)
      world.dataSourceRows.set(normalizeNotionId(IDS.ROOT_DS_PUBLIC), [colEn, colVi])

      const translations = await getArticleTranslations({
        id: IDS.PAGE_COLLISION_EN,
        locale: 'en',
        translationGroupId: 'grp-collision',
        parent: {
          type: 'data_source_id',
          data_source_id: IDS.ROOT_DS_PUBLIC,
        } as unknown as NotionPageParent,
      })
      assert.ok(translations.vi)
      assert.equal(translations.vi.id, IDS.PAGE_COLLISION_VI)
      // Must NOT return the ambiguous 'guide-vi' (which would resolve to colEn!)
      assert.equal(translations.vi.slug, normalizeNotionId(IDS.PAGE_COLLISION_VI))

      const resolved = await getPageBySlug(translations.vi.slug)
      assert.ok(resolved)
      assert.equal(resolved.id, IDS.PAGE_COLLISION_VI)
      assert.equal(resolved.locale, 'vi')
    })
  })
})
