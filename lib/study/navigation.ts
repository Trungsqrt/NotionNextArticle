/**
 * lib/study/navigation.ts — Pure helpers for Private Study Room navigation state
 * ──────────────────────────────────────────────────────────────────────────────
 * Determines active, pending, and duplicate tab navigation states without
 * coupling to React or Next.js internals, making transitions predictable and
 * easy to unit-test.
 */

export interface StudyNavTab {
  href: string
  label: string
}

export const STUDY_NAV_TABS: readonly StudyNavTab[] = [
  { href: '/study', label: 'Dashboard' },
  { href: '/study/flashcards', label: 'Active Recall' },
  { href: '/study/practice', label: 'Practice' },
  { href: '/study/exams', label: 'Mock Exams' },
] as const

export type StudyTabVisualState = 'active' | 'active-leaving' | 'pending' | 'inactive'

export function splitStudyHref(href: string): { pathname: string; search: string } {
  const hashIndex = href.indexOf('#')
  const withoutHash = hashIndex === -1 ? href : href.slice(0, hashIndex)
  const queryIndex = withoutHash.indexOf('?')
  const rawPath = queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex)
  const rawSearch = queryIndex === -1 ? '' : withoutHash.slice(queryIndex + 1)

  const trimmed = rawPath.replace(/\/+$/, '')
  return {
    pathname: trimmed || '/',
    search: rawSearch,
  }
}

export function isStudyTabActive(pathname: string, tabHref: string): boolean {
  const current = splitStudyHref(pathname || '/study').pathname
  const target = splitStudyHref(tabHref).pathname
  if (target === '/study') {
    return current === '/study'
  }
  return current === target || current.startsWith(`${target}/`)
}

export function isSameStudyLocation(
  currentPathname: string,
  currentSearch: string,
  targetHref: string
): boolean {
  const currentPath = splitStudyHref(currentPathname || '/study').pathname
  const normalizedCurrentSearch = currentSearch.replace(/^\?/, '')
  const target = splitStudyHref(targetHref)
  return currentPath === target.pathname && normalizedCurrentSearch === target.search
}

export function isDuplicateStudyNavigation(params: {
  currentPathname: string
  currentSearch: string
  pendingHref: string | null
  targetHref: string
}): boolean {
  const { currentPathname, currentSearch, pendingHref, targetHref } = params
  if (pendingHref) {
    const pending = splitStudyHref(pendingHref)
    const target = splitStudyHref(targetHref)
    return pending.pathname === target.pathname && pending.search === target.search
  }
  return isSameStudyLocation(currentPathname, currentSearch, targetHref)
}

export function resolveStudyTabState(params: {
  pathname: string
  pendingHref: string | null
  tabHref: string
}): StudyTabVisualState {
  const { pathname, pendingHref, tabHref } = params
  if (pendingHref) {
    const pendingPath = splitStudyHref(pendingHref).pathname
    if (isStudyTabActive(pendingPath, tabHref)) {
      return 'pending'
    }
    if (isStudyTabActive(pathname, tabHref)) {
      return 'active-leaving'
    }
    return 'inactive'
  }
  return isStudyTabActive(pathname, tabHref) ? 'active' : 'inactive'
}

export function getStudyRouteLabel(href: string | null): string {
  if (!href) return ''
  const targetPath = splitStudyHref(href).pathname
  const matched = STUDY_NAV_TABS.find((tab) => isStudyTabActive(targetPath, tab.href))
  return matched ? matched.label : 'Study Room'
}

export function isPlainLeftClick(event: {
  button: number
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  )
}
