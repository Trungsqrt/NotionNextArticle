'use client'

import { useState, useEffect } from 'react'

/**
 * 8 Curated Japanese Wabi-Sabi & Zen Still Life Artworks
 */
const STILL_LIFE_ITEMS = [
  // ── 1. Zen Rock Balance (Tháp đá thiền & Vườn cát Karesansui) ──────────────
  {
    id: 'zen-rocks',
    kanji: '静',
    kanjiTitle: '枯山水 · Karesansui',
    title: 'Rock Balance',
    subtitle: 'Stillness & Equilibrium',
    quote: 'In the stillness of mind, clear architecture is born.',
    author: 'Zen Principle',
    renderSvg: () => (
      <svg viewBox="0 0 200 240" className="w-full max-w-[170px] mx-auto overflow-visible select-none" aria-hidden="true">
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
        <ellipse cx="105" cy="74" rx="12" ry="7" className="fill-matcha-500/80 dark:fill-matcha-400/80" />

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
    quote: 'Bend with the wind of change, yet remain firmly rooted.',
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
        <path d="M96 114 Q70 120 48 135 Q75 125 96 114" className="fill-matcha-600 dark:fill-matcha-400/90" />
        <path d="M96 114 Q65 105 40 112 Q68 112 96 114" className="fill-matcha-500/80 dark:fill-matcha-300/80" />
        <path d="M96 114 Q72 90 52 82 Q74 98 96 114" className="fill-matcha-700 dark:fill-matcha-400" />

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
    quote: 'A quiet cup of green tea before crafting deep systems.',
    author: 'Tea Ceremony',
    renderSvg: () => (
      <svg viewBox="0 0 200 240" className="w-full max-w-[170px] mx-auto overflow-visible select-none" aria-hidden="true">
        <circle cx="100" cy="130" r="65" fill="url(#zenGlow)" opacity="0.35" />

        {/* Delicate Steam Wisps */}
        <path d="M95 95 Q90 75 98 60 T92 35" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 3" strokeOpacity="0.3" fill="none" className="animate-pulse" />
        <path d="M108 90 Q115 70 106 50 T114 25" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 3" strokeOpacity="0.25" fill="none" className="animate-pulse" />

        {/* Teapot Base Mat */}
        <ellipse cx="98" cy="192" rx="68" ry="12" className="fill-rice-paper-400/50 dark:fill-tea-slate-100/40" />

        {/* Kyusu Teapot Body */}
        <path
          d="M55 170 C48 140 70 120 100 120 C130 120 152 140 145 170 C140 185 60 185 55 170 Z"
          className="fill-rice-paper-300 dark:fill-tea-slate-100 stroke-matcha-600/50 dark:stroke-matcha-400/40"
          strokeWidth="1.8"
        />
        <path
          d="M80 120 C80 112 90 108 100 108 C110 108 120 112 120 120 Z"
          className="fill-matcha-500/20 dark:fill-matcha-700/40 stroke-matcha-600/60 dark:stroke-matcha-400/50"
          strokeWidth="1.5"
        />
        <circle cx="100" cy="106" r="3.5" className="fill-matcha-600 dark:fill-matcha-400" />

        {/* Teapot Spout & Handle */}
        <path d="M56 142 C45 138 36 128 32 120 C38 124 48 132 58 134 Z" className="fill-rice-paper-300 dark:fill-tea-slate-100 stroke-matcha-600/50" strokeWidth="1.5" />
        <path d="M142 145 L178 138 C182 137 184 142 180 145 L143 156 Z" className="fill-matcha-700/80 dark:fill-matcha-600/70" />

        {/* Teacup next to pot */}
        <path d="M136 182 C134 170 145 164 154 164 C163 164 174 170 172 182 C170 188 138 188 136 182 Z" className="fill-matcha-100/90 dark:fill-tea-slate-50 stroke-matcha-500/60" strokeWidth="1.2" />
        <ellipse cx="154" cy="167" rx="8" ry="2.5" className="fill-matcha-500 dark:fill-matcha-400" />

        {/* Japanese Hanko seal stamp */}
        <g transform="translate(150, 55)">
          <rect width="18" height="18" rx="3" className="fill-rose-700/80 dark:fill-rose-600/70" />
          <text x="9" y="13" textAnchor="middle" fill="#ffffff" fontSize="10" fontFamily="serif" fontWeight="bold">茶</text>
        </g>
      </svg>
    ),
  },

  // ── 4. Zen Quote Scroll (Thẻ Thơ Thư Pháp Tanzaku) ─────────────────────────
  {
    id: 'zen-scroll',
    kanji: '道',
    kanjiTitle: '短冊 · Washi Scroll',
    title: 'Beginner Mind',
    subtitle: 'Shoshin · 初心',
    quote: 'In the beginner’s mind there are many possibilities; in the expert’s few.',
    author: 'Shunryu Suzuki',
    renderSvg: () => (
      <svg viewBox="0 0 200 240" className="w-full max-w-[170px] mx-auto overflow-visible select-none" aria-hidden="true">
        <circle cx="100" cy="115" r="65" fill="url(#zenGlow)" opacity="0.35" />

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

        {/* Distant Mountain inside the scroll */}
        <path d="M66 140 Q85 110 100 125 T134 135 L134 190 L66 190 Z" className="fill-matcha-500/10 dark:fill-matcha-400/10" />
        <path d="M75 155 Q95 130 115 145 T134 150 L134 190 L75 190 Z" className="fill-matcha-500/15 dark:fill-matcha-400/15" />

        {/* Calligraphy Kanji characters */}
        <text x="100" y="90" textAnchor="middle" className="fill-ink-700 dark:fill-sage-100 font-serif text-[1.45rem] font-medium" style={{ letterSpacing: '0.1em' }}>
          初心
        </text>
        <text x="100" y="112" textAnchor="middle" className="fill-ink-400 dark:fill-sage-400 text-[0.6rem] uppercase tracking-widest font-sans">
          SHOSHIN
        </text>

        {/* Japanese Hanko seal stamp */}
        <g transform="translate(91, 155)">
          <rect width="18" height="18" rx="3" className="fill-rose-700/80 dark:fill-rose-600/70" />
          <text x="9" y="13" textAnchor="middle" fill="#ffffff" fontSize="10" fontFamily="serif" fontWeight="bold">道</text>
        </g>
      </svg>
    ),
  },

  // ── 5. Ensō (Vòng Tròn Thiền & Nét Cọ Thư Pháp) ────────────────────────────
  {
    id: 'zen-enso',
    kanji: '空',
    kanjiTitle: '円相 · Ensō Circle',
    title: 'Circle of Enlightenment',
    subtitle: 'Emptiness & Form',
    quote: 'Embrace imperfection: the circle is complete only in its open space.',
    author: 'Zen Philosophy',
    renderSvg: () => (
      <svg viewBox="0 0 200 240" className="w-full max-w-[170px] mx-auto overflow-visible select-none" aria-hidden="true">
        <circle cx="100" cy="120" r="70" fill="url(#zenGlow)" opacity="0.35" />

        {/* Sumi-e Brush Stroke Ensō with organic thickness and open gap */}
        <path
          d="M 125 45 C 175 60 185 135 155 178 C 125 218 55 215 32 165 C 10 115 35 55 95 44 C 115 40 135 48 140 56"
          fill="none"
          className="stroke-ink-700/85 dark:stroke-sage-200/85"
          strokeWidth="13"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ strokeDasharray: '480', strokeDashoffset: '10' }}
        />

        {/* Dry brush inner texture lines */}
        <path
          d="M 120 52 C 160 65 170 125 148 162 C 120 198 62 195 42 155 C 25 115 45 65 92 52"
          fill="none"
          className="stroke-matcha-600/50 dark:stroke-matcha-400/40"
          strokeWidth="3"
          strokeLinecap="round"
        />

        {/* Center Kanji character */}
        <text x="100" y="130" textAnchor="middle" className="fill-matcha-600/70 dark:fill-matcha-400/70 font-serif text-[2rem] font-light">
          無
        </text>

        {/* Japanese Hanko seal stamp */}
        <g transform="translate(145, 170)">
          <rect width="18" height="18" rx="3" className="fill-rose-700/80 dark:fill-rose-600/70" />
          <text x="9" y="13" textAnchor="middle" fill="#ffffff" fontSize="10" fontFamily="serif" fontWeight="bold">空</text>
        </g>
      </svg>
    ),
  },

  // ── 6. Matsu Bonsai (Cây Tùng Bách Bonsai Trên Chậu Gốm) ───────────────────
  {
    id: 'zen-bonsai',
    kanji: '松',
    kanjiTitle: '盆栽 · Matsu Bonsai',
    title: 'Pine on Stone',
    subtitle: 'Patience & Craft',
    quote: 'Great architecture, like bonsai, thrives on deliberate pruning.',
    author: 'Bonsai Master',
    renderSvg: () => (
      <svg viewBox="0 0 200 240" className="w-full max-w-[170px] mx-auto overflow-visible select-none" aria-hidden="true">
        <circle cx="100" cy="115" r="65" fill="url(#zenGlow)" opacity="0.35" />

        {/* Ceramic Planter Pot */}
        <path d="M45 180 L155 180 L145 205 L55 205 Z" className="fill-rice-paper-400 dark:fill-tea-slate-100 stroke-matcha-600/50" strokeWidth="1.5" />
        {/* Pot rim & little feet */}
        <rect x="40" y="176" width="120" height="5" rx="2" className="fill-rice-paper-500 dark:fill-tea-slate-50" />
        <rect x="62" y="205" width="12" height="4" rx="1" className="fill-rice-paper-500 dark:fill-tea-slate-50" />
        <rect x="126" y="205" width="12" height="4" rx="1" className="fill-rice-paper-500 dark:fill-tea-slate-50" />

        {/* Moss Mound inside pot */}
        <path d="M48 176 Q100 160 152 176 Z" className="fill-matcha-600/60 dark:fill-matcha-700/60" />

        {/* Gnarled Pine Trunk (S-curve) */}
        <path
          d="M95 174 C90 150 120 135 110 110 C100 85 75 80 85 55"
          fill="none"
          className="stroke-amber-900/80 dark:stroke-amber-600/70"
          strokeWidth="7"
          strokeLinecap="round"
        />
        {/* Branch 1 */}
        <path d="M108 120 Q145 115 155 125" fill="none" className="stroke-amber-900/80 dark:stroke-amber-600/70" strokeWidth="3.5" strokeLinecap="round" />
        {/* Branch 2 */}
        <path d="M96 90 Q55 85 45 95" fill="none" className="stroke-amber-900/80 dark:stroke-amber-600/70" strokeWidth="3.5" strokeLinecap="round" />

        {/* Pine Needle Cloud Clusters */}
        {/* Top cloud */}
        <ellipse cx="85" cy="50" rx="32" ry="14" className="fill-matcha-600/90 dark:fill-matcha-400/90" />
        <ellipse cx="75" cy="45" rx="20" ry="10" className="fill-matcha-500 dark:fill-matcha-300" />

        {/* Right cloud */}
        <ellipse cx="155" cy="120" rx="26" ry="12" className="fill-matcha-700/90 dark:fill-matcha-500/90" />
        <ellipse cx="150" cy="116" rx="16" ry="8" className="fill-matcha-500/80 dark:fill-matcha-300/80" />

        {/* Left cloud */}
        <ellipse cx="45" cy="92" rx="24" ry="11" className="fill-matcha-700/90 dark:fill-matcha-500/90" />
        <ellipse cx="48" cy="88" rx="15" ry="7" className="fill-matcha-500/80 dark:fill-matcha-300/80" />

        {/* Japanese Hanko seal stamp */}
        <g transform="translate(150, 45)">
          <rect width="18" height="18" rx="3" className="fill-rose-700/80 dark:fill-rose-600/70" />
          <text x="9" y="13" textAnchor="middle" fill="#ffffff" fontSize="10" fontFamily="serif" fontWeight="bold">松</text>
        </g>
      </svg>
    ),
  },

  // ── 7. Kintsugi Chawan (Bát Gốm Hàn Vàng Kintsugi) ──────────────────────────
  {
    id: 'zen-kintsugi',
    kanji: '繕',
    kanjiTitle: '金継ぎ · Kintsugi Vessel',
    title: 'Golden Repair',
    subtitle: 'Flaws into Gold',
    quote: 'Broken things mend with gold; challenges make systems stronger.',
    author: 'Kintsugi Wisdom',
    renderSvg: () => (
      <svg viewBox="0 0 200 240" className="w-full max-w-[170px] mx-auto overflow-visible select-none" aria-hidden="true">
        <circle cx="100" cy="125" r="65" fill="url(#zenGlow)" opacity="0.35" />

        {/* Shadow under tea bowl */}
        <ellipse cx="100" cy="188" rx="55" ry="10" className="fill-rice-paper-400/50 dark:fill-tea-slate-100/50" />

        {/* Chawan Tea Bowl Body */}
        <path
          d="M40 100 C36 145 65 180 100 180 C135 180 164 145 160 100 C155 90 45 90 40 100 Z"
          className="fill-rice-paper-200 dark:fill-tea-slate-100 stroke-matcha-600/40 dark:stroke-matcha-400/40"
          strokeWidth="2"
        />
        {/* Foot ring (Kodai) */}
        <path d="M80 180 L82 192 L118 192 L120 180" className="fill-rice-paper-300 dark:fill-tea-slate-50 stroke-matcha-600/40" strokeWidth="1.5" />

        {/* Inner Glaze Lip */}
        <ellipse cx="100" cy="100" rx="60" ry="14" className="fill-matcha-100/50 dark:fill-tea-slate-200/60 stroke-matcha-600/50" strokeWidth="1.5" />

        {/* ── Kintsugi Golden Repair Seams (shimmering gold lacquer) */}
        <path
          d="M72 100 Q80 125 75 140 T92 165 L100 180"
          fill="none"
          stroke="#D4AF37"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Branch fissure 1 */}
        <path d="M76 130 Q95 125 110 135" fill="none" stroke="#D4AF37" strokeWidth="1.8" strokeLinecap="round" />
        {/* Branch fissure 2 */}
        <path d="M92 165 Q115 160 128 170" fill="none" stroke="#D4AF37" strokeWidth="1.8" strokeLinecap="round" />

        {/* Gold leaf shimmer droplets */}
        <circle cx="75" cy="130" r="2.5" fill="#F3E5AB" />
        <circle cx="110" cy="135" r="2" fill="#F3E5AB" />
        <circle cx="92" cy="165" r="2.5" fill="#F3E5AB" />

        {/* Japanese Hanko seal stamp */}
        <g transform="translate(150, 65)">
          <rect width="18" height="18" rx="3" className="fill-rose-700/80 dark:fill-rose-600/70" />
          <text x="9" y="13" textAnchor="middle" fill="#ffffff" fontSize="10" fontFamily="serif" fontWeight="bold">繕</text>
        </g>
      </svg>
    ),
  },

  // ── 8. Andon Paper Lantern & Moon (Đèn Lồng Giấy Shoji & Trăng Tĩnh Lặng) ──
  {
    id: 'zen-lantern',
    kanji: '照',
    kanjiTitle: '行灯 · Andon Lantern',
    title: 'Luminance & Moon',
    subtitle: 'Clarity in Darkness',
    quote: 'In the calm light of focus, complex architectures become clear.',
    author: 'Night Contemplation',
    renderSvg: () => (
      <svg viewBox="0 0 200 240" className="w-full max-w-[170px] mx-auto overflow-visible select-none" aria-hidden="true">
        {/* Crescent Moon in distance */}
        <path
          d="M135 35 A24 24 0 0 0 155 70 A28 28 0 1 1 135 35 Z"
          className="fill-amber-300/40 dark:fill-amber-200/35"
        />

        {/* Soft Warm Lantern Glow */}
        <circle cx="100" cy="140" r="55" className="fill-amber-300/20 dark:fill-amber-400/15" />

        {/* Andon Lantern Roof / Cap */}
        <path d="M60 90 L140 90 L145 98 L55 98 Z" className="fill-ink-700 dark:fill-tea-slate-50 stroke-ink-800" strokeWidth="1.2" />
        <rect x="94" y="80" width="12" height="10" rx="2" className="fill-ink-700 dark:fill-tea-slate-50" />
        <ellipse cx="100" cy="78" rx="8" ry="4" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-matcha-500" />

        {/* Shoji Paper Lattice Window Box */}
        <rect
          x="62"
          y="98"
          width="76"
          height="85"
          className="fill-amber-50/70 dark:fill-amber-950/40 stroke-ink-700 dark:stroke-tea-slate-50"
          strokeWidth="2"
        />

        {/* Shoji Wood Grid Slats */}
        <line x1="87" y1="98" x2="87" y2="183" className="stroke-ink-700/80 dark:stroke-tea-slate-50" strokeWidth="1.5" />
        <line x1="113" y1="98" x2="113" y2="183" className="stroke-ink-700/80 dark:stroke-tea-slate-50" strokeWidth="1.5" />
        <line x1="62" y1="126" x2="138" y2="126" className="stroke-ink-700/80 dark:stroke-tea-slate-50" strokeWidth="1.5" />
        <line x1="62" y1="155" x2="138" y2="155" className="stroke-ink-700/80 dark:stroke-tea-slate-50" strokeWidth="1.5" />

        {/* Inner Candle Flame Glow */}
        <ellipse cx="100" cy="142" rx="7" ry="12" className="fill-amber-400/90 dark:fill-amber-300/90 animate-pulse" />
        <ellipse cx="100" cy="144" rx="3.5" ry="6" fill="#ffffff" className="animate-pulse" />

        {/* Wooden Base & Sturdy Legs */}
        <rect x="58" y="183" width="84" height="7" rx="1.5" className="fill-ink-700 dark:fill-tea-slate-50" />
        <rect x="66" y="190" width="8" height="14" rx="1" className="fill-ink-700 dark:fill-tea-slate-50" />
        <rect x="126" y="190" width="8" height="14" rx="1" className="fill-ink-700 dark:fill-tea-slate-50" />

        {/* Japanese Hanko seal stamp */}
        <g transform="translate(35, 55)">
          <rect width="18" height="18" rx="3" className="fill-rose-700/80 dark:fill-rose-600/70" />
          <text x="9" y="13" textAnchor="middle" fill="#ffffff" fontSize="10" fontFamily="serif" fontWeight="bold">照</text>
        </g>
      </svg>
    ),
  },
]

export default function ZenStillLife({ currentSlug = '' }) {
  const [activeItem, setActiveItem] = useState(STILL_LIFE_ITEMS[0])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [mounted, setMounted] = useState(false)
  const [isTransitioning, setIsTransitioning] = useState(false)

  // Pure random pick on every single page load / route navigation
  useEffect(() => {
    const randomIndex = Math.floor(Math.random() * STILL_LIFE_ITEMS.length)
    setCurrentIndex(randomIndex)
    setActiveItem(STILL_LIFE_ITEMS[randomIndex])
    setMounted(true)
  }, [currentSlug])

  // Click to smoothly cycle to a different artwork
  const handleCycle = () => {
    setIsTransitioning(true)
    setTimeout(() => {
      const nextIndex = (currentIndex + 1) % STILL_LIFE_ITEMS.length
      setCurrentIndex(nextIndex)
      setActiveItem(STILL_LIFE_ITEMS[nextIndex])
      setIsTransitioning(false)
    }, 150)
  }

  if (!mounted) {
    // Placeholder during SSR hydration
    return (
      <div className="h-full flex flex-col items-center justify-center p-4 min-h-[300px]" />
    )
  }

  return (
    <div 
      onClick={handleCycle}
      title="Click to cycle next Zen artwork"
      className="h-full flex flex-col justify-between p-3.5 select-none cursor-pointer group rounded-xl transition-colors hover:bg-rice-paper-200/40 dark:hover:bg-tea-slate-200/20"
    >
      {/* ── Top Header Badge with Counter */}
      <div className="flex items-center justify-between pt-1 px-1">
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[0.68rem] font-serif tracking-wider bg-matcha-100/60 dark:bg-matcha-900/30 text-matcha-700 dark:text-matcha-300 border border-matcha-200/50 dark:border-matcha-800/40 transition-colors group-hover:border-matcha-400 dark:group-hover:border-matcha-600">
          <span className="text-[0.6rem]">✦</span> {activeItem.kanjiTitle}
        </span>
        <span className="text-[0.65rem] font-mono text-ink-300 dark:text-sage-600 transition-colors group-hover:text-matcha-500">
          {currentIndex + 1}/{STILL_LIFE_ITEMS.length}
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
      <div className={`my-auto py-2 transition-all duration-300 ease-out group-hover:scale-[1.04] ${
        isTransitioning ? 'opacity-0 scale-95' : 'opacity-100 scale-100'
      }`}>
        {activeItem.renderSvg()}
      </div>

      {/* ── Bottom Inscription / Thought Card */}
      <div className={`mt-auto px-1.5 pb-1 text-center transition-opacity duration-300 ${
        isTransitioning ? 'opacity-0' : 'opacity-100'
      }`}>
        <p className="font-serif italic text-[0.82rem] leading-relaxed text-ink-600 dark:text-sage-300 mb-1.5">
          &ldquo;{activeItem.quote}&rdquo;
        </p>
        <div className="flex items-center justify-center gap-2">
          <span className="text-[0.65rem] tracking-wider uppercase text-ink-400 dark:text-sage-500 font-sans">
            — {activeItem.author}
          </span>
        </div>
        <p className="mt-2 text-[0.62rem] text-ink-300/80 dark:text-sage-600/80 font-serif italic">
          ✦ Tap to cycle inspiration
        </p>
      </div>
    </div>
  )
}
