import { getAllPosts } from '../lib/notion'

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://notion-next-article-pink.vercel.app'

// Revalidate sitemap every hour in background
export const revalidate = 3600

export default async function sitemap() {
  let posts = []
  try {
    posts = await getAllPosts()
  } catch (err) {
    console.error('Failed to generate dynamic sitemap:', err)
  }

  const validPosts = posts.filter(post => {
    const status = (post.status || '').toLowerCase()
    return status !== 'draft' && status !== 'archived' && status !== 'hidden'
  })

  const postEntries = validPosts.map(post => {
    const slug = post.slug || post.id
    const lastModified = post.date ? new Date(post.date) : new Date()
    return {
      url: `${SITE_URL}/${slug}`,
      lastModified,
      changeFrequency: 'weekly',
      priority: 0.85,
    }
  })

  return [
    {
      url: SITE_URL,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 1.0,
    },
    ...postEntries,
  ]
}
