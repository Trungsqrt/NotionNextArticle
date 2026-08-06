import { Client } from "@notionhq/client"
import { NotionRenderer, createBlockRenderer } from "@notion-render/client"
import hljsPlugin from "@notion-render/hljs-plugin"

const notion = new Client({
  auth: process.env.NOTION_API_SECRET || process.env.NOTION_TOKEN || process.env.NOTION_TOKEN_V2,
})

const renderer = new NotionRenderer({
  client: notion,
})
renderer.use(hljsPlugin({}))

function escapeHtml(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function getPropertyValueText(prop) {
  if (!prop) return ''
  const type = prop.type
  switch (type) {
    case 'title':
      return prop.title?.map(t => t.plain_text).join('') || ''
    case 'rich_text':
      return prop.rich_text?.map(t => t.plain_text).join('') || ''
    case 'select':
      return prop.select?.name || ''
    case 'multi_select':
      return prop.multi_select?.map(item => item.name).join(', ') || ''
    case 'number':
      return prop.number !== undefined && prop.number !== null ? String(prop.number) : ''
    case 'date':
      if (!prop.date) return ''
      return prop.date.end ? `${prop.date.start} → ${prop.date.end}` : prop.date.start
    case 'url':
      return prop.url || ''
    case 'checkbox':
      return prop.checkbox !== undefined ? (prop.checkbox ? '✓' : '✗') : ''
    case 'status':
      return prop.status?.name || ''
    case 'email':
      return prop.email || ''
    case 'phone_number':
      return prop.phone_number || ''
    case 'formula':
      if (prop.formula?.type === 'string') return prop.formula.string || ''
      if (prop.formula?.type === 'number') return prop.formula.number !== null ? String(prop.formula.number) : ''
      if (prop.formula?.type === 'boolean') return prop.formula.boolean ? '✓' : '✗'
      if (prop.formula?.type === 'date') return prop.formula.date?.start || ''
      return ''
    case 'created_time':
      return prop.created_time || ''
    case 'last_edited_time':
      return prop.last_edited_time || ''
    default:
      if (Array.isArray(prop[type])) {
        return prop[type].map(t => t.plain_text || t.name || '').join(', ')
      }
      if (typeof prop[type] === 'object' && prop[type] !== null) {
        return prop[type].name || prop[type].plain_text || ''
      }
      return prop[type] !== undefined && prop[type] !== null ? String(prop[type]) : ''
  }
}

renderer.addBlockRenderer(
  createBlockRenderer("child_database", async (block) => {
    const title = escapeHtml(block.child_database?.title || "Database")
    const rows = block.database_rows || []

    if (rows.length === 0) {
      return `
        <div class="my-6 p-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-stone-50/50 dark:bg-stone-900/50 text-neutral-500 dark:text-neutral-400 text-sm">
          <div class="font-medium text-neutral-800 dark:text-neutral-200 mb-1">${title}</div>
          <p class="italic text-xs text-neutral-400 dark:text-neutral-500">(Empty Database)</p>
        </div>
      `
    }

    const firstRowProps = rows[0]?.properties || {}
    let keys = Object.keys(firstRowProps)
    const titleKey = keys.find((k) => firstRowProps[k]?.type === "title")
    if (titleKey) {
      keys = [titleKey, ...keys.filter((k) => k !== titleKey)]
    }

    const headerHtml = keys
      .map(
        (key) =>
          `<th class="px-4 py-2.5 font-medium text-neutral-600 dark:text-neutral-400 tracking-wide text-xs uppercase text-left">${escapeHtml(key)}</th>`
      )
      .join("")

    const rowsHtml = rows
      .map((row) => {
        const props = row.properties || {}
        const cells = keys
          .map((key) => {
            const valText = getPropertyValueText(props[key])
            return `<td class="px-4 py-3 align-middle text-neutral-800 dark:text-neutral-200 whitespace-nowrap">${escapeHtml(valText)}</td>`
          })
          .join("")
        return `<tr class="border-b border-neutral-200/60 dark:border-neutral-800/60 hover:bg-stone-100/40 dark:hover:bg-stone-800/40 transition-colors last:border-b-0">${cells}</tr>`
      })
      .join("")

    return `
      <div class="my-6 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-stone-50/30 dark:bg-stone-900/30 shadow-sm overflow-hidden">
        <div class="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 font-medium text-neutral-800 dark:text-neutral-200 text-sm tracking-tight">
          ${title}
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-sm text-neutral-700 dark:text-neutral-300 border-collapse">
            <thead class="bg-stone-100/70 dark:bg-stone-800/70 border-b border-neutral-200 dark:border-neutral-800">
              <tr>${headerHtml}</tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
        </div>
      </div>
    `
  })
)

export async function getChildBlocks(blockId) {
  const blocks = []
  let cursor = undefined
  while (true) {
    const { results, next_cursor, has_more } = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
    })
    for (const block of results) {
      if (block.type === "child_database") {
        try {
          const dbInfo = await notion.databases.retrieve({ database_id: block.id })
          const dataSourceId = dbInfo.data_sources?.[0]?.id || block.id
          const dbRes = typeof notion.dataSources?.query === 'function'
            ? await notion.dataSources.query({ data_source_id: dataSourceId })
            : await notion.databases.query({ database_id: dataSourceId })
          block.database_rows = dbRes.results || []
        } catch (err) {
          console.error(`Failed to fetch child_database ${block.id}:`, err)
          block.database_rows = []
        }
      }
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
  try {
    const dbRes = typeof notion.dataSources?.query === 'function'
      ? await notion.dataSources.query({ data_source_id: rootId })
      : typeof notion.databases?.query === 'function'
        ? await notion.databases.query({ database_id: rootId })
        : await notion.request({ path: `databases/${rootId}/query`, method: 'post' })
    return dbRes.results.map(extractPageProperties)
  } catch (err) {
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
