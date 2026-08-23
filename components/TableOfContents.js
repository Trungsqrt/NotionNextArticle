"use client";

import { useState, useEffect, useCallback } from 'react';

// Helper to extract numeric heading level from block type (e.g. "heading_1" -> 1)
function getHeadingLevel(type) {
  const match = type?.match(/^heading_(\d+)$/);
  return match ? parseInt(match[1], 10) : 1;
}

export default function TableOfContents({ blocks }) {
  const [activeId, setActiveId] = useState('');

  // ── High-performance Scrollspy Implementation ───────────────────────────
  useEffect(() => {
    if (!blocks || blocks.length === 0) return;

    const headingIds = blocks
      .filter((block) => block.type?.startsWith('heading_'))
      .map((block) => block.id.replace(/-/g, ''));

    if (headingIds.length === 0) return;

    const updateActiveHeading = () => {
      const headerThreshold = 140; // Pixels below viewport top to switch active heading
      let currentActive = headingIds[0];

      // Find the heading that is closest to or above the threshold
      for (let i = 0; i < headingIds.length; i++) {
        const id = headingIds[i];
        const el = document.getElementById(id);
        if (el) {
          const rect = el.getBoundingClientRect();
          if (rect.top <= headerThreshold) {
            currentActive = id;
          } else {
            break;
          }
        }
      }

      // If scrolled to the bottom of the page, activate the last heading
      const isAtBottom =
        window.innerHeight + window.scrollY >=
        document.documentElement.scrollHeight - 60;
      if (isAtBottom && headingIds.length > 0) {
        currentActive = headingIds[headingIds.length - 1];
      }

      setActiveId(currentActive);
    };

    // Run on mount + after a brief delay for hydration
    updateActiveHeading();
    const initTimer = setTimeout(updateActiveHeading, 150);

    // RAF-throttled scroll listener for 60/120fps smoothness
    let ticking = false;
    const onScroll = () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          updateActiveHeading();
          ticking = false;
        });
        ticking = true;
      }
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });

    return () => {
      clearTimeout(initTimer);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [blocks]);

  // Flash highlight effect on target heading when clicked
  const handleHeadingClick = useCallback((e, anchorId) => {
    setActiveId(anchorId);
    const el = document.getElementById(anchorId);
    if (el) {
      el.classList.remove('heading-highlight-flash');
      void el.offsetWidth; // Force reflow
      el.classList.add('heading-highlight-flash');
      setTimeout(() => {
        el.classList.remove('heading-highlight-flash');
      }, 2000);
    }
  }, []);

  if (!blocks || blocks.length === 0) return null;

  const headings = blocks.filter((block) => block.type?.startsWith('heading_'));
  if (headings.length === 0) return null;

  return (
    <div className="sticky top-32 z-50 w-8 shrink-0 group">
      
      {/* Collapsed State: Hierarchical Scrollspy minimap dashes */}
      <div className="flex flex-col items-end gap-3 py-2 group-hover:opacity-0 transition-opacity duration-200 w-8 cursor-pointer select-none">
        {headings.map((h) => {
          const anchorId = h.id.replace(/-/g, '');
          const isActive = activeId === anchorId;
          const level = getHeadingLevel(h.type);

          // Dynamic dash size based on level & active state
          let widthClass = 'w-1.5';
          if (level === 1) {
            widthClass = isActive ? 'w-5' : 'w-4';
          } else if (level === 2) {
            widthClass = isActive ? 'w-3.5' : 'w-2.5';
          } else {
            widthClass = isActive ? 'w-2.5' : 'w-1.5';
          }

          return (
            <a
              key={`dash-${h.id}`}
              href={`#${anchorId}`}
              onClick={(e) => handleHeadingClick(e, anchorId)}
              aria-label={`Jump to heading`}
              className="flex justify-end items-center py-0.5 group/dash"
            >
              <div 
                className={`h-0.5 rounded-full transition-all duration-300 ${widthClass} ${
                  isActive 
                    ? 'bg-matcha-500 dark:bg-matcha-400 shadow-[0_0_8px_rgba(122,139,105,0.6)]' 
                    : 'bg-neutral-300 dark:bg-neutral-600 hover:bg-neutral-400 dark:hover:bg-neutral-500'
                }`} 
              />
            </a>
          );
        })}
      </div>

      {/* Expanded State: Clean Notion-style Panel that OVERLAYS page content */}
      <nav 
        onWheel={(e) => e.stopPropagation()}
        className="absolute top-0 right-0 w-72 max-h-[calc(100vh-10rem)] overflow-y-auto overscroll-contain bg-white dark:bg-[#191919] border border-neutral-200 dark:border-neutral-800 shadow-2xl rounded-xl p-3 opacity-0 translate-x-2 pointer-events-none group-hover:opacity-100 group-hover:translate-x-0 group-hover:pointer-events-auto transition-all duration-200 ease-out z-50"
      >
        <div className="flex items-center gap-2 mb-2 px-2 py-1">
          <svg className="w-4 h-4 text-neutral-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h7"></path></svg>
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500 m-0 select-none">
            On this page
          </h3>
        </div>
        
        <ul className="space-y-0.5 text-[13px] leading-relaxed">
          {headings.map((heading) => {
            const type = heading.type;
            const level = getHeadingLevel(type);
            const text = heading[type]?.rich_text?.map(t => t.plain_text).join('') || '';
            const anchorId = heading.id.replace(/-/g, '');
            const isActive = activeId === anchorId;
            
            // Mathematical padding based on heading level
            const paddingLeft = Math.max(0, (level - 1) * 16);

            return (
              <li key={heading.id} style={{ paddingLeft: `${paddingLeft}px` }}>
                <a 
                  href={`#${anchorId}`}
                  onClick={(e) => handleHeadingClick(e, anchorId)}
                  className={`block py-1 px-2 rounded-md transition-colors duration-150 line-clamp-1 ${
                    isActive 
                      ? 'text-matcha-600 dark:text-matcha-300 bg-matcha-50/70 dark:bg-matcha-900/30 font-medium' 
                      : 'text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800/60 hover:text-neutral-900 dark:hover:text-neutral-200'
                  }`}
                >
                  {text}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
