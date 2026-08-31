"use client"

/**
 * MermaidDiagram.js — Wabi-Sabi / Zen Minimalist Mermaid Diagram Renderer
 * ───────────────────────────────────────────────────────────────────────
 * Provides global default styling for all Mermaid diagrams across the project.
 * Automatically synchronizes with Dark / Light theme without requiring manual %%{init}%%.
 *
 * Theme Design:
 * • Light Mode: Washi Paper & Incense (#f0ece1 / #33302a / #8a7f70)
 * • Dark Mode:  Sumi Ink & Charcoal  (#26231f / #d9d0c1 / #6e6659)
 * • Typography: Noto Serif JP / Georgia Serif
 * • Style:      Organic handDrawn look with softened SVG geometry
 */

import { useState, useEffect, useRef, useId } from 'react'

export const WABI_SABI_MERMAID_THEME = {
  light: {
    theme: 'base',
    look: 'handDrawn',
    fontFamily: '"Noto Serif JP", Georgia, serif',
    themeVariables: {
      darkMode: false,
      background: '#f8f5ee',
      primaryColor: '#f0ece1',        // Washi paper fill
      primaryTextColor: '#33302a',    // Dark tea text
      primaryBorderColor: '#c2b9aa',  // Muted stone
      lineColor: '#8a7f70',           // Soft ink
      textColor: '#665e52',
      secondaryColor: '#e5dfd3',
      secondaryBorderColor: '#aba08f',
      clusterBkg: '#f8f5ee',
      clusterBorder: '#d9d2c5',
      mainBkg: '#f0ece1',
      nodeBorder: '#c2b9aa',
      nodeTextColor: '#33302a',
      edgeLabelBackground: '#f8f5ee',
      actorBkg: '#f0ece1',
      actorBorder: '#c2b9aa',
      actorTextColor: '#33302a',
      actorLineColor: '#8a7f70',
      signalColor: '#8a7f70',
      signalTextColor: '#33302a',
      labelBoxBkgColor: '#f0ece1',
      labelBoxBorderColor: '#c2b9aa',
      labelTextColor: '#33302a',
      loopTextColor: '#665e52',
      noteBorderColor: '#c2b9aa',
      noteBkgColor: '#e5dfd3',
      noteTextColor: '#33302a',
      activationBorderColor: '#aba08f',
      activationBkgColor: '#e5dfd3',
      sequenceNumberColor: '#33302a',
      git0: '#8a7f70',
      git1: '#aba08f',
      git2: '#c2b9aa',
      git3: '#665e52',
    },
  },
  dark: {
    theme: 'base',
    look: 'handDrawn',
    fontFamily: '"Noto Serif JP", Georgia, serif',
    themeVariables: {
      darkMode: true,
      background: '#1c1b18',
      primaryColor: '#26231f',        // Warm charcoal fill
      primaryTextColor: '#d9d0c1',    // Sumi off-white
      primaryBorderColor: '#4a4338',  // Stone edge
      lineColor: '#6e6659',           // Faded ink
      textColor: '#8c8273',
      secondaryColor: '#302a24',
      secondaryBorderColor: '#54493e',
      clusterBkg: '#1c1b18',
      clusterBorder: '#332f28',
      mainBkg: '#26231f',
      nodeBorder: '#4a4338',
      nodeTextColor: '#d9d0c1',
      edgeLabelBackground: '#1c1b18',
      actorBkg: '#26231f',
      actorBorder: '#4a4338',
      actorTextColor: '#d9d0c1',
      actorLineColor: '#6e6659',
      signalColor: '#6e6659',
      signalTextColor: '#d9d0c1',
      labelBoxBkgColor: '#26231f',
      labelBoxBorderColor: '#4a4338',
      labelTextColor: '#d9d0c1',
      loopTextColor: '#8c8273',
      noteBorderColor: '#4a4338',
      noteBkgColor: '#302a24',
      noteTextColor: '#d9d0c1',
      activationBorderColor: '#54493e',
      activationBkgColor: '#302a24',
      sequenceNumberColor: '#d9d0c1',
      git0: '#6e6659',
      git1: '#54493e',
      git2: '#4a4338',
      git3: '#8c8273',
    },
  },
}

export default function MermaidDiagram({ code, isDark, className = '' }) {
  const containerRef = useRef(null)
  const [svg, setSvg] = useState('')
  const [error, setError] = useState(null)
  const [mounted, setMounted] = useState(false)
  const rawId = useId().replace(/[^a-zA-Z0-9_-]/g, '_')
  const renderCounter = useRef(0)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!code || !mounted) return
    let cancelled = false

    async function renderDiagram() {
      try {
        const mermaid = (await import('mermaid')).default
        const themeConfig = isDark ? WABI_SABI_MERMAID_THEME.dark : WABI_SABI_MERMAID_THEME.light

        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'loose',
          ...themeConfig,
        })

        renderCounter.current += 1
        const uniqueId = `mermaid_${rawId}_${renderCounter.current}`
        const { svg: renderedSvg } = await mermaid.render(uniqueId, code)

        if (!cancelled) {
          setError(null)
          setSvg(renderedSvg)
        }
      } catch (err) {
        if (!cancelled) {
          console.error('Mermaid render error:', err)
          setError(String(err?.message || err))
        }
      }
    }

    renderDiagram()
    return () => {
      cancelled = true
    }
  }, [code, isDark, mounted, rawId])

  if (error) {
    return (
      <div className="my-6 p-4 rounded-xl border border-rose-200/80 dark:border-rose-900/60 bg-rose-50/80 dark:bg-rose-950/20 text-rose-700 dark:text-rose-300 text-sm font-mono">
        <span className="font-semibold">Mermaid syntax error: </span>
        {error}
      </div>
    )
  }

  if (!svg) {
    return (
      <div className="my-6 flex items-center justify-center py-12 text-ink-300 dark:text-sage-500">
        <svg
          className="animate-spin mr-2.5 text-matcha-600 dark:text-matcha-400"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
        <span className="text-xs font-serif italic">Rendering Zen diagram…</span>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className={`mermaid-diagram-container my-6 flex justify-center items-center p-6 sm:p-8 rounded-xl border overflow-x-auto shadow-zen-sm transition-colors duration-300 ${
        isDark
          ? 'bg-[#1c1b18] border-[#332f28] text-[#d9d0c1]'
          : 'bg-[#f8f5ee] border-[#d9d2c5] text-[#33302a]'
      } ${className}`}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
