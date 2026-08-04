import { NotionAPI } from 'notion-client'
import { getPageTitle, getPageProperty } from 'notion-utils'

const notion = new NotionAPI({
  authToken: process.env.NOTION_TOKEN
})

/**
 * Fetches the root database and extracts all child pages (courses).
 */
export async function getAllPosts() {
  const rootId = process.env.NOTION_ROOT_PAGE_ID
  if (!rootId) {
    console.warn('NOTION_ROOT_PAGE_ID is not defined in environment.')
    return []
  }

  try {
    const recordMap = await notion.getPage(rootId)
    const collectionIds = Object.keys(recordMap.collection || {})
    
    if (collectionIds.length === 0) {
      console.warn('No collection (database) found on the root Notion page.')
      return []
    }
    
    const collectionId = collectionIds[0]
    
    // Find all blocks of type 'page' that are children of the collection
    const pageBlocks = Object.values(recordMap.block)
      .map(b => b.value)
      .filter(b => b?.type === 'page' && b?.parent_id === collectionId)

    const courses = pageBlocks.map(block => {
      const title = getPageTitle(block, recordMap) || 'Untitled'
      
      // Try to parse a 'slug' property, otherwise slugify the title
      let slug = getPageProperty('slug', block, recordMap)
      if (Array.isArray(slug)) slug = slug.join('')
      if (typeof slug !== 'string' || !slug) {
        slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '')
      }

      // Parse tags (multi-select properties are often returned as arrays or comma-separated strings)
      let tags = getPageProperty('tags', block, recordMap) || getPageProperty('Tags', block, recordMap) || []
      if (typeof tags === 'string') tags = tags.split(',').map(s => s.trim())
      
      // Other properties based on mock data fields
      const summary = getPageProperty('summary', block, recordMap) || getPageProperty('Summary', block, recordMap) || ''
      const difficulty = getPageProperty('difficulty', block, recordMap) || getPageProperty('Difficulty', block, recordMap) || 'Beginner'
      const duration = getPageProperty('duration', block, recordMap) || getPageProperty('Duration', block, recordMap) || '30 min'
      const dateVal = getPageProperty('date', block, recordMap) || getPageProperty('Date', block, recordMap)
      const date = dateVal ? new Date(dateVal).toISOString() : new Date(block.created_time).toISOString()

      return {
        id: block.id,
        slug,
        title,
        summary,
        tags,
        icon: block.format?.page_icon || '📄',
        difficulty,
        duration,
        date,
        cover: block.format?.page_cover || null,
      }
    })
    
    return courses
  } catch (error) {
    console.error('Failed to fetch posts from Notion:', error)
    return []
  }
}

/**
 * Finds a page by its slug, then fetches its full recordMap.
 */
export async function getPageBySlug(slug) {
  const posts = await getAllPosts()
  const post = posts.find(p => p.slug === slug)
  
  if (!post || !post.id) {
    return null
  }
  
  try {
    const recordMap = await notion.getPage(post.id)
    return {
      recordMap,
      ...post
    }
  } catch (error) {
    console.error(`Failed to fetch Notion page for slug ${slug}:`, error)
    return null
  }
}

/**
 * Re-exports notion client instance just in case
 */
export { notion }
