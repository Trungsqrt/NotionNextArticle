import { getAllPosts } from '../../lib/notion'

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://notion-next-article-pink.vercel.app'
const AUTHOR = 'Jun Mai - Trungsqrt'

export const revalidate = 3600

export async function GET() {
  let posts = []
  try {
    posts = await getAllPosts()
  } catch (err) {
    console.error('Failed to fetch posts for llms.txt:', err)
  }

  const published = posts.filter(p => {
    const status = (p.status || '').toLowerCase()
    return status !== 'draft' && status !== 'archived' && status !== 'hidden'
  })

  // Format articles into structured markdown list for LLM parsing
  const articlesList = published
    .map(p => {
      const slug = p.slug || p.id
      const url = `${SITE_URL}/${slug}`
      const desc = p.summary ? `: ${p.summary}` : ''
      const tags = (p.tags && p.tags.length > 0) ? ` [Tags: ${p.tags.join(', ')}]` : ''
      return `- [${p.title || 'Lesson'}](${url})${tags}${desc}`
    })
    .join('\n')

  const content = `# ServiceNow Knowledge Hub
> A serene learning space for mastering ServiceNow with calm clarity — curated architecture notes, CSDM/CMDB labs, performance deep-dives, and reference cards.

- **Author / Curator:** ${AUTHOR}
- **Website:** ${SITE_URL}
- **Topics:** ServiceNow Architecture, CSDM 4.0, CMDB Health & IRE, ITSM, ITOM, High-Performance Scripting, GlideRecord Best Practices, Zen Minimalist Learning.

## Published Lessons & Reference Guides

${articlesList || '- Full lesson catalogue available on website.'}

## Knowledge Base Scope & Purpose

This knowledge space is created by ${AUTHOR} to provide concise, production-tested guidance for ServiceNow developers, administrators, and architects. All articles are organized into structured modules, labs, and quick-reference notes with code snippets and architectural diagrams.
`

  return new Response(content, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
    },
  })
}
