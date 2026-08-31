import '../styles/globals.css'
import Layout from '../components/Layout'
import { Plus_Jakarta_Sans, Noto_Serif_JP, Fira_Code } from 'next/font/google'

// ── Font initialisation (module-level, as required by next/font) ─────────────
const plusJakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
})

const notoSerif = Noto_Serif_JP({
  weight: ['300', '400', '500', '700'],
  subsets: ['latin'],
  variable: '--font-serif',
  display: 'swap',
})

const firaCode = Fira_Code({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
})

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://notion-next-article-pink.vercel.app'
const AUTHOR_NAME = 'Jun Mai - Trungsqrt'
const SITE_TITLE = 'ServiceNow Knowledge Hub · Jun Mai - Trungsqrt'
const SITE_DESCRIPTION = 'Master ServiceNow with calm clarity — curated architecture notes, CSDM/CMDB labs, performance deep-dives, and reference cards by Jun Mai - Trungsqrt.'

export const metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE_TITLE,
    template: '%s · ServiceNow Knowledge Hub',
  },
  description: SITE_DESCRIPTION,
  applicationName: 'ServiceNow Knowledge Hub',
  authors: [{ name: AUTHOR_NAME, url: SITE_URL }],
  generator: 'Next.js',
  keywords: [
    'ServiceNow',
    'ServiceNow Knowledge Hub',
    'ServiceNow Architecture',
    'ServiceNow Developer',
    'CSDM',
    'CMDB',
    'ITSM',
    'ITOM',
    'GlideRecord',
    'ServiceNow Best Practices',
    'Jun Mai',
    'Trungsqrt',
    'Wabi Sabi Theme',
  ],
  creator: AUTHOR_NAME,
  publisher: AUTHOR_NAME,
  alternates: {
    canonical: '/',
    types: {
      'text/plain': '/llms.txt',
    },
  },
  icons: {
    icon: [
      { url: '/favicon.ico' },
      { url: '/icon.svg', type: 'image/svg+xml' },
    ],
  },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: SITE_URL,
    siteName: 'ServiceNow Knowledge Hub',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [
      {
        url: '/icon.svg',
        width: 512,
        height: 512,
        alt: 'ServiceNow Knowledge Hub Logo',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    creator: '@trungsqrt',
    images: ['/icon.svg'],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
}

// Global JSON-LD Structured Data for Schema.org (WebSite + Person / Organization)
const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebSite',
      '@id': `${SITE_URL}/#website`,
      url: SITE_URL,
      name: 'ServiceNow Knowledge Hub',
      description: SITE_DESCRIPTION,
      publisher: {
        '@id': `${SITE_URL}/#person`,
      },
      inLanguage: 'en-US',
    },
    {
      '@type': 'Person',
      '@id': `${SITE_URL}/#person`,
      name: AUTHOR_NAME,
      url: SITE_URL,
      jobTitle: 'ServiceNow Architect & Developer',
      description: 'Curator and author of ServiceNow Knowledge Hub articles, CSDM labs, and performance guides.',
    },
    {
      '@type': 'Organization',
      '@id': `${SITE_URL}/#organization`,
      name: 'ServiceNow Knowledge Hub',
      url: SITE_URL,
      logo: `${SITE_URL}/icon.svg`,
      founder: {
        '@id': `${SITE_URL}/#person`,
      },
    },
  ],
}

export default function RootLayout({ children }) {
  return (
    <html
      lang="en"
      className={`${plusJakarta.variable} ${notoSerif.variable} ${firaCode.variable} scroll-smooth`}
      style={{ scrollBehavior: 'smooth' }}
      suppressHydrationWarning
    >
      <head>
        <script
          id="theme-initializer"
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=localStorage.getItem('ws-theme');var m=window.matchMedia('(prefers-color-scheme: dark)').matches;if(s==='dark'||(!s&&m)){document.documentElement.classList.add('dark');}else{document.documentElement.classList.remove('dark');}}catch(e){}})();`,
          }}
        />
        <link rel="alternate" type="text/plain" href="/llms.txt" title="LLM-friendly text version" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body suppressHydrationWarning>
        <Layout>{children}</Layout>
      </body>
    </html>
  )
}

