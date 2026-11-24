import { Suspense } from 'react'
import ContactForm from '../../components/ContactForm'
import { SITE_URL } from '../../lib/site-url'

export const metadata = {
  title: {
    absolute: 'Contact | ServiceNow Knowledge Hub',
  },
  description:
    'Contact the author, ask ServiceNow questions, suggest corrections, or share feedback.',
  alternates: {
    canonical: '/contact',
  },
  openGraph: {
    type: 'website',
    url: `${SITE_URL}/contact`,
    siteName: 'ServiceNow Knowledge Hub',
    title: 'Contact | ServiceNow Knowledge Hub',
    description:
      'Contact the author, ask ServiceNow questions, suggest corrections, or share feedback.',
  },
  twitter: {
    card: 'summary',
    title: 'Contact | ServiceNow Knowledge Hub',
    description:
      'Contact the author, ask ServiceNow questions, suggest corrections, or share feedback.',
  },
}

function ContactFormFallback() {
  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-10 sm:py-14">
      <div className="h-8 w-44 rounded-zen bg-rice-paper-300/70 dark:bg-tea-slate-200/70 mb-3" />
      <div className="h-4 w-3/4 rounded-zen bg-rice-paper-300/60 dark:bg-tea-slate-200/60 mb-8" />
      <div className="h-80 rounded-card bg-rice-paper-200/70 dark:bg-tea-slate-200/50 border border-rice-paper-400/60 dark:border-tea-slate-50/40" />
    </div>
  )
}

export default function ContactPage() {
  return (
    <Suspense fallback={<ContactFormFallback />}>
      <ContactForm />
    </Suspense>
  )
}
