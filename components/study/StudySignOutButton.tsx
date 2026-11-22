'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function StudySignOutButton() {
  const router = useRouter()
  const [isPending, setIsPending] = useState(false)

  async function handleSignOut() {
    if (isPending) return
    setIsPending(true)
    try {
      await fetch('/api/study/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revokeAll: false }),
      })
    } finally {
      router.replace('/study/login')
      router.refresh()
    }
  }

  return (
    <button
      type="button"
      onClick={handleSignOut}
      disabled={isPending}
      className="px-3.5 py-1.5 rounded-zen text-[0.8rem] font-medium text-ink-600 dark:text-sage-300 border border-rice-paper-400/80 dark:border-tea-slate-50/60 hover:border-matcha-400/70 hover:text-matcha-600 dark:hover:text-matcha-300 transition-colors duration-200 motion-reduce:transition-none disabled:opacity-50"
    >
      {isPending ? 'Signing out…' : 'Sign out'}
    </button>
  )
}
