'use client'

import { useState, useEffect } from 'react'

/**
 * 4 Curated Japanese Wabi-Sabi Still Life Artworks
 */
const STILL_LIFE_ITEMS = [
  // ── 1. Zen Rock Balance (Tháp đá thiền & Vườn cát Karesansui) ──────────────
  {
    id: 'zen-rocks',
    kanji: '静',
    kanjiTitle: '枯山水 · Karesansui',
    title: 'Rock Balance',
    subtitle: 'Stillness & Foundation',
    quote: 'In the stillness of mind, clear architecture is born.',
    author: 'Zen Principle',
    renderSvg: () => (
      <svg viewBox="0 0 200 240" className="w-full max-w-[170px] mx-auto overflow-visible select-none" aria-hidden="true">
        {/* Subtle background glow */}
        <circle cx="100" cy="120" r="70" fill="url(#zenGlow)" opacity="0.4" />
        
        {/* Rippling sand lines (Karesansui wave patterns) */}
        <path d="M20 195 Q60 188 100 195 T180 195" stroke="currentColor" strokeWidth="1.2" strokeOpacity="0.18" fill="none" />
        <path d="M10 205 Q55 198 100 205 T190 205" stroke="currentColor" strokeWidth="1.2" strokeOpacity="0.22" fill="none" />
        <path d="M30 215 Q65 208 100 215 T170 215" stroke="currentColor" strokeWidth="1.2" strokeOpacity="0.15" fill="none" />
        
        {/* Bottom Large Pebble */}
        <path
          d="M42 180 C42 165 70 156 100 156 C132 156 158 165 158 180 C158 193 130 198 100 198 C68 198 42 192 42 180 Z"
          className="fill-rice-paper-300 dark:fill-tea-slate-100 stroke-matcha-500/40 dark:stroke-matcha-400/30"
          strokeWidth="1.5"
        />
        {/* Rock texture line */}
        <path d="M60 178 Q100 172 140 180" stroke="currentColor" strokeWidth="1" strokeOpacity="0.15" fill="none" />

        {/* Middle Balance Stone */}
        <path
          d="M58 140 C58 126 80 118 102 118 C126 118 144 126 144 140 C144 152 124 158 102 158 C78 158 58 150 58 140 Z"
          className="fill-rice-paper-400/80 dark:fill-tea-slate-50 stroke-matcha-600/40 dark:stroke-matcha-400/40"
          strokeWidth="1.5"
        />

        {/* Top Smooth Stone */}
        <path
          d="M74 102 C74 90 88 82 104 82 C120 82 130 90 130 102 C130 112 118 120 104 120 C88 120 74 112 74 102 Z"
          className="fill-matcha-100/90 dark:fill-matcha-800/40 stroke-matcha-500 dark:stroke-matcha-400/60"
          strokeWidth="1.5"
        />

        {/* Tiny Zen Pebble on top */}
        <ellipse
          cx="105"
          cy="74"
          rx="12"
          ry="7"
          className="fill-matcha-500/80 dark:fill-matcha-400/80"
        />

        {/* Japanese Hanko seal stamp */}
        <g transform="translate(150, 60)">
          <rect width="18" height="18" rx="3" className="fill-rose-700/80 dark:fill-rose-600/70" />
          <text x="9" y="13" textAnchor="middle" fill="#ffffff" fontSize="10" fontFamily="serif" fontWeight="bold">静</text>
        </g>
      </svg>
    ),
  },

  // ── 2. Botanical Ink Wash (Nhành trúc & Lá Bạch Quả) ───────────────────────
  {
    id: 'zen-bamboo',
    kanji: '和',
    kanjiTitle: '竹林 · Bamboo Grove',
    title: 'Sumi-e Stalk',
    subtitle: 'Grace & Flexibility',
    quote: 'Bend with the wind of requirements, yet remain deeply rooted.',
    author: 'Wabi-Sabi Flow',
    renderSvg: () => (
      <svg viewBox="0 0 200 240" className="w-full max-w-[170px] mx-auto overflow-visible select-none" aria-hidden="true">
        <circle cx="100" cy="115" r="65" fill="url(#zenGlow)" opacity="0.35" />

        {/* Bamboo Main Stem */}
        <path d="M98 220 L98 175" className="stroke-matcha-700 dark:stroke-matcha-400" strokeWidth="4.5" strokeLinecap="round" />
        <circle cx="98" cy="174" r="3.5" className="fill-matcha-800 dark:fill-matcha-300" />
        
        <path d="M98 170 L96 115" className="stroke-matcha-600 dark:stroke-matcha-400" strokeWidth="4" strokeLinecap="round" />
        <circle cx="96" cy="114" r="3" className="fill-matcha-800 dark:fill-matcha-300" />

        <path d="M96 110 L94 50" className="stroke-matcha-500 dark:stroke-matcha-400" strokeWidth="3" strokeLinecap="round" />
        <circle cx="94" cy="49" r="2.5" className="fill-matcha-800 dark:fill-matcha-300" />

        {/* Bamboo Leaves */}
        {/* Left cluster */}
        <path d="M96 114 Q70 120 48 135 Q75 125 96 114" className="fill-matcha-600 dark:fill-matcha-400/90" />
        <path d="M96 114 Q65 105 40 112 Q68 112 96 114" className="fill-matcha-500/80 dark:fill-matcha-300/80" />
        <path d="M96 114 Q72 90 52 82 Q74 98 96 114" className="fill-matcha-700 dark:fill-matcha-400" />

        {/* Right cluster */}
        <path d="M94 50 Q120 45 150 55 Q122 55 94 50" className="fill-matcha-600 dark:fill-matcha-400" />
        <path d="M94 50 Q128 65 148 85 Q120 72 94 50" className="fill-matcha-500/80 dark:fill-matcha-300/80" />
        <path d="M98 174 Q130 178 156 195 Q130 186 98 174" className="fill-matcha-700/80 dark:fill-matcha-500/70" />

        {/* Floating Ginkgo Leaf */}
        <g transform="translate(130, 110) rotate(25)">
          <path d="M0 20 Q12 0 24 10 Q32 0 40 16 Q22 26 0 20" className="fill-amber-600/30 dark:fill-amber-400/25 stroke-amber-600/50" strokeWidth="1" />
          <line x1="20" y1="18" x2="24" y2="34" className="stroke-amber-700/50" strokeWidth="1.2" />
        </g>

        {/* Japanese Hanko seal stamp */}
        <g transform="translate(35, 45)">
          <rect width="18" height="18" rx="3" className="fill-rose-700/80 dark:fill-rose-600/70" />
          <text x="9" y="13" textAnchor="middle" fill="#ffffff" fontSize="10" fontFamily="serif" fontWeight="bold">和</text>
        </g>
      </svg>
    ),
  },

  // ── 3. Kyusu Tea Vessel (Ấm Trà Đất Nung & Làn Khói) ──────────────────────
  {
    id: 'zen-tea',
    kanji: '茶',
    kanjiTitle: '茶道 · The Way of Tea',
    title: 'Kyusu Vessel',
    subtitle: 'Calm & Contemplation',
    quote: 'A quiet cup of green tea before building great systems.',
    author: 'Tea Principle',
    renderSvg: () => (
      <svg viewBox="0 0 200 240" className="w-full max-w-[170px] mx-auto overflow-visible select-none" aria-hidden="true">
        <circle cx="100" cy="130" r="65" fill="url(#zenGlow)" opacity="0.35" />

        {/* Delicate Steam Wisps */}
        <path d="M95 95 Q90 75 98 60 T92 35" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 3" strokeOpacity="0.3" fill="none" className="animate-pulse" />
        <path d="M108 90 Q115 70 106 50 T114 25" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 3" strokeOpacity="0.25" fill="none" className="animate-pulse" />

        {/* Teapot Base Mat / Coaster */}
        <ellipse cx="98" cy="192" rx="68" ry="12" className="fill-rice-paper-400/50 dark:fill-tea-slate-100/40" />

        {/* Kyusu Teapot Body */}
        <path
          d="M55 170 C48 140 70 120 100 120 C130 120 152 140 145 170 C140 185 60 185 55 170 Z"
          className="fill-rice-paper-300 dark:fill-tea-slate-100 stroke-matcha-600/50 dark:stroke-matcha-400/40"
          strokeWidth="1.8"
        />

        {/* Teapot Lid */}
        <path
          d="M80 120 C80 112 90 108 100 108 C110 108 120 112 120 120 Z"
          className="fill-matcha-500/20 dark:fill-matcha-700/40 stroke-matcha-600/60 dark:stroke-matcha-400/50"
          strokeWidth="1.5"
        />
        <circle cx="100" cy="106" r="3.5" className="fill-matcha-600 dark:fill-matcha-400" />

        {/* Teapot Spout */}
        <path
          d="M56 142 C45 138 36 128 32 120 C38 124 48 132 58 134 Z"
          className="fill-rice-paper-300 dark:fill-tea-slate-100 stroke-matcha-600/50"
          strokeWidth="1.5"
        />

        {/* Traditional Straight Handle (Yokode Kyusu) */}
        <path
          d="M142 145 L178 138 C182 137 184 142 180 145 L143 156 Z"
          className="fill-matcha-700/80 dark:fill-matcha-600/70"
        />

        {/* Teacup next to pot */}
        <path
          d="M136 182 C134 170 145 164 154 164 C163 164 174 170 172 182 C170 188 138 188 136 182 Z"
          className="fill-matcha-100/90 dark:fill-tea-slate-50 stroke-matcha-500/60"
          strokeWidth="1.2"
        />
        {/* Tea surface inside cup */}
        <ellipse cx="154" cy="167" rx="8" ry="2.5" className="fill-matcha-500 dark:fill-matcha-400" />

        {/* Japanese Hanko seal stamp */}
        <g transform="translate(150, 55)">
          <rect width="18" height="18" rx="3" className="fill-rose-700/80 dark:fill-rose-600/70" />
          <text x="9" y="13" textAnchor="middle" fill="#ffffff" fontSize="10" fontFamily="serif" fontWeight="bold">茶</text>
        </g>
      </svg>
    ),
  },

  // ── 4. Zen Quote Scroll (Thẻ Thư Pháp Tanzaku) ─────────────────────────────
  {
    id: 'zen-scroll',
    kanji: '道',
    kanjiTitle: '短冊 · Washi Scroll',
    title: 'Beginner Mind',
    subtitle: 'Shoshin · 初心',
    quote: 'In the beginner’s mind there are many possibilities, in the expert’s few.',
    author: 'Shunryu Suzuki',
    renderSvg: () => (
      <svg viewBox="0 0 200 240" className="w-full max-w-[170px] mx-auto overflow-visible select-none" aria-hidden="true">
        <circle cx="100" cy="115" r="65" fill="url(#zenGlow)" opacity="0.35" />

        {/* Hanging Ribbon cord */}
        <line x1="100" y1="20" x2="100" y2="50" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.4" />
        <circle cx="100" cy="20" r="3" className="fill-matcha-500" />

        {/* Tanzaku Paper Bookmark Strip */}
        <rect
          x="62"
          y="50"
          width="76"
          height="145"
          rx="5"
          className="fill-rice-paper-200 dark:fill-tea-slate-100 stroke-rice-paper-400/80 dark:stroke-tea-slate-50/80 shadow-zen"
          strokeWidth="1.5"
        />

        {/* Ink Wash Distant Mountain inside the scroll */}
        <path
          d="M66 140 Q85 110 100 125 T134 135 L134 190 L66 190 Z"
          className="fill-matcha-500/10 dark:fill-matcha-400/10"
        />
        <path
          d="M75 155 Q95 130 115 145 T134 150 L134 190 L75 190 Z"
          className="fill-matcha-500/15 dark:fill-matcha-400/15"
        />

        {/* Calligraphy Kanji characters vertically written */}
        <text x="100" y="90" textAnchor="middle" className="fill-ink-700 dark:fill-sage-100 font-serif text-[1.45rem] font-medium" style={{ letterSpacing: '0.1em' }}>
          初心
        </text>
        <text x="100" y="112" textAnchor="middle" className="fill-ink-400 dark:fill-sage-400 text-[0.6rem] uppercase tracking-widest font-sans">
          SHOSHIN
        </text>

        {/* Japanese Hanko signature seal stamp */}
        <g transform="translate(91, 155)">
          <rect width="18" height="18" rx="3" className="fill-rose-700/80 dark:fill-rose-600/70" />
          <text x="9" y="13" textAnchor="middle" fill="#ffffff" fontSize="10" fontFamily="serif" fontWeight="bold">道</text>
        </g>
      </svg>
    ),
  },
]

export default function ZenStillLife({ currentSlug = '' }) {
  const [activeItem, setActiveItem] = useState(STILL_LIFE_ITEMS[0])
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    // Pick deterministic or randomized artwork per slug
    let index = 0
    if (currentSlug) {
      let hash = 0
      for (let i = 0; i < currentSlug.length; i++) {
        hash = (hash << 5) - hash + currentSlug.charCodeAt(i)
        hash |= 0
      }
      index = Math.abs(hash) % STILL_LIFE_ITEMS.length
    } else {
      index = Math.floor(Math.random() * STILL_LIFE_ITEMS.length)
    }
    setActiveItem(STILL_LIFE_ITEMS[index])
    setMounted(true)
  }, [currentSlug])

  if (!mounted) {
    // Return placeholder during SSR hydration
    return (
      <div className="h-full flex flex-col items-center justify-center p-4 min-h-[300px]" />
    )
  }

  return (
    <div className="h-full flex flex-col justify-between p-4 animate-fade-in select-none">
      {/* ── Top Header of Still Life Card */}
      <div className="text-center pt-2">
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[0.68rem] font-serif tracking-wider bg-matcha-100/60 dark:bg-matcha-900/30 text-matcha-700 dark:text-matcha-300 border border-matcha-200/50 dark:border-matcha-800/40">
          <span className="text-[0.6rem]">✦</span> {activeItem.kanjiTitle}
        </span>
      </div>

      {/* ── Shared Radial Gradient Defs */}
      <svg className="absolute w-0 h-0" aria-hidden="true">
        <defs>
          <radialGradient id="zenGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#7A8B69" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#7A8B69" stopOpacity="0" />
          </radialGradient>
        </defs>
      </svg>

      {/* ── Artwork Centerpiece */}
      <div className="my-auto py-2 transition-transform duration-500 hover:scale-105">
        {activeItem.renderSvg()}
      </div>

      {/* ── Bottom Inscription / Thought Card */}
      <div className="mt-auto px-2 pb-2 text-center">
        <p className="font-serif italic text-[0.82rem] leading-relaxed text-ink-600 dark:text-sage-300 mb-2">
          &ldquo;{activeItem.quote}&rdquo;
        </p>
        <p className="text-[0.68rem] tracking-wider uppercase text-ink-400 dark:text-sage-500 font-sans">
          — {activeItem.author}
        </p>
      </div>
    </div>
  )
}
