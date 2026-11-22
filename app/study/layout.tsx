import type { Metadata } from 'next'
import type { ReactNode } from 'react'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export const metadata: Metadata = {
  title: {
    absolute: 'Private Study Room',
  },
  description: 'Private study workspace.',
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
      'max-snippet': 0,
      'max-image-preview': 'none',
    },
  },
}

export default function StudyLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-[calc(100vh-8rem)] bg-rice-paper-100 dark:bg-tea-slate-300 text-ink-700 dark:text-sage-200">
      {children}
    </div>
  )
}
