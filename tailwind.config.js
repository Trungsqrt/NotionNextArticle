/** @type {import('tailwindcss').Config} */
module.exports = {
  // Enable class-based dark mode so we can toggle with a className on <html>
  darkMode: 'class',

  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './styles/**/*.css',
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
        mono:  ['"JetBrains Mono"', '"Fira Code"', 'monospace'],
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
