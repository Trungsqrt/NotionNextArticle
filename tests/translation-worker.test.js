'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { TRANSLATION_STATUS, getTranslationConfig } = require('../lib/notion-translation/config')
const { readRawNotionTree } = require('../lib/notion-translation/reader')
const { classifyBlock, classifyRichTextRun } = require('../lib/notion-translation/block-classifier')
const { extractTranslationManifest } = require('../lib/notion-translation/extractor')
const { translateManifest } = require('../lib/notion-translation/translator')
const {
  generateVietnameseSlug,
  resolveUniqueVietnameseSlug,
  buildTranslatedBlockTree,
  buildTranslatedPageProperties,
} = require('../lib/notion-translation/builder')
const { createTranslatedNotionPage } = require('../lib/notion-translation/writer')
const { validateTranslation } = require('../lib/notion-translation/validator')
const { processTranslationJob, recoverStaleProcessingPages } = require('../lib/notion-translation/workflow')
const { runPollCycle, acquireWorkerLock } = require('../worker/poller')
const { createLogger } = require('../worker/logger')
const {
  makeRichTextRun,
  createSampleSourcePage,
  createComprehensiveBlockFixtures,
} = require('./fixtures')

const silentLogger = createLogger({ silent: true })

/**
 * Helper to build an in-memory mocked Notion client that simulates:
 * - databases.retrieve / dataSources.retrieve / dataSources.update / dataSources.query
 * - pages.create / pages.update / pages.retrieve
 * - blocks.children.list (with configurable page_size pagination)
 * - blocks.children.append (creating nested block structures in memory)
 */
function createMockNotionEnvironment(options = {}) {
  const {
    initialPages = [],
    blocksByParentId = {},
    listPageSize = 100,
    failOnAppendBatchNumber = null,
  } = options

  const pages = new Map()
  for (const p of initialPages) {
    pages.set(p.id, structuredClone(p))
  }

  const childrenMap = new Map()
  for (const [k, v] of Object.entries(blocksByParentId)) {
    childrenMap.set(k, structuredClone(v))
  }

  const schemaProperties = {
    Name: { id: 'title', type: 'title', title: {} },
    Slug: { id: 'slug', type: 'rich_text', rich_text: {} },
    Status: {
      id: 'status',
      type: 'status',
      status: {
        options: [
          { name: 'Draft', color: 'gray' },
          { name: 'Published', color: 'green' },
        ],
      },
    },
    Locale: {
      id: 'locale',
      type: 'select',
      select: { options: [{ name: 'en' }, { name: 'vi' }] },
    },
    'Translation Group ID': { id: 'group_id', type: 'rich_text', rich_text: {} },
    Category: { id: 'cat', type: 'select', select: {} },
    Tags: { id: 'tags', type: 'multi_select', multi_select: {} },
    Summary: { id: 'summary', type: 'rich_text', rich_text: {} },
    Difficulty: { id: 'diff', type: 'select', select: {} },
    Duration: { id: 'dur', type: 'rich_text', rich_text: {} },
    'Parent Course': { id: 'parent_course', type: 'relation', relation: {} },
    'Translation Status': { id: 'trans_status', type: 'select', select: {} },
    'Translation Error': { id: 'trans_err', type: 'rich_text', rich_text: {} },
    'Translation Target Page ID': { id: 'trans_target', type: 'rich_text', rich_text: {} },
    'Translation Updated At': { id: 'trans_updated', type: 'date', date: {} },
  }

  let createdPageCounter = 0
  let createdBlockCounter = 0
  let appendCallCount = 0
  const appendCalls = []
  const pageUpdateCalls = []
  const pageCreateCalls = []

  function storeNestedBlockRequest(parentId, reqBlock) {
    createdBlockCounter += 1
    const newId = `created-blk-${createdBlockCounter}`
    const type = reqBlock.type
    const blockPayload = structuredClone(reqBlock[type] || {})
    const inlineChildren = blockPayload.children || []
    delete blockPayload.children

    const storedBlock = {
      id: newId,
      object: 'block',
      type,
      has_children: inlineChildren.length > 0,
      [type]: blockPayload,
    }

    if (!childrenMap.has(parentId)) {
      childrenMap.set(parentId, [])
    }
    childrenMap.get(parentId).push(storedBlock)

    if (inlineChildren.length > 0) {
      childrenMap.set(newId, [])
      for (const inlineChild of inlineChildren) {
        storeNestedBlockRequest(newId, inlineChild)
      }
    }

    return storedBlock
  }

  const client = {
    databases: {
      retrieve: async ({ database_id }) => ({
        object: 'database',
        id: database_id,
        data_sources: [{ id: 'ds-articles-001', name: 'Articles' }],
      }),
    },
    dataSources: {
      retrieve: async ({ data_source_id }) => ({
        object: 'data_source',
        id: data_source_id,
        parent: { type: 'database_id', database_id: 'db-articles-001' },
        properties: schemaProperties,
      }),
      update: async ({ properties }) => {
        Object.assign(schemaProperties, properties)
        return { id: 'ds-articles-001', properties: schemaProperties }
      },
      query: async () => ({
        object: 'list',
        results: Array.from(pages.values()),
        has_more: false,
        next_cursor: null,
      }),
    },
    pages: {
      retrieve: async ({ page_id }) => {
        const p = pages.get(page_id)
        if (!p) {
          const err = new Error(`Page not found: ${page_id}`)
          err.status = 404
          throw err
        }
        return structuredClone(p)
      },
      create: async (args) => {
        createdPageCounter += 1
        const id = `page-vi-${createdPageCounter}`
        const newPage = {
          object: 'page',
          id,
          url: `https://www.notion.so/${id}`,
          in_trash: false,
          archived: false,
          created_time: new Date().toISOString(),
          last_edited_time: new Date().toISOString(),
          parent: args.parent,
          icon: args.icon || null,
          cover: args.cover || null,
          properties: normalizePropertiesForMockPage(args.properties),
        }
        pages.set(id, newPage)
        childrenMap.set(id, [])
        pageCreateCalls.push(structuredClone(args))
        return structuredClone(newPage)
      },
      update: async ({ page_id, properties, icon, cover }) => {
        const existing = pages.get(page_id)
        if (!existing) {
          throw new Error(`Cannot update non-existent page ${page_id}`)
        }
        const normalized = normalizePropertiesForMockPage(properties)
        existing.properties = { ...existing.properties, ...normalized }
        if (icon !== undefined) existing.icon = icon
        if (cover !== undefined) existing.cover = cover
        existing.last_edited_time = new Date().toISOString()
        pageUpdateCalls.push({ page_id, properties: structuredClone(properties) })
        return structuredClone(existing)
      },
    },
    blocks: {
      children: {
        list: async ({ block_id, start_cursor }) => {
          const all = childrenMap.get(block_id) || []
          const startIdx = start_cursor ? Number(start_cursor) : 0
          const slice = all.slice(startIdx, startIdx + listPageSize)
          const nextIdx = startIdx + slice.length
          const hasMore = nextIdx < all.length
          return {
            object: 'list',
            results: structuredClone(slice),
            has_more: hasMore,
            next_cursor: hasMore ? String(nextIdx) : null,
          }
        },
        append: async ({ block_id, children }) => {
          appendCallCount += 1
          if (failOnAppendBatchNumber && appendCallCount === failOnAppendBatchNumber) {
            throw new Error(`Simulated Notion API failure on append call #${appendCallCount}`)
          }
          appendCalls.push({ block_id, count: children.length, children: structuredClone(children) })

          const parentList = childrenMap.get(block_id) || []
          if (!childrenMap.has(block_id)) {
            childrenMap.set(block_id, parentList)
          }

          const createdResults = []
          for (const reqBlock of children) {
            const stored = storeNestedBlockRequest(block_id, reqBlock)
            createdResults.push(structuredClone(stored))
          }

          // Mark parent block as has_children = true if it exists in any block list
          for (const list of childrenMap.values()) {
            for (const b of list) {
              if (b.id === block_id) b.has_children = true
            }
          }

          return {
            object: 'list',
            results: createdResults,
          }
        },
      },
    },
  }

  return {
    client,
    pages,
    childrenMap,
    appendCalls,
    pageUpdateCalls,
    pageCreateCalls,
  }
}

function normalizePropertiesForMockPage(writeProps = {}) {
  const out = {}
  for (const [key, val] of Object.entries(writeProps)) {
    if (!val || typeof val !== 'object') continue
    if (Array.isArray(val.title)) {
      out[key] = {
        type: 'title',
        title: val.title.map(r => ({
          ...r,
          plain_text: r.text?.content ?? r.plain_text ?? '',
        })),
      }
    } else if (Array.isArray(val.rich_text)) {
      out[key] = {
        type: 'rich_text',
        rich_text: val.rich_text.map(r => ({
          ...r,
          plain_text: r.text?.content ?? r.plain_text ?? '',
        })),
      }
    } else if (val.select !== undefined) {
      out[key] = { type: 'select', select: val.select }
    } else if (val.multi_select !== undefined) {
      out[key] = { type: 'multi_select', multi_select: val.multi_select }
    } else if (val.status !== undefined) {
      out[key] = { type: 'status', status: val.status }
    } else if (val.date !== undefined) {
      out[key] = { type: 'date', date: val.date }
    } else if (val.relation !== undefined) {
      out[key] = { type: 'relation', relation: val.relation }
    } else if (val.number !== undefined) {
      out[key] = { type: 'number', number: val.number }
    } else if (val.checkbox !== undefined) {
      out[key] = { type: 'checkbox', checkbox: val.checkbox }
    }
  }
  return out
}

function createMockAiAdapter() {
  return async ({ batchItems }) => ({
    translations: batchItems.map(item => ({
      id: item.id,
      text: `[VI] ${item.text}`,
    })),
  })
}

// ── Test 1: Raw reader preserves hierarchy ────────────────────────────────────
test('1. Raw reader preserves block hierarchy, types, and original IDs without mutating [slider] toggles', async () => {
  const { topLevelBlocks, childrenByParentId } = createComprehensiveBlockFixtures()
  // Also include a [slider] toggle to ensure reader does NOT mutate it into custom_slider
  const sliderBlock = {
    id: 'blk-slider-toggle',
    type: 'toggle',
    has_children: true,
    toggle: {
      rich_text: [makeRichTextRun('[slider]')],
      color: 'default',
    },
  }
  const blocksMap = {
    'page-en-001': [...topLevelBlocks, sliderBlock],
    ...childrenByParentId,
    'blk-slider-toggle': [
      {
        id: 'blk-slider-img-1',
        type: 'image',
        has_children: false,
        image: {
          type: 'external',
          external: { url: 'https://images.unsplash.com/photo-1' },
          caption: [makeRichTextRun('Slide 1 caption')],
        },
      },
    ],
  }

  const env = createMockNotionEnvironment({ blocksByParentId: blocksMap })
  const tree = await readRawNotionTree('page-en-001', { client: env.client, logger: silentLogger })

  assert.equal(Array.isArray(tree), true)
  assert.equal(tree.length, topLevelBlocks.length + 1)

  const toggleNode = tree.find(n => n.id === 'blk-toggle-1')
  assert.ok(toggleNode)
  assert.equal(toggleNode.type, 'toggle')
  assert.equal(toggleNode.children.length, 3)
  assert.deepEqual(
    toggleNode.children.map(c => c.type),
    ['heading_2', 'paragraph', 'code']
  )

  const colsNode = tree.find(n => n.id === 'blk-cols-1')
  assert.ok(colsNode)
  assert.equal(colsNode.children.length, 2)
  assert.equal(colsNode.children[0].type, 'column')
  assert.equal(colsNode.children[0].children[0].id, 'blk-col-left-p1')

  // Verify [slider] toggle is NOT mutated into custom_slider by the raw reader
  const sliderNode = tree.find(n => n.id === 'blk-slider-toggle')
  assert.equal(sliderNode.type, 'toggle')
  assert.equal(sliderNode.children.length, 1)
  assert.equal(sliderNode.children[0].type, 'image')
})

// ── Test 2: Reader follows pagination ─────────────────────────────────────────
test('2. Raw reader follows has_more and next_cursor pagination across multiple pages', async () => {
  const manyBlocks = Array.from({ length: 7 }, (_, idx) => ({
    id: `blk-page-item-${idx + 1}`,
    type: 'paragraph',
    has_children: false,
    paragraph: {
      rich_text: [makeRichTextRun(`Paragraph item #${idx + 1}`)],
      color: 'default',
    },
  }))

  // Set listPageSize = 2 so 7 blocks require 4 paginated API calls
  const env = createMockNotionEnvironment({
    blocksByParentId: { 'page-paginated': manyBlocks },
    listPageSize: 2,
  })

  const tree = await readRawNotionTree('page-paginated', {
    client: env.client,
    logger: silentLogger,
  })

  assert.equal(tree.length, 7)
  assert.deepEqual(
    tree.map(n => n.id),
    manyBlocks.map(b => b.id)
  )
})

// ── Test 3: Extractor identifies only translatable text ───────────────────────
test('3. Extractor identifies only human-readable text and excludes code blocks, inline code, equations, dividers, and [slider] markers', async () => {
  const sourcePage = createSampleSourcePage()
  const { topLevelBlocks, childrenByParentId } = createComprehensiveBlockFixtures()
  const unsupportedBlock = {
    id: 'blk-unsupported-1',
    type: 'unsupported',
    has_children: false,
    unsupported: {},
  }
  const sliderToggle = {
    id: 'blk-slider',
    type: 'toggle',
    has_children: true,
    toggle: {
      rich_text: [makeRichTextRun('[slider]')],
      color: 'default',
    },
  }

  const env = createMockNotionEnvironment({
    initialPages: [sourcePage],
    blocksByParentId: {
      [sourcePage.id]: [...topLevelBlocks, sliderToggle, unsupportedBlock],
      ...childrenByParentId,
      'blk-slider': [
        {
          id: 'blk-slider-img',
          type: 'image',
          has_children: false,
          image: {
            type: 'external',
            external: { url: 'https://images.unsplash.com/photo-2' },
            caption: [makeRichTextRun('Slider image caption')],
          },
        },
      ],
    },
  })

  const rawTree = await readRawNotionTree(sourcePage.id, { client: env.client, logger: silentLogger })
  const manifest = extractTranslationManifest(rawTree, { sourcePage })

  const extractedIds = manifest.items.map(i => i.id)
  const extractedTexts = manifest.items.map(i => i.text)

  // Title & Summary text runs are extracted, but inline code run `GlideRecord` in Summary (run 1) is NOT extracted
  assert.ok(extractedIds.includes('prop:title:run:0'))
  assert.ok(extractedIds.includes('prop:summary:run:0'))
  assert.ok(!extractedIds.includes('prop:summary:run:1'), 'Inline code run in summary must not be translated')
  assert.ok(extractedIds.includes('prop:summary:run:2'))

  // Mixed paragraph: inline code run 3 (`GlideRecord`) and inline equation run 6 (`O(\\log n)`) must NOT be extracted
  assert.ok(extractedIds.includes('block:blk-para-mixed:rich_text:run:0'))
  assert.ok(extractedIds.includes('block:blk-para-mixed:rich_text:run:1'))
  assert.ok(!extractedIds.includes('block:blk-para-mixed:rich_text:run:3'), 'Inline code run must not be extracted')
  assert.ok(extractedIds.includes('block:blk-para-mixed:rich_text:run:5'))
  assert.ok(!extractedIds.includes('block:blk-para-mixed:rich_text:run:6'), 'Inline equation must not be extracted')

  // Code blocks and Equation blocks must NEVER be extracted
  assert.equal(
    manifest.items.some(i => i.sourceBlockId === 'blk-code-1' || i.sourceBlockId === 'blk-toggle-code'),
    false,
    'Code block content must never be extracted for translation'
  )
  assert.equal(
    manifest.items.some(i => i.sourceBlockId === 'blk-eq-1'),
    false,
    'Equation block content must never be extracted for translation'
  )

  // Table row 2 cell 0 is inline code (`cmdb_ci_server`), cell 1 is translatable description
  assert.ok(!extractedIds.includes('block:blk-table-row-2:cells:0:run:0'))
  assert.ok(extractedIds.includes('block:blk-table-row-2:cells:1:run:0'))

  // [slider] toggle marker is NOT extracted, but its child image caption IS extracted
  assert.equal(
    extractedTexts.includes('[slider]'),
    false,
    '[slider] toggle title marker must not be translated'
  )
  assert.ok(extractedIds.includes('block:blk-slider-img:caption:run:0'))

  // Unsupported block is recorded in manifest.unsupportedBlocks
  assert.equal(manifest.unsupportedBlocks.length, 1)
  assert.equal(manifest.unsupportedBlocks[0].id, 'blk-unsupported-1')
})

// ── Test 4: AI translation returns valid structured data & retries incomplete batches ──
test('4. AI translation validates structured IDs and retries when a batch response is incomplete', async () => {
  const sampleManifest = {
    articleTitle: 'CMDB Guide',
    items: [
      { id: 'item-1', blockType: 'paragraph', text: 'First sentence.', leadingSpace: '', trailingSpace: '' },
      { id: 'item-2', blockType: 'paragraph', text: ' Second sentence.', leadingSpace: ' ', trailingSpace: '' },
    ],
  }

  let attempts = 0
  const flakyAdapter = async ({ batchItems }) => {
    attempts += 1
    if (attempts === 1) {
      // Incomplete response missing item-2 on first attempt
      return {
        translations: [{ id: 'item-1', text: 'Câu thứ nhất.' }],
      }
    }
    return {
      translations: batchItems.map(item => ({
        id: item.id,
        text: item.id === 'item-1' ? 'Câu thứ nhất.' : 'Câu thứ hai.',
      })),
    }
  }

  const res = await translateManifest(sampleManifest, 'vi', {
    aiAdapter: flakyAdapter,
    logger: silentLogger,
    initialRetryDelayMs: 1,
  })

  assert.equal(attempts, 2)
  assert.equal(res.stats.retryCount, 1)
  assert.equal(res.translations['item-1'], 'Câu thứ nhất.')
  // Leading space from original run is preserved
  assert.equal(res.translations['item-2'], ' Câu thứ hai.')
})

// ── Test 5: Builder preserves original block types and metadata ───────────────
test('5. Builder preserves original block types, annotations, links, checked state, code, equations, and generates ASCII Vietnamese slugs', async () => {
  assert.equal(
    generateVietnameseSlug('Hướng dẫn Cấu hình Đầy đủ CMDB & IRE trong ServiceNow!'),
    'huong-dan-cau-hinh-day-du-cmdb-ire-trong-servicenow'
  )

  const collisionSlug = resolveUniqueVietnameseSlug(
    'Tìm hiểu CMDB',
    'understanding-cmdb',
    new Set(['tim-hieu-cmdb', 'tim-hieu-cmdb-vi']),
    'vi'
  )
  assert.equal(collisionSlug, 'tim-hieu-cmdb-vi-2')

  const sourcePage = createSampleSourcePage()
  const { topLevelBlocks, childrenByParentId } = createComprehensiveBlockFixtures()
  const env = createMockNotionEnvironment({
    initialPages: [sourcePage],
    blocksByParentId: {
      [sourcePage.id]: topLevelBlocks,
      ...childrenByParentId,
    },
  })

  const rawTree = await readRawNotionTree(sourcePage.id, { client: env.client, logger: silentLogger })
  const manifest = extractTranslationManifest(rawTree, { sourcePage })
  const translationResult = await translateManifest(manifest, 'vi', {
    aiAdapter: createMockAiAdapter(),
    logger: silentLogger,
  })

  const builtTree = buildTranslatedBlockTree(rawTree, translationResult)

  // Check mixed paragraph annotations, inline code, link URL, and inline equation preservation
  const mixedPara = builtTree.find(n => n.id === 'blk-para-mixed')
  const runs = mixedPara.raw.paragraph.rich_text
  assert.equal(runs[1].annotations.bold, true)
  assert.equal(runs[1].text.content, '[VI] Business Rule')
  assert.equal(runs[3].annotations.code, true)
  assert.equal(runs[3].text.content, 'GlideRecord') // Untouched inline code
  assert.equal(runs[5].annotations.italic, true)
  assert.equal(runs[5].text.link.url, 'https://docs.servicenow.com')
  assert.equal(runs[6].type, 'equation')
  assert.equal(runs[6].equation.expression, 'O(\\log n)')

  // Check to_do checked state and color
  const todoNode = builtTree.find(n => n.id === 'blk-todo-1')
  assert.equal(todoNode.raw.to_do.checked, true)
  assert.equal(todoNode.raw.to_do.color, 'green')

  // Check callout icon, color, and translated child
  const calloutNode = builtTree.find(n => n.id === 'blk-callout-1')
  assert.equal(calloutNode.raw.callout.icon.emoji, '💡')
  assert.equal(calloutNode.raw.callout.color, 'yellow_background')
  assert.equal(
    calloutNode.children[0].raw.paragraph.rich_text[0].text.content,
    '[VI] Check system logs before promoting Update Sets.'
  )

  // Check code block untouched
  const codeNode = builtTree.find(n => n.id === 'blk-code-1')
  assert.equal(
    codeNode.raw.code.rich_text[0].text.content,
    "var gr = new GlideRecord('cmdb_ci_server');\ngr.addQuery('operational_status', 1);\ngr.query();"
  )
  assert.equal(codeNode.raw.code.language, 'javascript')

  // Check equation block untouched
  const eqNode = builtTree.find(n => n.id === 'blk-eq-1')
  assert.equal(eqNode.raw.equation.expression, 'E = mc^2 + \\sum_{i=1}^{n} x_i')
})

// ── Test 6: Writer handles pagination and chunking (>100 blocks) ──────────────
test('6. Writer chunks block appends into batches of at most 100 blocks', async () => {
  const sourcePage = createSampleSourcePage()
  // Generate 235 top-level paragraph blocks
  const largeBlockList = Array.from({ length: 235 }, (_, idx) => ({
    id: `blk-large-${idx + 1}`,
    type: 'paragraph',
    has_children: false,
    paragraph: {
      rich_text: [makeRichTextRun(`Sentence number ${idx + 1}`)],
      color: 'default',
    },
  }))

  const env = createMockNotionEnvironment({
    initialPages: [sourcePage],
    blocksByParentId: { [sourcePage.id]: largeBlockList },
  })

  const rawTree = await readRawNotionTree(sourcePage.id, { client: env.client, logger: silentLogger })
  const manifest = extractTranslationManifest(rawTree, { sourcePage })
  const translationResult = await translateManifest(manifest, 'vi', {
    aiAdapter: createMockAiAdapter(),
    batchSize: 100,
    maxBatchChars: 50000,
    logger: silentLogger,
  })
  const translatedTree = buildTranslatedBlockTree(rawTree, translationResult)
  const pagePropertiesPayload = buildTranslatedPageProperties(sourcePage, { properties: {} }, translationResult, {
    targetLocale: 'vi',
    translationGroupId: 'cmdb-group-001',
  })

  const writeRes = await createTranslatedNotionPage(sourcePage, translatedTree, {
    client: env.client,
    dataSourceInfo: { databaseId: 'db-articles-001', dataSourceId: 'ds-articles-001', properties: {} },
    pagePropertiesPayload,
    maxBlocksPerAppend: 100,
    logger: silentLogger,
  })

  assert.ok(writeRes.targetPage.id)
  // 235 blocks with max 100 per append -> 3 append calls (100, 100, 35)
  assert.equal(env.appendCalls.length, 3)
  assert.deepEqual(
    env.appendCalls.map(c => c.count),
    [100, 100, 35]
  )
})

// ── Test 7: Existing translation prevents duplicate creation ──────────────────
test('7. Existing Vietnamese translation with the same Translation Group ID prevents duplicate page creation', async () => {
  const sourcePage = createSampleSourcePage({
    id: 'page-en-dup',
    translationGroupId: 'group-cmdb-999',
    translationStatus: 'Requested',
  })
  const existingViPage = createSampleSourcePage({
    id: 'page-vi-existing',
    title: 'Tìm hiểu Kiến trúc CMDB và IRE',
    slug: 'tim-hieu-kien-truc-cmdb-va-ire',
    locale: 'vi',
    status: 'Draft',
    translationGroupId: 'group-cmdb-999',
    translationStatus: 'Draft Ready',
  })

  const env = createMockNotionEnvironment({
    initialPages: [sourcePage, existingViPage],
    blocksByParentId: {
      'page-en-dup': [
        {
          id: 'b1',
          type: 'paragraph',
          has_children: false,
          paragraph: { rich_text: [makeRichTextRun('Hello ServiceNow')] },
        },
      ],
      'page-vi-existing': [
        {
          id: 'b1-vi',
          type: 'paragraph',
          has_children: false,
          paragraph: { rich_text: [makeRichTextRun('Xin chào ServiceNow')] },
        },
      ],
    },
  })

  const result = await processTranslationJob(sourcePage, {
    client: env.client,
    aiAdapter: createMockAiAdapter(),
    logger: silentLogger,
  })

  assert.equal(result.duplicatePrevented, true)
  assert.equal(result.status, TRANSLATION_STATUS.NEEDS_REVIEW)
  assert.equal(result.targetPageId, 'page-vi-existing')
  assert.equal(env.pageCreateCalls.length, 0, 'Must not create a duplicate Notion page')

  const updatedSource = env.pages.get('page-en-dup')
  assert.equal(
    updatedSource.properties['Translation Status'].select.name,
    TRANSLATION_STATUS.NEEDS_REVIEW
  )
  assert.equal(
    updatedSource.properties['Translation Target Page ID'].rich_text[0].plain_text,
    'page-vi-existing'
  )
  assert.match(
    updatedSource.properties['Translation Error'].rich_text[0].plain_text,
    /Duplicate Prevented/
  )
})

// ── Test 8: Failed jobs do not silently lose state ────────────────────────────
test('8. Failed jobs record Failed status, error details, and preserve created Translation Target Page ID', async () => {
  const sourcePage = createSampleSourcePage({
    id: 'page-en-fail',
    translationGroupId: 'group-fail-001',
    translationStatus: 'Requested',
  })

  // Simulate failure on the very first blocks.children.append call after the target page shell is created
  const env = createMockNotionEnvironment({
    initialPages: [sourcePage],
    blocksByParentId: {
      'page-en-fail': [
        {
          id: 'b-fail-1',
          type: 'paragraph',
          has_children: false,
          paragraph: { rich_text: [makeRichTextRun('Paragraph that will fail to append.')] },
        },
      ],
    },
    failOnAppendBatchNumber: 1,
  })

  const result = await processTranslationJob(sourcePage, {
    client: env.client,
    aiAdapter: createMockAiAdapter(),
    logger: silentLogger,
  })

  assert.equal(result.status, TRANSLATION_STATUS.FAILED)
  assert.ok(result.targetPageId, 'Created target page ID must be retained')

  const updatedSource = env.pages.get('page-en-fail')
  assert.equal(
    updatedSource.properties['Translation Status'].select.name,
    TRANSLATION_STATUS.FAILED
  )
  assert.equal(
    updatedSource.properties['Translation Target Page ID'].rich_text[0].plain_text,
    result.targetPageId
  )
  assert.match(
    updatedSource.properties['Translation Error'].rich_text[0].plain_text,
    /Simulated Notion API failure/
  )
})

// ── Test 9: Restarting the worker recovers pending/stale jobs safely ──────────
test('9. Restarting the worker recovers stale Processing jobs safely without creating duplicate pages', async () => {
  const staleTimestamp = new Date(Date.now() - 45 * 60 * 1000).toISOString() // 45 mins ago (> 30m threshold)
  const staleSourcePage = createSampleSourcePage({
    id: 'page-en-stale',
    translationGroupId: 'group-stale-001',
    translationStatus: 'Processing',
    translationTargetPageId: 'page-vi-empty-shell',
    translationUpdatedAt: staleTimestamp,
  })
  // Empty shell page created right before previous worker process crashed (0 blocks)
  const emptyShellViPage = createSampleSourcePage({
    id: 'page-vi-empty-shell',
    title: 'Placeholder',
    slug: 'placeholder-vi',
    locale: 'vi',
    status: 'Draft',
    translationGroupId: 'group-stale-001',
    translationStatus: 'Processing',
  })

  const env = createMockNotionEnvironment({
    initialPages: [staleSourcePage, emptyShellViPage],
    blocksByParentId: {
      'page-en-stale': [
        {
          id: 'blk-stale-p1',
          type: 'paragraph',
          has_children: false,
          paragraph: { rich_text: [makeRichTextRun('Recovered paragraph content.')] },
        },
      ],
      'page-vi-empty-shell': [], // 0 blocks -> safe to resume into this shell!
    },
  })

  const cycleResult = await runPollCycle({
    client: env.client,
    aiAdapter: createMockAiAdapter(),
    config: getTranslationConfig({
      notionToken: 'ntn_test_token',
      translationDatabaseId: 'db-articles-001',
      aiApiKey: 'sk-test-key',
      staleTimeoutMs: 30 * 60 * 1000,
    }),
    logger: silentLogger,
  })

  assert.equal(cycleResult.recoveredCount, 1)
  assert.equal(cycleResult.recoveredJobs[0].action, 'resumed_empty_shell')
  assert.equal(cycleResult.recoveredJobs[0].status, TRANSLATION_STATUS.DRAFT_READY)
  assert.equal(cycleResult.recoveredJobs[0].targetPageId, 'page-vi-empty-shell')
  assert.equal(env.pageCreateCalls.length, 0, 'Must reuse empty shell page rather than creating a 2nd page')

  const populatedBlocks = env.childrenMap.get('page-vi-empty-shell')
  assert.equal(populatedBlocks.length, 1)
  assert.equal(
    populatedBlocks[0].paragraph.rich_text[0].text.content,
    '[VI] Recovered paragraph content.'
  )
})

// ── Test 10: Vietnamese output remains Draft & end-to-end workflow succeeds ───
test('10. End-to-end workflow creates Vietnamese page with Status = Draft, Locale = vi, same Translation Group ID, and updates source to Draft Ready', async () => {
  const sourcePage = createSampleSourcePage({
    id: 'page-en-e2e',
    status: 'Published', // Source is Published
    locale: null,        // Missing locale -> defaults to 'en'
    translationGroupId: '', // Missing group ID -> worker generates UUID and updates source
    translationStatus: 'Requested',
  })
  const { topLevelBlocks, childrenByParentId } = createComprehensiveBlockFixtures()

  const env = createMockNotionEnvironment({
    initialPages: [sourcePage],
    blocksByParentId: {
      'page-en-e2e': topLevelBlocks,
      ...childrenByParentId,
    },
  })

  const result = await processTranslationJob(sourcePage, {
    client: env.client,
    aiAdapter: createMockAiAdapter(),
    generateUuid: () => 'generated-uuid-12345',
    logger: silentLogger,
  })

  assert.equal(result.status, TRANSLATION_STATUS.DRAFT_READY)
  assert.equal(result.targetStatus, 'Draft')
  assert.equal(result.targetLocale, 'vi')
  assert.equal(result.translationGroupId, 'generated-uuid-12345')
  assert.equal(result.validation.valid, true)

  const createdViPage = env.pages.get(result.targetPageId)
  assert.ok(createdViPage)

  // Verify Target Page Properties
  assert.equal(
    createdViPage.properties.Status.status.name,
    'Draft',
    'Translated Vietnamese page MUST remain Draft even when English source is Published'
  )
  assert.equal(createdViPage.properties.Locale.select.name, 'vi')
  assert.equal(
    createdViPage.properties['Translation Group ID'].rich_text[0].plain_text,
    'generated-uuid-12345'
  )

  // Verify Source Page Properties updated
  const updatedSourcePage = env.pages.get('page-en-e2e')
  assert.equal(
    updatedSourcePage.properties['Translation Group ID'].rich_text[0].plain_text,
    'generated-uuid-12345'
  )
  assert.equal(
    updatedSourcePage.properties['Translation Status'].select.name,
    TRANSLATION_STATUS.DRAFT_READY
  )
  assert.equal(
    updatedSourcePage.properties['Translation Target Page ID'].rich_text[0].plain_text,
    result.targetPageId
  )
})

// ── Bonus Test 11: Single-instance lock prevents concurrent worker startup ────
test('11. Local single-instance lock prevents second worker from starting while first is active', () => {
  const tmpLockPath = path.join(os.tmpdir(), `notion-worker-test-${process.pid}-${Date.now()}.lock`)
  const lock1 = acquireWorkerLock(tmpLockPath, silentLogger)
  try {
    assert.equal(lock1.acquired, true)
    assert.throws(
      () => acquireWorkerLock(tmpLockPath, silentLogger),
      /Another translation worker instance is already running/
    )
  } finally {
    lock1.release()
    assert.equal(fs.existsSync(tmpLockPath), false)
  }
})

// ── Bonus Test 12: Notion-hosted image re-upload & missing media handling ─────
test('12. Writer re-uploads Notion-hosted expiring images via File Upload API and marks Needs Review if an asset fails', async () => {
  const sourcePage = createSampleSourcePage({ id: 'page-en-media', translationGroupId: 'grp-media-1' })
  const blocks = [
    {
      id: 'blk-img-hosted-ok',
      type: 'image',
      has_children: false,
      image: {
        type: 'file',
        file: {
          url: 'https://prod-files-secure.s3.us-west-2.amazonaws.com/ok-diagram.png?X-Amz-Expires=3600',
          expiry_time: '2026-11-05T17:00:00.000Z',
        },
        caption: [makeRichTextRun('Hosted CMDB diagram')],
      },
    },
    {
      id: 'blk-img-hosted-broken',
      type: 'image',
      has_children: false,
      image: {
        type: 'file',
        file: {
          url: 'https://prod-files-secure.s3.us-west-2.amazonaws.com/expired-diagram.png?X-Amz-Expires=3600',
          expiry_time: '2026-11-05T15:00:00.000Z',
        },
        caption: [makeRichTextRun('Expired diagram')],
      },
    },
  ]

  const env = createMockNotionEnvironment({
    initialPages: [sourcePage],
    blocksByParentId: { 'page-en-media': blocks },
  })

  const uploadedFiles = []
  env.client.fileUploads = {
    create: async ({ filename, content_type }) => ({
      id: `upload-id-${uploadedFiles.length + 1}`,
      filename,
      content_type,
      status: 'pending',
    }),
    send: async ({ file_upload_id, file }) => {
      uploadedFiles.push({ file_upload_id, filename: file.filename })
      return { id: file_upload_id, status: 'uploaded' }
    },
  }

  const mockFetch = async (url) => {
    if (String(url).includes('expired-diagram.png')) {
      return { ok: false, status: 403, statusText: 'Forbidden' }
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
    }
  }

  const result = await processTranslationJob(sourcePage, {
    client: env.client,
    aiAdapter: createMockAiAdapter(),
    fetchImpl: mockFetch,
    logger: silentLogger,
  })

  // 1 image succeeded via fileUploads, 1 expired image recorded in missingMedia -> Needs Review
  assert.equal(uploadedFiles.length, 1)
  assert.equal(uploadedFiles[0].file_upload_id, 'upload-id-1')
  assert.equal(result.status, TRANSLATION_STATUS.NEEDS_REVIEW)
  assert.equal(result.validation.missingMedia.length, 1)
  assert.equal(result.validation.missingMedia[0].id, 'blk-img-hosted-broken')

  const targetBlocks = env.childrenMap.get(result.targetPageId)
  assert.equal(targetBlocks.length, 1, 'Broken image must not be silently created')
  assert.equal(targetBlocks[0].image.file_upload.id, 'upload-id-1')
})

// ── Bonus Test 13: Unsupported blocks, synced_block, and child_page reporting ─
test('13. Unsupported blocks, synced_block, and child_page are reported and mark job as Needs Review', async () => {
  const sourcePage = createSampleSourcePage({ id: 'page-en-special', translationGroupId: 'grp-spec-1' })
  const blocks = [
    {
      id: 'blk-synced-1',
      type: 'synced_block',
      has_children: true,
      synced_block: { synced_from: null },
    },
    {
      id: 'blk-child-page-1',
      type: 'child_page',
      has_children: false,
      child_page: { title: 'Sub-lesson: IRE Payload Rules' },
    },
    {
      id: 'blk-unsupported-widget',
      type: 'unsupported',
      has_children: false,
      unsupported: {},
    },
  ]

  const env = createMockNotionEnvironment({
    initialPages: [sourcePage],
    blocksByParentId: {
      'page-en-special': blocks,
      'blk-synced-1': [
        {
          id: 'blk-synced-child-p',
          type: 'paragraph',
          has_children: false,
          paragraph: { rich_text: [makeRichTextRun('Shared warning note across articles.')] },
        },
      ],
    },
  })

  const result = await processTranslationJob(sourcePage, {
    client: env.client,
    aiAdapter: createMockAiAdapter(),
    logger: silentLogger,
  })

  assert.equal(result.status, TRANSLATION_STATUS.NEEDS_REVIEW)
  assert.equal(result.validation.fidelity100Percent, false)
  assert.equal(result.report.unsupportedBlocks.length, 1)
  assert.equal(result.report.syncedBlocks.length, 1)
  assert.equal(result.report.linkedResources.length, 1)
  assert.match(result.report.concisePropertySummary, /Unsupported blocks/)
})

