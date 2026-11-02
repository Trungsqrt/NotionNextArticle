import { notFound } from 'next/navigation'
import { getAllPosts, getPageBySlug, getSiblingPages, getArticleTranslations } from '../../lib/notion'
import { DEFAULT_LOCALE, getLocaleMeta } from '../../lib/locales'
import NotionContent from '../../components/NotionContent'
import TableOfContents from '../../components/TableOfContents'
import ArticleCover from '../../components/ArticleCover'
import SiblingNavigation from '../../components/SiblingNavigation'
import LanguageSwitcher from '../../components/LanguageSwitcher'

// Revalidate in background every 1 hour (3600 seconds)
export const revalidate = 3600
// Allow dynamic fallback rendering for newly added articles not yet built
export const dynamicParams = true

export async function generateStaticParams() {
  try {
    const posts = await getAllPosts('all') // Fetch all published articles (every locale)
    const seen = new Set()
    return posts
      .map(post => post.slug || post.id)
      .filter(slug => slug && !seen.has(slug) && seen.add(slug))
      .map(slug => ({ slug: [slug] }))
  } catch (error) {
    console.error('Error generating static params:', error)
    return []
  }
}

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://notion-next-article-pink.vercel.app'
const AUTHOR_NAME = 'Jun Mai - Trungsqrt'

/** Decodes a URL segment (e.g. non-ASCII slugs) without throwing. */
function safeDecode(segment) {
  if (!segment) return segment
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/**
 * Builds the hreflang map ({ en: '/slug-en', vi: '/slug-vi' }) for an article.
 * Returns null when no published translation exists, so no alternate language
 * is declared for single-language articles.
 */
function buildLanguageAlternates(page, canonicalSlug, translations) {
  const available = Object.entries(translations || {}).filter(([, t]) => t?.slug)
  if (available.length === 0) return null
  const languages = {
    [getLocaleMeta(page.locale || DEFAULT_LOCALE).hreflang]: `/${canonicalSlug}`,
  }
  for (const [locale, t] of available) {
    languages[getLocaleMeta(locale).hreflang] = `/${t.slug}`
  }
  return languages
}

export async function generateMetadata({ params }) {
  const resolvedParams = await params
  const slugArray = resolvedParams?.slug || []
  const lastSlug = safeDecode(slugArray[slugArray.length - 1])
  if (!lastSlug || /\.(ico|png|jpg|jpeg|svg|css|js|txt|map|json|xml)$/i.test(lastSlug)) {
    return { title: 'ServiceNow Space · Knowledge Hub' }
  }

  try {
    const page = await getPageBySlug(lastSlug)
    if (!page) return { title: 'Lesson · ServiceNow Space' }

    const pageTitle = page.title || 'Lesson'
    const pageDesc = page.summary || `Deep dive into ${pageTitle} — curated ServiceNow architecture guides and notes by ${AUTHOR_NAME}.`
    const coverUrl = typeof page.cover === 'string'
      ? page.cover
      : (page.cover?.external?.url || page.cover?.file?.url || `${SITE_URL}/icon.svg`)

    const ogImages = coverUrl ? [{ url: coverUrl, alt: pageTitle }] : [{ url: `${SITE_URL}/icon.svg`, width: 512, height: 512, alt: pageTitle }]

    // ── Locale / translations ──────────────────────────────────────────
    const localeMeta = getLocaleMeta(page.locale || DEFAULT_LOCALE)
    const canonicalSlug = page.slug || lastSlug
    const translations = await getArticleTranslations(page)
    const languages = buildLanguageAlternates(page, canonicalSlug, translations)
    const alternateOgLocales = Object.entries(translations)
      .filter(([, t]) => t?.slug)
      .map(([locale]) => getLocaleMeta(locale).ogLocale)

    return {
      title: `${pageTitle} · ServiceNow Knowledge Hub`,
      description: pageDesc,
      keywords: [
        ...(page.tags || []),
        page.category || 'ServiceNow',
        'ServiceNow Architecture',
        'ServiceNow Knowledge Hub',
        AUTHOR_NAME,
      ],
      authors: [{ name: AUTHOR_NAME, url: SITE_URL }],
      alternates: {
        canonical: `/${canonicalSlug}`,
        ...(languages ? { languages } : {}),
      },
      openGraph: {
        type: 'article',
        title: `${pageTitle} · ServiceNow Knowledge Hub`,
        description: pageDesc,
        url: `${SITE_URL}/${canonicalSlug}`,
        siteName: 'ServiceNow Knowledge Hub',
        locale: localeMeta.ogLocale,
        ...(alternateOgLocales.length > 0 ? { alternateLocale: alternateOgLocales } : {}),
        publishedTime: page.date ? new Date(page.date).toISOString() : undefined,
        modifiedTime: page.date ? new Date(page.date).toISOString() : undefined,
        authors: [AUTHOR_NAME],
        tags: page.tags || [],
        images: ogImages,
      },
      twitter: {
        card: 'summary_large_image',
        title: pageTitle,
        description: pageDesc,
        creator: '@trungsqrt',
        images: coverUrl ? [coverUrl] : [`${SITE_URL}/icon.svg`],
      },
    }
  } catch (err) {
    return { title: 'Lesson · ServiceNow Space' }
  }
}

export default async function ArticlePage({ params }) {
  const resolvedParams = await params
  const param = Array.isArray(resolvedParams?.slug) ? resolvedParams.slug.join('/') : resolvedParams?.slug || ''
  if (/\.(ico|png|jpg|jpeg|svg|css|js|txt|map|json|xml)$/i.test(param)) {
    notFound()
  }

  const slugArray = resolvedParams?.slug || []
  const lastSlug = safeDecode(slugArray[slugArray.length - 1])
  if (!lastSlug) notFound()

  let page
  try {
    page = await getPageBySlug(lastSlug)
  } catch (err) {
    console.error("Failed to fetch page for slug:", resolvedParams?.slug, err)
    notFound()
  }

  if (!page || !page.html) notFound()

  const coverUrl = typeof page.cover === 'string'
    ? page.cover
    : (page.cover?.external?.url || page.cover?.file?.url || null)

  const title = page.title || "Lesson"
  const description = page.summary || ""
  const html = page.html
  const blocks = page.blocks || []

  // ── Locale & translations (metadata only — no extra block fetching) ────
  const locale = page.locale || DEFAULT_LOCALE
  const localeMeta = getLocaleMeta(locale)
  const canonicalSlug = page.slug || lastSlug
  const translations = await getArticleTranslations(page)

  // ── Sibling Pages (Previous / Next Article Navigation) ──────────────────
  // Resolved on the server using Notion Block API for nested child pages.
  const { prevPage, nextPage } = await getSiblingPages(page)

  // ── JSON-LD Structured Data Schema (TechArticle + BreadcrumbList) ──────
  const articleJsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'TechArticle',
        '@id': `${SITE_URL}/${canonicalSlug}#article`,
        isPartOf: {
          '@id': `${SITE_URL}/#website`,
        },
        headline: title,
        description: description || `ServiceNow architecture and technical guide for ${title}.`,
        inLanguage: localeMeta.bcp47,
        image: coverUrl ? [coverUrl] : [`${SITE_URL}/icon.svg`],
        datePublished: page.date ? new Date(page.date).toISOString() : undefined,
        dateModified: page.date ? new Date(page.date).toISOString() : undefined,
        author: {
          '@type': 'Person',
          name: AUTHOR_NAME,
          url: SITE_URL,
        },
        publisher: {
          '@type': 'Organization',
          name: 'ServiceNow Knowledge Hub',
          url: SITE_URL,
          logo: {
            '@type': 'ImageObject',
            url: `${SITE_URL}/icon.svg`,
          },
        },
        mainEntityOfPage: {
          '@type': 'WebPage',
          '@id': `${SITE_URL}/${canonicalSlug}`,
        },
        keywords: [
          ...(page.tags || []),
          page.category || 'ServiceNow',
          AUTHOR_NAME,
        ].join(', '),
        ...(() => {
          const workTranslation = Object.entries(translations)
            .filter(([, t]) => t?.slug)
            .map(([loc, t]) => ({
              '@type': 'TechArticle',
              '@id': `${SITE_URL}/${t.slug}#article`,
              url: `${SITE_URL}/${t.slug}`,
              headline: t.title,
              inLanguage: getLocaleMeta(loc).bcp47,
            }))
          return workTranslation.length > 0 ? { workTranslation } : {}
        })(),
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${SITE_URL}/${canonicalSlug}#breadcrumb`,
        itemListElement: [
          {
            '@type': 'ListItem',
            position: 1,
            name: 'Home',
            item: SITE_URL,
          },
          {
            '@type': 'ListItem',
            position: 2,
            name: page.category || 'Lessons',
            item: `${SITE_URL}/#${encodeURIComponent(page.category || 'lessons')}`,
          },
          {
            '@type': 'ListItem',
            position: 3,
            name: title,
            item: `${SITE_URL}/${canonicalSlug}`,
          },
        ],
      },
    ],
  }

  return (
    <>
      {/* ── Rich JSON-LD Schema for Google & AI Search ── */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd) }}
      />

      {coverUrl && (
        <ArticleCover src={coverUrl} title={title} icon={page.icon} />
      )}
      <div className="notion-viewport max-w-[90rem] mx-auto px-4 sm:px-6 md:px-8 py-8 md:py-12 flex items-start justify-center gap-8 relative">
        <article className="flex-1 max-w-4xl mx-auto min-w-0">
          {/* Page Header */}
          <header className="mb-8 pb-6 border-b border-rice-paper-400/60 dark:border-tea-slate-50/40">
            <h1 lang={localeMeta.hreflang} className="font-serif font-medium text-2xl sm:text-3xl md:text-4xl text-ink-700 dark:text-sage-100 leading-tight mb-3">
              {title}
            </h1>
            {description && (
              <p lang={localeMeta.hreflang} className="text-[1rem] leading-relaxed text-ink-400 dark:text-sage-400 max-w-prose">
                {description}
              </p>
            )}
            <LanguageSwitcher currentLocale={locale} translations={translations} />
          </header>

          {/* Content Body */}
          {html ? (
            <NotionContent
              html={html}
              locale={locale}
              className={[
                'prose prose-neutral dark:prose-invert max-w-none wabi-sabi-theme',
                'prose-headings:font-serif prose-headings:font-medium prose-headings:text-ink-700 dark:prose-headings:text-sage-100',
                'prose-h1:text-2xl md:prose-h1:text-3xl prose-h1:border-b prose-h1:border-rice-paper-400/60 dark:prose-h1:border-tea-slate-50/40 prose-h1:pb-3 prose-h1:mb-6 prose-h1:mt-8',
                'prose-h2:text-xl md:prose-h2:text-2xl prose-h2:mt-8 prose-h2:mb-4',
                'prose-h3:text-lg prose-h3:mt-6 prose-h3:mb-3',
                'prose-p:text-ink-700 dark:prose-p:text-sage-200 prose-p:leading-relaxed prose-p:my-4 prose-p:text-[0.98rem]',
                'prose-a:text-matcha-600 dark:prose-a:text-matcha-300 prose-a:no-underline hover:prose-a:underline',
                'prose-strong:text-ink-700 dark:prose-strong:text-sage-100 prose-strong:font-semibold',
                'prose-ul:my-4 prose-ol:my-4 prose-li:my-1.5 prose-li:text-ink-700 dark:prose-li:text-sage-200 prose-li:text-[0.98rem]',
                'prose-code:text-matcha-700 dark:prose-code:text-matcha-300 prose-code:bg-rice-paper-300/50 dark:prose-code:bg-tea-slate-200/50 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none',
                'prose-blockquote:border-l-2 prose-blockquote:border-matcha-500 dark:prose-blockquote:border-matcha-400 prose-blockquote:pl-5 prose-blockquote:pr-4 prose-blockquote:py-3.5 prose-blockquote:font-serif prose-blockquote:italic prose-blockquote:text-[0.96rem] prose-blockquote:leading-[1.8] prose-blockquote:text-ink-700 dark:prose-blockquote:text-sage-100 prose-blockquote:bg-rice-paper-200/60 dark:prose-blockquote:bg-tea-slate-200/50 prose-blockquote:rounded-r-[6px] prose-blockquote:border-y prose-blockquote:border-r prose-blockquote:border-transparent dark:prose-blockquote:border-tea-slate-50/30',
              ].join(' ')}
            />
          ) : (
            <div className="max-w-content mx-auto px-6 py-16 text-center">
              <span className="block text-5xl mb-6 opacity-50">📖</span>
              <h1 className="font-serif text-2xl text-ink-600 dark:text-sage-200 mb-3">
                {title || "Lesson"}
              </h1>
              <p className="text-ink-400 dark:text-sage-500 text-[0.9rem] leading-relaxed">
                Connect your Notion database via{" "}
                <code className="notion-inline-code">.env.local</code> to render content here.
              </p>
            </div>
          )}

          {/* ── Sibling Article Navigation (Previous / Next) ── */}
          <SiblingNavigation prevPage={prevPage} nextPage={nextPage} />
        </article>

        <TableOfContents blocks={blocks} />
      </div>
    </>
  )
}
