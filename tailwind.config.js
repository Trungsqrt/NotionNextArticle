/** @type {import('tailwindcss').Config} */
module.exports = {
  // Enable class-based dark mode so we can toggle with a className on <html>
  darkMode: 'class',

  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts}',
    './styles/**/*.css',
  ],

  // ── Safelist: classes used inside JS template strings in lib/notion.js ──
  // These strings are not statically analysable by Tailwind's scanner in all
  // build modes (Turbopack JIT), so we explicitly protect them from purging.
  safelist: [
    // Grid layout (child_database card grid)
    'grid', 'grid-cols-1', 'gap-6', 'my-8', 'not-prose',
    { pattern: /^sm:grid-cols-/, variants: ['sm'] },
    { pattern: /^lg:grid-cols-/, variants: ['lg'] },
    // Card shell — rounded-card is a custom class, the rest are standard
    'rounded-card', 'shadow-zen-sm', 'shadow-zen',
    'overflow-hidden', 'flex', 'flex-col', 'flex-1',
    'relative', 'block',
    // Aspect ratio cover
    'aspect-[16/7]', 'flex-shrink-0',
    // Card body
    'p-4', 'gap-2.5',
    // Tag chips
    'rounded-pill', 'leading-none',
    'bg-matcha-100/70', 'dark:bg-matcha-700/25',
    'text-matcha-600', 'dark:text-matcha-300',
    'border-matcha-200/60', 'dark:border-matcha-700/40',
    // Meta row
    'mt-auto', 'pt-2', 'justify-between',
    'border-rice-paper-400/50', 'dark:border-tea-slate-50/30',
    // Typography
    'font-serif', 'line-clamp-2', 'leading-snug',
    'text-ink-700', 'dark:text-sage-100',
    'text-ink-400', 'dark:text-sage-500',
    'text-ink-400', 'dark:text-sage-600',
    // Read CTA
    'text-matcha-500', 'dark:text-matcha-400',
    'text-matcha-600', 'dark:text-matcha-300',
    // Hover states
    'hover:-translate-y-[3px]',
    'hover:shadow-zen',
    'hover:border-matcha-400/60', 'dark:hover:border-matcha-700/60',
    'hover:text-matcha-600', 'dark:hover:text-matcha-300',
    'hover:scale-[1.03]', 'group-hover:scale-[1.03]',
    'group-hover:scale-110',
    // Notion badge colors
    'bg-stone-100', 'text-stone-700', 'border-stone-200/70',
    'dark:bg-stone-800', 'dark:text-stone-300', 'dark:border-stone-700/60',
    'bg-amber-50', 'text-amber-800', 'border-amber-200/70',
    'dark:bg-amber-900/30', 'dark:text-amber-300', 'dark:border-amber-700/50',
    'bg-green-50', 'text-green-700', 'border-green-200/70',
    'dark:bg-green-900/30', 'dark:text-green-300', 'dark:border-green-700/50',
    'bg-blue-50', 'text-blue-700', 'border-blue-200/70',
    'dark:bg-blue-900/30', 'dark:text-blue-300', 'dark:border-blue-700/50',
    'bg-purple-50', 'text-purple-700', 'border-purple-200/70',
    'dark:bg-purple-900/30', 'dark:text-purple-300', 'dark:border-purple-700/50',
    'bg-red-50', 'text-red-700', 'border-red-200/70',
    'dark:bg-red-900/30', 'dark:text-red-300', 'dark:border-red-700/50',
    'bg-orange-50', 'text-orange-700', 'border-orange-200/70',
    'dark:bg-orange-900/30', 'dark:text-orange-300', 'dark:border-orange-700/50',
    'bg-yellow-50', 'text-yellow-700', 'border-yellow-200/70',
    'dark:bg-yellow-900/30', 'dark:text-yellow-300', 'dark:border-yellow-700/50',
    'bg-pink-50', 'text-pink-700', 'border-pink-200/70',
    'dark:bg-pink-900/30', 'dark:text-pink-300', 'dark:border-pink-700/50',
    // Toggle block dynamic background colors (getToggleColorClasses)
    'bg-gray-100', 'border-gray-200', 'dark:bg-gray-800/60', 'dark:border-gray-700',
    'bg-stone-100', 'border-stone-200', 'dark:bg-stone-800/60', 'dark:border-stone-700',
    'bg-orange-50/80', 'border-orange-200/60', 'dark:bg-orange-900/30', 'dark:border-orange-800/50',
    'bg-amber-50/80', 'border-amber-200/60', 'dark:bg-amber-900/30', 'dark:border-amber-800/50',
    'bg-emerald-50/80', 'border-emerald-200/60', 'dark:bg-emerald-900/30', 'dark:border-emerald-800/50',
    'bg-blue-50/80', 'border-blue-200/60', 'dark:bg-blue-900/30', 'dark:border-blue-800/50',
    'bg-purple-50/80', 'border-purple-200/60', 'dark:bg-purple-900/30', 'dark:border-purple-800/50',
    'bg-rose-50/80', 'border-rose-200/60', 'dark:bg-rose-900/30', 'dark:border-rose-800/50',
    'bg-red-50/80', 'border-red-200/60', 'dark:bg-red-900/30', 'dark:border-red-800/50',
    'bg-neutral-50/60', 'border-neutral-200/50', 'dark:bg-neutral-800/40', 'dark:border-neutral-700/60',
    // Toggle chevron animation
    'group-open:rotate-90', 'group-open:text-neutral-600',
    // List styling classes
    'list-disc', 'list-decimal', 'list-outside', 'pl-6', 'ml-6', 'pl-2', 'sm:pl-4', 'pl-1', 'space-y-1', 'space-y-2', 'my-4', 'my-1.5', 'gap-2.5', 'mt-[2px]', 'select-none', 'shrink-0', 'whitespace-pre-wrap', 'min-w-[1.25rem]', 'text-right', 'font-mono', 'marker:text-neutral-400',
    // Inline code, Quote, Callout classes
    'text-rose-500', 'dark:text-rose-400', 'bg-rose-50/80', 'dark:bg-rose-900/30', 'px-1.5', 'py-0.5', 'rounded-md', 'text-[0.9em]',
    'bg-stone-50/80', 'dark:bg-stone-800/40', 'pr-4', 'py-3', 'font-medium', 'rounded-r-card',
    // Spacing & Multi-column layout classes
    'mt-12', 'mb-6', 'mt-10', 'mb-4', 'mt-8', 'mb-3', 'my-5', 'flex-col', 'md:flex-row', 'gap-6', 'md:gap-8', 'flex-1', 'min-w-0', 'w-full', 'items-start',
    // In-content & full-bleed cover image classes
    'h-[30vh]', 'min-h-[250px]', 'rounded-2xl', 'shadow-sm', 'my-6',
    // Code block IDE renderer classes
    'whitespace-pre-wrap', 'break-words', 'border-neutral-200/60', 'dark:border-neutral-800/60', 'hljs',
  ],

  theme: {
    extend: {
      // ─────────────────────────────────────────
      //  Wabi-Sabi & Matcha Color Palette
      // ─────────────────────────────────────────
      colors: {
        // Rice Paper — warm off-white backgrounds (light mode)
        'rice-paper': {
          50:  '#FEFDFB',
          100: '#FAF8F5',   // ← primary light bg
          200: '#F7F5F0',
          300: '#F2EEE6',
          400: '#EAE6DF',   // ← stone border
          500: '#DDD8CE',
          600: '#C8C1B4',
        },

        // Matcha — the key accent green
        matcha: {
          50:  '#F4F6F1',
          100: '#E6EBE0',
          200: '#CDDAC4',
          300: '#AFC9A3',
          400: '#8E9B7B',   // ← primary accent
          500: '#7A8B69',   // ← hover / strong accent
          600: '#647256',
          700: '#4A573D',   // ← dark mode accent
          800: '#3A4530',
          900: '#2A3323',
        },

        // Ink — deep charcoal for text
        ink: {
          50:  '#F5F4F3',
          100: '#E8E6E3',
          200: '#CCC9C4',
          300: '#A8A49D',
          400: '#7A756E',
          500: '#524E47',
          600: '#3D3A34',
          700: '#2C2A29',   // ← primary dark text
          800: '#1E1D1B',
          900: '#121110',
        },

        // Tea Slate — dark mode backgrounds
        'tea-slate': {
          50:  '#2A2B28',
          100: '#242520',
          200: '#1F201C',
          300: '#1A1B18',   // ← primary dark bg
          400: '#161714',   // ← deepest dark bg
          500: '#111210',
        },

        // Sage — muted supporting tones for dark mode text
        sage: {
          100: '#F0F1EC',
          200: '#D8DAD3',   // ← dark mode body text
          300: '#BEC1B7',
          400: '#9DA096',
          500: '#7C7F76',
          600: '#5E6159',
        },
      },

      // ─────────────────────────────────────────
      //  Typography
      // ─────────────────────────────────────────
      fontFamily: {
        sans:  ['"Plus Jakarta Sans"', 'Inter', 'system-ui', 'sans-serif'],
        serif: ['"Noto Serif JP"', '"Georgia"', 'serif'],
        mono:  ['"Fira Code"', 'monospace'],
      },

      fontSize: {
        'xs':   ['0.75rem',  { lineHeight: '1.6' }],
        'sm':   ['0.875rem', { lineHeight: '1.7' }],
        'base': ['1rem',     { lineHeight: '1.8' }],
        'lg':   ['1.125rem', { lineHeight: '1.85' }],
        'xl':   ['1.25rem',  { lineHeight: '1.75' }],
        '2xl':  ['1.5rem',   { lineHeight: '1.6' }],
        '3xl':  ['1.875rem', { lineHeight: '1.4' }],
        '4xl':  ['2.25rem',  { lineHeight: '1.25' }],
      },

      letterSpacing: {
        'zen':   '0.03em',
        'wider': '0.05em',
        'wide':  '0.025em',
      },

      // ─────────────────────────────────────────
      //  Spacing & Layout
      // ─────────────────────────────────────────
      maxWidth: {
        'content': '72ch',
        'prose':   '68ch',
      },

      // ─────────────────────────────────────────
      //  Border Radius
      // ─────────────────────────────────────────
      borderRadius: {
        'zen':  '6px',
        'card': '10px',
        'pill': '9999px',
      },

      // ─────────────────────────────────────────
      //  Animations
      // ─────────────────────────────────────────
      transitionTimingFunction: {
        'zen': 'cubic-bezier(0.4, 0, 0.2, 1)',
      },

      keyframes: {
        'fade-in': {
          '0%':   { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in': {
          '0%':   { opacity: '0', transform: 'translateX(-8px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        'shimmer': {
          '0%':   { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },

      animation: {
        'fade-in':  'fade-in 0.35s ease-out both',
        'slide-in': 'slide-in 0.3s ease-out both',
        'shimmer':  'shimmer 2s linear infinite',
      },

      // ─────────────────────────────────────────
      //  Box Shadows — soft, organic
      // ─────────────────────────────────────────
      boxShadow: {
        'zen-sm': '0 1px 3px rgba(44, 42, 41, 0.06), 0 1px 2px rgba(44, 42, 41, 0.04)',
        'zen':    '0 4px 12px rgba(44, 42, 41, 0.08), 0 2px 4px rgba(44, 42, 41, 0.04)',
        'zen-lg': '0 8px 24px rgba(44, 42, 41, 0.10), 0 4px 8px rgba(44, 42, 41, 0.06)',
        'matcha': '0 4px 14px rgba(122, 139, 105, 0.25)',
      },
    },
  },

  plugins: [],
}
