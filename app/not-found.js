import Link from 'next/link'

export const metadata = {
  title: 'Page Not Found · ServiceNow Space',
  description: 'This page could not be found.',
}

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-6 text-center animate-fade-in">
      {/* Organic ink-wash numeral */}
      <div
        className="text-[8rem] font-serif font-light leading-none select-none mb-4"
        style={{
          color: 'transparent',
          WebkitTextStroke: '1px rgba(122,139,105,0.35)',
          letterSpacing: '-0.04em',
        }}
        aria-hidden="true"
      >
        404
      </div>

      <p className="font-serif text-xl text-ink-500 dark:text-sage-300 mb-2 italic">
        無 — &ldquo;Mu&rdquo;
      </p>
      <p className="text-[0.88rem] text-ink-400 dark:text-sage-500 mb-8 max-w-sm leading-relaxed">
        This page does not exist — like the gap between thoughts.
        Perhaps it was moved, renamed, or yet to be written.
      </p>

      <Link
        href="/"
        id="404-home-link"
        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-pill text-[0.85rem] font-medium bg-matcha-500 dark:bg-matcha-700 text-white hover:bg-matcha-600 dark:hover:bg-matcha-600 transition-colors duration-200 no-underline shadow-matcha"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
        Return Home
      </Link>

      <p className="mt-16 text-[0.72rem] text-ink-300 dark:text-sage-600 font-serif">
        ✦ &nbsp;The path continues elsewhere
      </p>
    </div>
  )
}
