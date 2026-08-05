import { Client } from "@notionhq/client"
import { NotionRenderer } from "@notion-render/client"
import hljsPlugin from "@notion-render/hljs-plugin"

const notion = new Client({
  auth: process.env.NOTION_API_SECRET || process.env.NOTION_TOKEN || process.env.NOTION_TOKEN_V2,
})

const renderer = new NotionRenderer({
  client: notion,
})
renderer.use(hljsPlugin({}))

export async function getChildBlocks(blockId) {
  const blocks = []
  let cursor = undefined
  while (true) {
    const { results, next_cursor, has_more } = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
    })
    for (const block of results) {
      if (block.has_children) {
        block.children = await getChildBlocks(block.id)
      }
      blocks.push(block)
    }
    if (!has_more) break
    cursor = next_cursor
  }
  return blocks
}

export async function getNotionPageHtml(pageId) {
  const blocks = await getChildBlocks(pageId)
  return await renderer.render(...blocks)
}

function extractPageProperties(page) {
  const props = page.properties || {}

  let title = 'Untitled'
  for (const key of Object.keys(props)) {
    if (props[key].type === 'title' && props[key].title?.length > 0) {
      title = props[key].title.map(t => t.plain_text).join('')
      break
    }
  }

  let slug = ''
  if (props.Slug?.rich_text) slug = props.Slug.rich_text.map(t => t.plain_text).join('')
  else if (props.slug?.rich_text) slug = props.slug.rich_text.map(t => t.plain_text).join('')
  if (!slug) {
    slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '') || page.id.replace(/-/g, '')
  }

  let tags = []
  const tagProp = props.Tags || props.tags
  if (tagProp?.multi_select) {
    tags = tagProp.multi_select.map(item => item.name)
  } else if (tagProp?.select) {
    tags = [tagProp.select.name]
  }

  let summary = ''
  const sumProp = props.Summary || props.summary
  if (sumProp?.rich_text) {
    summary = sumProp.rich_text.map(t => t.plain_text).join('')
  }

  let cover = page.cover?.external?.url || page.cover?.file?.url || null
  let icon = page.icon?.emoji || page.icon?.external?.url || page.icon?.file?.url || null

  return {
    id: page.id,
    title,
    slug,
    tags,
    summary,
    cover,
    icon,
    date: page.last_edited_time || page.created_time,
  }
}

export async function getAllPosts() {
  const rootId = process.env.NOTION_ROOT_PAGE_ID || process.env.NOTION_DATABASE_ID
  if (!rootId) return []
  console.log('Các hàm có trong notion.databases:', Object.keys(notion.databases || {}));
  try {
    const dbRes = await notion.databases.query({ database_id: rootId })
    console.log('--- ĐÃ THẤY DATABASE, SỐ BÀI VIẾT:', dbRes.results.length)
    return dbRes.results.map(extractPageProperties)
  } catch (err) {
    console.log('--- LỖI QUERY DATABASE:', err.message)
    try {
      const { results } = await notion.blocks.children.list({ block_id: rootId })
      const pageBlocks = results.filter(b => b.type === 'child_page')
      return pageBlocks.map(b => ({
        id: b.id,
        title: b.child_page?.title || 'Lesson',
        slug: b.child_page?.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '') || b.id.replace(/-/g, ''),
        tags: ['General'],
        summary: '',
        cover: null,
        icon: '📖',
        date: b.last_edited_time || b.created_time,
      }))
    } catch (childErr) {
      console.error('Failed to fetch posts from Notion Official API:', childErr)
      return []
    }
  }
}

export async function getPageBySlug(slug) {
  const posts = await getAllPosts()
  let post = posts.find(p => p.slug === slug || p.id.replace(/-/g, '') === slug)

  let pageId = post?.id || slug

  try {
    const html = await getNotionPageHtml(pageId)
    return {
      html,
      id: pageId,
      title: post?.title || 'Lesson',
      summary: post?.summary || '',
    }
  } catch (err) {
    console.error(`Failed to fetch page by slug ${slug}:`, err)
    return null
  }
}

export { notion }
