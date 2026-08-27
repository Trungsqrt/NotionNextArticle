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

export const metadata = {
  title: 'ServiceNow Space',
  description: 'A serene knowledge space',
  icons: {
    icon: [
      { url: '/favicon.ico' },
      { url: '/icon.svg', type: 'image/svg+xml' },
    ],
  },
}

export default function RootLayout({ children }) {
  return (
    <html
      lang="en"
      className={`${plusJakarta.variable} ${notoSerif.variable} ${firaCode.variable} scroll-smooth`}
      style={{ scrollBehavior: 'smooth' }}
      suppressHydrationWarning
    >
      <body suppressHydrationWarning>
        <Layout>{children}</Layout>
      </body>
    </html>
  )
}

