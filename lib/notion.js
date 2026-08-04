import { NotionAPI } from 'notion-client'
import { getBlockTitle, getPageProperty } from 'notion-utils'

const notion = new NotionAPI({
  authToken: process.env.NOTION_TOKEN_V2 || process.env.NOTION_TOKEN
})

/**
 * Removes undefined fields so Next.js getStaticProps can serialize to JSON.
 */
function sanitizeJSON(obj) {
  return JSON.parse(JSON.stringify(obj, (key, value) => {
    return value === undefined ? null : value
  }))
}

/**
 * Normalizes Notion API recordMap structures by unwrapping nested .value properties.
 */
function cleanRecordMap(recordMap) {
  if (!recordMap) return { block: {}, collection: {}, collection_view: {}, collection_query: {}, notion_user: {} }

  const clean = {
    block: {},
    collection: {},
    collection_view: {},
    collection_query: recordMap.collection_query || {},
    notion_user: recordMap.notion_user || {},
    signed_urls: recordMap.signed_urls || {}
  }

  const unwrap = (obj) => {
    if (!obj) return null
    let val = obj
    while (val && val.value && typeof val.value === 'object' && !val.schema && !val.type) {
      val = val.value
    }
    return val
  }

  if (recordMap.block) {
    for (const key of Object.keys(recordMap.block)) {
      const val = unwrap(recordMap.block[key])
      if (val && val.id) clean.block[val.id] = { value: val }
    }
  }
  if (recordMap.collection) {
    for (const key of Object.keys(recordMap.collection)) {
      const val = unwrap(recordMap.collection[key])
      if (val && val.id) clean.collection[val.id] = { value: val }
    }
  }
  if (recordMap.collection_view) {
    for (const key of Object.keys(recordMap.collection_view)) {
      const val = unwrap(recordMap.collection_view[key])
      if (val && val.id) clean.collection_view[val.id] = { value: val }
    }
  }

  return clean
}

/**
 * Safely merges block maps without losing child block content or properties.
 */
function mergeBlocks(existingBlocks = {}, incomingBlocks = {}) {
  const merged = { ...existingBlocks }
  for (const id of Object.keys(incomingBlocks)) {
    const existing = merged[id]
    const incoming = incomingBlocks[id]
    if (!existing) {
      merged[id] = incoming
    } else {
      const existingVal = existing.value || {}
      const incomingVal = incoming.value || {}
      const content = (existingVal.content && existingVal.content.length > 0)
        ? existingVal.content
        : incomingVal.content
      const mergedVal = {
        ...existingVal,
        ...incomingVal,
        properties: { ...existingVal.properties, ...incomingVal.properties },
      }
      if (content) mergedVal.content = content
      else delete mergedVal.content
      merged[id] = { ...existing, ...incoming, value: mergedVal }
    }
  }
  return merged
}

/**
 * Finds all [collectionId, viewId] pairs present in a recordMap that need fetching.
 * Scans all view_ids on each collection_view block so every gallery view is covered.
 */
function getCollectionPairs(recordMap) {
  const pairs = []
  const seen = new Set()

  for (const entry of Object.values(recordMap.block || {})) {
    const b = entry.value
    if (!b) continue
    if (b.type === 'collection_view' || b.type === 'collection_view_page') {
      const colId = b.collection_id || b.format?.collection_pointer?.id
      const viewIds = b.view_ids || []
      for (const viewId of viewIds) {
        if (colId && viewId) {
          const key = `${colId}:${viewId}`
          if (!seen.has(key)) {
            seen.add(key)
            pairs.push({ colId, viewId })
          }
        }
      }
    }
  }

  // Fallback: if no blocks found, try first collection/view pair
  const colIds = Object.keys(recordMap.collection || {})
  const viewIds = Object.keys(recordMap.collection_view || {})
  if (pairs.length === 0 && colIds.length > 0 && viewIds.length > 0) {
    pairs.push({ colId: colIds[0], viewId: viewIds[0] })
  }

  return pairs
}

/**
 * Iteratively fetches all collections and inline sub-collections.
 *
 * ROOT CAUSE FIX: populates collection_query[colId][viewId].blockIds so that
 * react-notion-x <Collection /> knows which gallery cards to render.
 * Without this, collection_query stays empty and the gallery is blank.
 */
async function fetchAllCollections(initialRecordMap) {
  let mergedRecordMap = cleanRecordMap(initialRecordMap)
  const fetchedPairs = new Set()
  let shouldContinue = true
  let depth = 0
  const maxDepth = 5

  while (shouldContinue && depth < maxDepth) {
    shouldContinue = false
    depth++
    const pairs = getCollectionPairs(mergedRecordMap)

    for (const { colId, viewId } of pairs) {
      const pairKey = `${colId}:${viewId}`
      if (fetchedPairs.has(pairKey)) continue
      fetchedPairs.add(pairKey)

      try {
        const colData = await notion.getCollectionData(colId, viewId)
        if (!colData?.recordMap) continue

        const cleaned = cleanRecordMap(colData.recordMap)

        // Extract blockIds from whatever shape notion-client returns
        const blockIds =
          colData.result?.blockIds ||
          colData.result?.reducerResults?.collection_group_results?.blockIds ||
          colData.result?.reducerResults?.collection_query?.blockIds ||
          []

        // Merge collection_query: this is what Collection component reads to get card list
        const cq = { ...(mergedRecordMap.collection_query || {}) }
        if (!cq[colId]) cq[colId] = {}
        cq[colId][viewId] = { blockIds, total: blockIds.length }

        mergedRecordMap = {
          ...mergedRecordMap,
          block: mergeBlocks(mergedRecordMap.block, cleaned.block),
          collection: { ...mergedRecordMap.collection, ...cleaned.collection },
          collection_view: { ...mergedRecordMap.collection_view, ...cleaned.collection_view },
          collection_query: { ...(cleaned.collection_query || {}), ...cq },
        }
        shouldContinue = true
      } catch (err) {
        console.warn(`Failed to fetch collection data for ${pairKey}:`, err.message)
      }
    }
  }

  return sanitizeJSON(mergedRecordMap)
}

/**
 * Resolves any child block UUIDs referenced in block.content that were not fetched.
 * Crucial for Toggle blocks where children are not eagerly loaded.
 */
async function resolveMissingBlocks(recordMap, notion, maxDepth = 3) {
  let depth = 0;
  while (depth < maxDepth) {
    const existingIds = new Set(Object.keys(recordMap.block || {}));
    const missingIds = new Set();

    for (const blockId of existingIds) {
      const block = recordMap.block[blockId]?.value;
      if (block && Array.isArray(block.content)) {
        for (const childId of block.content) {
          if (!existingIds.has(childId)) {
            missingIds.add(childId);
          }
        }
      }
    }

    if (missingIds.size === 0) {
      console.log(`[Notion-Debug] All blocks resolved at depth ${depth}.`);
      break;
    }

    const missingArray = Array.from(missingIds);
    console.log(`[Notion-Debug] Depth ${depth + 1}: Fetching ${missingArray.length} missing blocks in batches of 30...`);
    
    let addedCount = 0;
    let deniedCount = 0;

    for (let i = 0; i < missingArray.length; i += 30) {
      const batch = missingArray.slice(i, i + 30);
      try {
        const fetched = await notion.getBlocks(batch);

        let blockList = [];
        if (Array.isArray(fetched)) {
          blockList = fetched;
        } else if (fetched && Array.isArray(fetched.results)) {
          blockList = fetched.results;
        } else if (fetched && fetched.recordMap && fetched.recordMap.block) {
          blockList = Object.values(fetched.recordMap.block);
        } else if (fetched && fetched.block) {
          blockList = Object.values(fetched.block);
        } else if (fetched && typeof fetched === "object") {
          blockList = Object.values(fetched);
        }

        for (const item of blockList) {
          if (!item) continue;
          if (item.role === "none") {
            deniedCount++;
            continue;
          }

          // CRITICAL FIX: Unwrap double-nested .value.value from notion-client
          const val = item.value?.value || item.value || item;
          if (val && val.id) {
            recordMap.block[val.id] = {
              role: item.role || "editor",
              value: val
            };
            addedCount++;
          }
        }
      } catch (err) {
        console.error(`[Notion-Debug] Batch fetch error (${i} to ${i + 30}):`, err.message || err);
      }
    }

    console.log(`[Notion-Debug] Depth ${depth + 1}: Successfully merged ${addedCount} blocks. (Access Denied / role:none = ${deniedCount})`);
    
    if (addedCount === 0) break;
    depth++;
  }
  return recordMap;
}

/**
 * Extracts the text title from a page block.
 */
function extractTitle(block, recordMap) {
  const titleFromUtils = getBlockTitle(block, recordMap)
  if (titleFromUtils) return titleFromUtils

  if (block.crdt_data?.title?.n) {
    const nodes = block.crdt_data.title.n
    for (const k of Object.keys(nodes)) {
      if (nodes[k]?.s?.i) {
        for (const item of nodes[k].s.i) {
          if (item.c) return item.c
        }
      }
    }
  }

  return 'Untitled'
}

/**
 * Parses a raw Notion page block into a standardized post object.
 */
function parsePageBlock(block, mergedRecordMap) {
  const title = extractTitle(block, mergedRecordMap)

  let slug = getPageProperty('slug', block, mergedRecordMap) || getPageProperty('Slug', block, mergedRecordMap)
  if (Array.isArray(slug)) slug = slug.join('')
  if (typeof slug !== 'string' || !slug) {
    slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '') || block.id.replace(/-/g, '')
  }

  let tags = getPageProperty('tags', block, mergedRecordMap) || getPageProperty('Tags', block, mergedRecordMap) || []
  if (typeof tags === 'string') tags = tags.split(',').map(s => s.trim())

  const summary = getPageProperty('summary', block, mergedRecordMap) || getPageProperty('Summary', block, mergedRecordMap) || ''
  const difficulty = getPageProperty('difficulty', block, mergedRecordMap) || getPageProperty('Difficulty', block, mergedRecordMap) || 'Beginner'
  const duration = getPageProperty('duration', block, mergedRecordMap) || getPageProperty('Duration', block, mergedRecordMap) || '30 min'
  const category = getPageProperty('category', block, mergedRecordMap) || getPageProperty('Category', block, mergedRecordMap) || 'General'
  const status = getPageProperty('status', block, mergedRecordMap) || getPageProperty('Status', block, mergedRecordMap) || 'Published'
  const type = getPageProperty('type', block, mergedRecordMap) || getPageProperty('Type', block, mergedRecordMap) || 'Post'
  const dateVal = getPageProperty('date', block, mergedRecordMap) || getPageProperty('Date', block, mergedRecordMap)
  const date = dateVal ? new Date(dateVal).toISOString() : new Date(block.created_time).toISOString()

  let rawCover = block.format?.page_cover || null
  let cover = null
  if (rawCover && (rawCover.startsWith('http://') || rawCover.startsWith('https://') || rawCover.startsWith('/'))) {
    cover = rawCover
  }

  return {
    id: block.id,
    slug,
    title,
    summary,
    tags,
    icon: block.format?.page_icon || 'file',
    difficulty,
    duration,
    date,
    category,
    status,
    type,
    cover,
    parentId: block.parent_id || null,
    parentTable: block.parent_table || null,
  }
}



// ─────────────────────────────────────────────────────────────
//  Public API
// ─────────────────────────────────────────────────────────────

/**
 * Returns only the direct items of the root database (for the home catalog).
 */
export async function getAllPosts() {
  const rootId = process.env.NOTION_ROOT_PAGE_ID
  if (!rootId) {
    console.warn('NOTION_ROOT_PAGE_ID is not defined in environment.')
    return []
  }

  try {
    const rawRootRecordMap = await notion.getPage(rootId, { fetchMissingBlocks: true, fetchCollections: true })
    const rootRecordMap = cleanRecordMap(rawRootRecordMap)

    const collectionIds = Object.keys(rootRecordMap.collection || {})
    const collectionViewIds = Object.keys(rootRecordMap.collection_view || {})

    let mergedRecordMap = rootRecordMap
    let rootCollectionId = null

    if (collectionIds.length > 0 && collectionViewIds.length > 0) {
      rootCollectionId = collectionIds[0]
      const collectionViewId = collectionViewIds[0]
      try {
        const collectionData = await notion.getCollectionData(rootCollectionId, collectionViewId)
        const cleanedColRecordMap = cleanRecordMap(collectionData.recordMap)
        mergedRecordMap = {
          ...rootRecordMap,
          block: mergeBlocks(rootRecordMap.block, cleanedColRecordMap.block),
          collection: { ...rootRecordMap.collection, ...cleanedColRecordMap.collection },
          collection_view: { ...rootRecordMap.collection_view, ...cleanedColRecordMap.collection_view },
        }
      } catch (colErr) {
        console.warn('Failed to fetch root collection data:', colErr)
      }
    }

    const cleanRootId = rootId.replace(/-/g, '')
    const cleanRootCollectionId = rootCollectionId ? rootCollectionId.replace(/-/g, '') : null

    const pageBlocks = Object.values(mergedRecordMap.block)
      .map(b => b.value)
      .filter(b => {
        if (!b || b.type !== 'page') return false
        const cleanId = b.id.replace(/-/g, '')
        if (cleanId === cleanRootId) return false
        const cleanParentId = b.parent_id ? b.parent_id.replace(/-/g, '') : ''
        return cleanParentId === cleanRootCollectionId || cleanParentId === cleanRootId
      })

    return pageBlocks.map(block => parsePageBlock(block, mergedRecordMap))
  } catch (error) {
    console.error('Failed to fetch posts from Notion:', error)
    return []
  }
}

/**
 * Returns all posts across all collection levels (for slug resolution / URL map building).
 */
export async function getAllPostsAllLevels() {
  const rootId = process.env.NOTION_ROOT_PAGE_ID
  if (!rootId) return []

  try {
    const rawRootRecordMap = await notion.getPage(rootId, { fetchMissingBlocks: true, fetchCollections: true })
    const mergedRecordMap = await fetchAllCollections(rawRootRecordMap)

    const cleanRootId = rootId.replace(/-/g, '')
    const pageBlocks = Object.values(mergedRecordMap.block)
      .map(b => b.value)
      .filter(b => b && b.type === 'page' && b.id.replace(/-/g, '') !== cleanRootId)

    return pageBlocks.map(block => parsePageBlock(block, mergedRecordMap))
  } catch (err) {
    console.error('Failed to fetch all posts at all levels:', err)
    return []
  }
}

/**
 * Finds a page by slug or raw Notion ID, fetches its full content (including
 * inline sub-collections), and returns both the recordMap and a urlMap for
 * hierarchical link resolution.
 */
export async function getPageBySlug(slug) {
  const rootId = process.env.NOTION_ROOT_PAGE_ID

  let posts = await getAllPosts()
  let post = posts.find(p => p.slug === slug || p.id.replace(/-/g, '') === slug)

  if (!post) {
    const allPosts = await getAllPostsAllLevels()
    post = allPosts.find(p => p.slug === slug || p.id.replace(/-/g, '') === slug)
  }

  let rawRecordMap;

  if (post?.id) {
    try {
      rawRecordMap = await notion.getPage(post.id, { fetchMissingBlocks: true, fetchCollections: true })
    } catch (e) {
      console.error(`Failed to fetch Notion page for post id ${post.id}:`, e)
      return null
    }
  } else {
    // FALLBACK: If not found in DB slug map, try fetching directly as a Notion Page ID/UUID
    try {
      rawRecordMap = await notion.getPage(slug, { fetchMissingBlocks: true, fetchCollections: true })
      
      // Create a synthetic post object so the page renders correctly
      const pageBlock = Object.values(rawRecordMap.block).find(b => b.value?.type === 'page')?.value
      if (pageBlock) {
        post = parsePageBlock(pageBlock, cleanRecordMap(rawRecordMap))
      } else {
        post = { id: slug, title: 'Lesson' }
      }
    } catch (error) {
      console.error("Page not found by slug or ID:", slug)
      return null
    }
  }

  try {
    const recordMap = await fetchAllCollections(rawRecordMap)
    await resolveMissingBlocks(recordMap, notion)

    return {
      recordMap: sanitizeJSON(recordMap),
      ...post,
    }
  } catch (error) {
    console.error(`Failed to process Notion page for slug ${slug}:`, error)
    return null
  }
}

export { notion }
