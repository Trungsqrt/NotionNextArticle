'use client'

import { useState, useRef, type FormEvent } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'

const inputBaseClass = [
  'w-full rounded-zen px-3.5 py-2.5 text-[0.92rem]',
  'bg-rice-paper-50 dark:bg-tea-slate-300',
  'text-ink-700 dark:text-sage-100',
  'placeholder:text-ink-300 dark:placeholder:text-sage-500',
  'border border-rice-paper-400/90 dark:border-tea-slate-50/70',
  'transition-colors duration-200 ease-zen motion-reduce:transition-none',
  'focus:outline-none focus:border-matcha-500 dark:focus:border-matcha-400',
  'focus-visible:ring-2 focus-visible:ring-matcha-400/40 dark:focus-visible:ring-matcha-500/40',
  'disabled:opacity-60 disabled:cursor-not-allowed',
].join(' ')

function resolveSafeNextPath(rawNext: string | null): string {
  if (!rawNext) return '/study'
  const trimmed = rawNext.trim()
  if (trimmed === '/study' || (trimmed.startsWith('/study/') && !trimmed.startsWith('/study/login'))) {
    return trimmed
  }
  return '/study'
}

export default function LoginForm({ isConfigured }: { isConfigured: boolean }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const submitLockRef = useRef(false)

  const [username, setUsername] = useState('')
  const [accessKey, setAccessKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (submitLockRef.current || isSubmitting) return

    setErrorMessage('')

    if (!isConfigured) {
      setErrorMessage('Study Room authentication is not configured yet.')
      return
    }

    const trimmedUser = username.trim()
    if (!trimmedUser) {
      setErrorMessage('Please enter your username.')
      return
    }
    if (!accessKey) {
      setErrorMessage('Please enter your access key.')
      return
    }

    submitLockRef.current = true
    setIsSubmitting(true)

    try {
      const response = await fetch('/api/study/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          username: trimmedUser,
          accessKey,
        }),
      })

      if (response.ok) {
        const nextPath = resolveSafeNextPath(searchParams?.get('next') ?? null)
        router.replace(nextPath)
        router.refresh()
        return
      }

      let message = 'Invalid username or access key.'
      try {
        const data = (await response.json()) as { error?: string }
        if (typeof data?.error === 'string' && data.error.trim()) {
          message = data.error
        }
      } catch {
        // Keep generic message
      }
      setErrorMessage(message)
      setAccessKey('')
    } catch {
      setErrorMessage('Unable to reach the server. Please check your connection and try again.')
    } finally {
      submitLockRef.current = false
      setIsSubmitting(false)
    }
  }

  return (
    <div className="max-w-md mx-auto px-4 sm:px-6 py-14 sm:py-20">
      <header className="mb-8 text-center">
        <span className="inline-flex items-center gap-2 text-[0.72rem] uppercase tracking-[0.22em] font-medium text-matcha-600 dark:text-matcha-400 mb-3">
          <span className="w-1.5 h-1.5 rounded-full bg-matcha-500 dark:bg-matcha-400" aria-hidden="true" />
          Private Study Room
        </span>
        <h1 className="font-serif font-medium text-2xl sm:text-3xl text-ink-700 dark:text-sage-100 leading-tight mb-2">
          Quiet Entry
        </h1>
        <p className="text-[0.9rem] leading-relaxed text-ink-500 dark:text-sage-400">
          Sign in with your provisioned username and access key to enter your personal study workspace.
        </p>
      </header>

      {!isConfigured && (
        <div
          role="status"
          className="mb-6 rounded-card px-5 py-4 bg-rice-paper-200/90 dark:bg-tea-slate-200/80 border border-earth-beige/80 dark:border-tea-slate-50/70"
        >
          <p className="text-[0.86rem] font-medium text-ink-700 dark:text-sage-100 mb-1">
            Study Room is not configured
          </p>
          <p className="text-[0.8rem] leading-relaxed text-ink-500 dark:text-sage-400 m-0">
            Configure <code className="font-mono text-[0.76rem]">STUDY_NOTION_*</code> and{' '}
            <code className="font-mono text-[0.76rem]">STUDY_SESSION_SECRET</code> in your server environment to enable sign-in.
          </p>
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        noValidate
        className="rounded-card p-6 sm:p-7 bg-rice-paper-50/90 dark:bg-tea-slate-200/65 border border-rice-paper-400/75 dark:border-tea-slate-50/50 shadow-zen-sm space-y-5"
      >
        {errorMessage && (
          <div
            role="alert"
            className="rounded-zen px-4 py-3 bg-rose-50/80 dark:bg-rose-950/30 border border-earth-rust/40 dark:border-rose-400/40 text-[0.84rem] text-earth-rust dark:text-rose-200"
          >
            {errorMessage}
          </div>
        )}

        <div>
          <label
            htmlFor="study-username"
            className="block text-[0.84rem] font-medium text-ink-700 dark:text-sage-200 mb-1.5"
          >
            Username
          </label>
          <input
            id="study-username"
            name="username"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            maxLength={64}
            disabled={!isConfigured || isSubmitting}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="e.g. jun.mai"
            className={inputBaseClass}
          />
        </div>

        <div>
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <label
              htmlFor="study-access-key"
              className="block text-[0.84rem] font-medium text-ink-700 dark:text-sage-200"
            >
              Access Key
            </label>
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              disabled={!isConfigured || isSubmitting}
              className="text-[0.75rem] text-ink-400 dark:text-sage-400 hover:text-matcha-600 dark:hover:text-matcha-300 transition-colors duration-150 motion-reduce:transition-none"
            >
              {showKey ? 'Hide' : 'Show'}
            </button>
          </div>
          <input
            id="study-access-key"
            name="accessKey"
            type={showKey ? 'text' : 'password'}
            autoComplete="current-password"
            required
            maxLength={256}
            disabled={!isConfigured || isSubmitting}
            value={accessKey}
            onChange={(e) => setAccessKey(e.target.value)}
            placeholder="Enter your issued access key"
            className={`${inputBaseClass} font-mono text-[0.86rem]`}
          />
        </div>

        <button
          type="submit"
          disabled={!isConfigured || isSubmitting}
          aria-busy={isSubmitting}
          className={[
            'w-full inline-flex items-center justify-center gap-2',
            'px-5 py-2.5 rounded-zen text-[0.9rem] font-medium text-white',
            'bg-matcha-500 hover:bg-matcha-600 dark:bg-matcha-600 dark:hover:bg-matcha-500',
            'shadow-zen-sm hover:shadow-matcha',
            'transition-all duration-200 ease-zen motion-reduce:transition-none',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-matcha-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-rice-paper-50 dark:focus-visible:ring-offset-tea-slate-200',
            'disabled:opacity-55 disabled:cursor-not-allowed disabled:shadow-none',
          ].join(' ')}
        >
          {isSubmitting ? 'Verifying…' : 'Enter Study Room'}
        </button>

        <p className="text-[0.76rem] text-center text-ink-400 dark:text-sage-500 pt-1 m-0">
          Access is manually provisioned. Self-registration is disabled.
        </p>
      </form>

      <div className="mt-6 text-center">
        <Link
          href="/"
          className="text-[0.8rem] text-ink-400 dark:text-sage-400 hover:text-matcha-600 dark:hover:text-matcha-300 transition-colors duration-200 motion-reduce:transition-none no-underline"
        >
          ← Return to Knowledge Hub
        </Link>
      </div>
    </div>
  )
}
