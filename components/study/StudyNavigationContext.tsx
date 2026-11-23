'use client'

import {
  createContext,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
} from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  isDuplicateStudyNavigation,
  isPlainLeftClick,
  isSameStudyLocation,
} from '../../lib/study/navigation'

const NAVIGATION_SAFETY_TIMEOUT_MS = 12_000

interface StudyNavigationContextValue {
  pendingHref: string | null
  isNavigating: boolean
  navigate: (href: string) => void
  clearPending: () => void
}

const StudyNavigationContext = createContext<StudyNavigationContextValue | null>(null)

function RouteSettlementWatcher({ onSettle }: { onSettle: () => void }) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const searchKey = searchParams?.toString() ?? ''
  const isFirstRender = useRef(true)

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false
      return
    }
    onSettle()
  }, [pathname, searchKey, onSettle])

  return null
}

export function StudyNavigationProvider({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname() || '/study'
  const [pendingHref, setPendingHref] = useState<string | null>(null)
  const [isTransitionPending, startTransition] = useTransition()
  const transitionSeenRef = useRef(false)
  const safetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearSafetyTimer = useCallback(() => {
    if (safetyTimerRef.current !== null) {
      clearTimeout(safetyTimerRef.current)
      safetyTimerRef.current = null
    }
  }, [])

  const clearPending = useCallback(() => {
    clearSafetyTimer()
    transitionSeenRef.current = false
    setPendingHref(null)
  }, [clearSafetyTimer])

  // Track transition lifecycle so cancellations or server errors also clear pending state
  useEffect(() => {
    if (isTransitionPending) {
      transitionSeenRef.current = true
      return
    }
    if (transitionSeenRef.current) {
      clearPending()
    }
  }, [isTransitionPending, clearPending])

  // Clear pending state on browser back/forward
  useEffect(() => {
    function handlePopState() {
      clearPending()
    }
    window.addEventListener('popstate', handlePopState)
    return () => {
      window.removeEventListener('popstate', handlePopState)
      clearSafetyTimer()
    }
  }, [clearPending, clearSafetyTimer])

  const navigate = useCallback(
    (href: string) => {
      const currentSearch =
        typeof window !== 'undefined' ? window.location.search : ''

      if (
        isDuplicateStudyNavigation({
          currentPathname: pathname,
          currentSearch,
          pendingHref,
          targetHref: href,
        })
      ) {
        return
      }

      // If user clicks back onto the currently active route while another route is pending,
      // cancel the pending indicator cleanly.
      if (pendingHref && isSameStudyLocation(pathname, currentSearch, href)) {
        clearPending()
        return
      }

      clearSafetyTimer()
      transitionSeenRef.current = false
      setPendingHref(href)

      safetyTimerRef.current = setTimeout(() => {
        clearPending()
      }, NAVIGATION_SAFETY_TIMEOUT_MS)

      startTransition(() => {
        router.push(href)
      })
    },
    [pathname, pendingHref, router, clearPending, clearSafetyTimer]
  )

  const value = useMemo<StudyNavigationContextValue>(
    () => ({
      pendingHref,
      isNavigating: Boolean(pendingHref) || isTransitionPending,
      navigate,
      clearPending,
    }),
    [pendingHref, isTransitionPending, navigate, clearPending]
  )

  return (
    <StudyNavigationContext.Provider value={value}>
      <Suspense fallback={null}>
        <RouteSettlementWatcher onSettle={clearPending} />
      </Suspense>
      {children}
    </StudyNavigationContext.Provider>
  )
}

export function useStudyNavigation(): StudyNavigationContextValue {
  const ctx = useContext(StudyNavigationContext)
  if (!ctx) {
    return {
      pendingHref: null,
      isNavigating: false,
      navigate: () => {},
      clearPending: () => {},
    }
  }
  return ctx
}

type StudyLinkProps = Omit<ComponentProps<typeof Link>, 'href'> & {
  href: string
}

/**
 * Drop-in Next.js Link for Study Room routes that triggers immediate
 * navigation feedback and prevents accidental duplicate navigations.
 */
export function StudyLink({ href, onClick, ...props }: StudyLinkProps) {
  const { navigate } = useStudyNavigation()

  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event)
    if (event.defaultPrevented) return
    if (props.target && props.target !== '_self') return
    if (!isPlainLeftClick(event)) return

    event.preventDefault()
    navigate(href)
  }

  return <Link href={href} onClick={handleClick} {...props} />
}
