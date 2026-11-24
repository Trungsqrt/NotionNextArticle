import { SITE_URL } from '../lib/site-url'

export default function robots() {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/', '/study', '/study/'],
      },
      // Explicitly allow and prioritize AI search engines and LLM crawlers
      {
        userAgent: [
          'GPTBot',
          'ChatGPT-User',
          'PerplexityBot',
          'ClaudeBot',
          'anthropic-ai',
          'Google-Extended',
          'Applebot-Extended',
          'CCBot',
          'cohere-ai',
        ],
        allow: '/',
        disallow: ['/api/', '/study', '/study/'],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  }
}
