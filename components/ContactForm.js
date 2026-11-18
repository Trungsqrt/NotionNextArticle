'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { SUPPORTED_LOCALES, DEFAULT_LOCALE, getLocaleMeta } from '../lib/locales'
import {
  CONTACT_SUBJECT_KEYS,
  FORMSPREE_SUBJECT_LABELS,
  FIELD_LIMITS,
  resolveContactLocale,
  getContactCopy,
  isValidEmail,
  isValidHttpUrl,
  isValidFormspreeId,
  sanitizeTextParam,
  resolveSubjectParam,
} from '../lib/contact-i18n'

const FORMSPREE_FORM_ID = (process.env.NEXT_PUBLIC_FORMSPREE_FORM_ID || '').trim()
const IS_FORMSPREE_CONFIGURED = isValidFormspreeId(FORMSPREE_FORM_ID)

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

const inputErrorClass =
  'border-earth-rust dark:border-rose-400/70 focus:border-earth-rust dark:focus:border-rose-400'

const labelClass =
  'flex items-baseline justify-between gap-2 text-[0.84rem] font-medium text-ink-700 dark:text-sage-200 mb-1.5'

const badgeClass =
  'text-[0.72rem] font-normal text-ink-400 dark:text-sage-500'

export default function ContactForm() {
  const searchParams = useSearchParams()

  // Track which fields the user has manually edited so query params never overwrite manual input
  const touchedFieldsRef = useRef(new Set())
  const localeTouchedRef = useRef(false)
  const submitLockRef = useRef(false)

  const [locale, setLocale] = useState(DEFAULT_LOCALE)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [subject, setSubject] = useState('servicenow-question')
  const [articleTitle, setArticleTitle] = useState('')
  const [articleUrl, setArticleUrl] = useState('')
  const [message, setMessage] = useState('')
  // Formspree official honeypot field (kept visually hidden from human visitors)
  const [honeypot, setHoneypot] = useState('')
  const [prefilledFromArticle, setPrefilledFromArticle] = useState(false)

  const [errors, setErrors] = useState({})
  const [status, setStatus] = useState('idle') // 'idle' | 'submitting' | 'success' | 'error'
  const [submitError, setSubmitError] = useState('')

  // Hydrate optional query parameters safely without overwriting manual user edits
  useEffect(() => {
    if (!searchParams) return

    const langParam = searchParams.get('lang')
    if (langParam && !localeTouchedRef.current) {
      setLocale(resolveContactLocale(langParam))
    }

    const subjectParam = resolveSubjectParam(searchParams.get('subject') || '')
    if (subjectParam && !touchedFieldsRef.current.has('subject')) {
      setSubject(subjectParam)
    }

    const rawTitle = sanitizeTextParam(
      searchParams.get('title') || '',
      FIELD_LIMITS.articleTitleMax
    )
    const rawUrl = (searchParams.get('url') || '').trim()
    const validUrl = isValidHttpUrl(rawUrl) ? rawUrl : ''

    let didPrefill = false
    if (rawTitle && !touchedFieldsRef.current.has('articleTitle')) {
      setArticleTitle(rawTitle)
      didPrefill = true
    }
    if (validUrl && !touchedFieldsRef.current.has('articleUrl')) {
      setArticleUrl(validUrl)
      didPrefill = true
    }
    if (didPrefill) {
      setPrefilledFromArticle(true)
    }
  }, [searchParams])

  const copy = getContactCopy(locale)

  function clearFieldError(field) {
    setErrors((prev) => {
      if (!prev[field]) return prev
      const next = { ...prev }
      delete next[field]
      return next
    })
  }

  function validateForm() {
    const nextErrors = {}
    const trimmedName = name.trim()
    const trimmedEmail = email.trim()
    const trimmedTitle = articleTitle.trim()
    const trimmedUrl = articleUrl.trim()
    const trimmedMessage = message.trim()

    if (trimmedName.length > FIELD_LIMITS.nameMax) {
      nextErrors.name = copy.errors.nameMax
    }

    if (!trimmedEmail) {
      nextErrors.email = copy.errors.emailRequired
    } else if (trimmedEmail.length > FIELD_LIMITS.emailMax) {
      nextErrors.email = copy.errors.emailMax
    } else if (!isValidEmail(trimmedEmail)) {
      nextErrors.email = copy.errors.emailInvalid
    }

    if (!CONTACT_SUBJECT_KEYS.includes(subject)) {
      nextErrors.subject = copy.errors.subjectRequired
    }

    if (trimmedTitle.length > FIELD_LIMITS.articleTitleMax) {
      nextErrors.articleTitle = copy.errors.articleTitleMax
    }

    if (trimmedUrl) {
      if (trimmedUrl.length > FIELD_LIMITS.articleUrlMax) {
        nextErrors.articleUrl = copy.errors.articleUrlMax
      } else if (!isValidHttpUrl(trimmedUrl)) {
        nextErrors.articleUrl = copy.errors.articleUrlInvalid
      }
    }

    if (!trimmedMessage) {
      nextErrors.message = copy.errors.messageRequired
    } else if (trimmedMessage.length < FIELD_LIMITS.messageMin) {
      nextErrors.message = copy.errors.messageMin
    } else if (trimmedMessage.length > FIELD_LIMITS.messageMax) {
      nextErrors.message = copy.errors.messageMax
    }

    return nextErrors
  }

  async function handleSubmit(e) {
    e.preventDefault()

    if (submitLockRef.current || status === 'submitting') return

    setSubmitError('')

    if (!IS_FORMSPREE_CONFIGURED) {
      setStatus('error')
      setSubmitError(copy.errors.formUnavailable)
      return
    }

    const validationErrors = validateForm()
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors)
      const firstErrorField = Object.keys(validationErrors)[0]
      const el = document.getElementById(`contact-${firstErrorField}`)
      if (el && typeof el.focus === 'function') {
        el.focus()
      }
      return
    }

    setErrors({})
    submitLockRef.current = true
    setStatus('submitting')

    const subjectLabel = FORMSPREE_SUBJECT_LABELS[subject] || 'Other'
    const trimmedName = name.trim()
    const trimmedEmail = email.trim()
    const trimmedTitle = articleTitle.trim()
    const trimmedUrl = articleUrl.trim()
    const trimmedMessage = message.trim()

    const payload = {
      name: trimmedName || undefined,
      email: trimmedEmail,
      subject: subjectLabel,
      _subject: `[SN Knowledge Hub] ${subjectLabel}${trimmedTitle ? `: ${trimmedTitle}` : ''}`,
      related_article_title: trimmedTitle || undefined,
      related_article_url: trimmedUrl || undefined,
      message: trimmedMessage,
      _gotcha: honeypot,
    }

    try {
      const response = await fetch(`https://formspree.io/f/${FORMSPREE_FORM_ID}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      })

      if (response.ok) {
        setStatus('success')
        // Reset only after confirmed success
        setName('')
        setEmail('')
        setSubject('servicenow-question')
        setArticleTitle('')
        setArticleUrl('')
        setMessage('')
        setHoneypot('')
        setPrefilledFromArticle(false)
        touchedFieldsRef.current.clear()
        return
      }

      if (response.status === 429) {
        setStatus('error')
        setSubmitError(copy.errors.rateLimited)
        return
      }

      setStatus('error')
      setSubmitError(copy.errors.submitFailed)
    } catch {
      // Do not log form contents to the console and do not reset user input on failure
      setStatus('error')
      setSubmitError(copy.errors.networkError)
    } finally {
      submitLockRef.current = false
    }
  }

  function handleResetAfterSuccess() {
    setStatus('idle')
    setSubmitError('')
    setErrors({})
  }

  function handleClearRelatedArticle() {
    touchedFieldsRef.current.add('articleTitle')
    touchedFieldsRef.current.add('articleUrl')
    setArticleTitle('')
    setArticleUrl('')
    setPrefilledFromArticle(false)
    clearFieldError('articleTitle')
    clearFieldError('articleUrl')
  }

  const isDisabled = !IS_FORMSPREE_CONFIGURED || status === 'submitting'

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-10 sm:py-14">
      {/* ── Page Header & Language Toggle ── */}
      <header className="mb-8 pb-6 border-b border-rice-paper-400/70 dark:border-tea-slate-50/50">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <span className="inline-flex items-center gap-2 text-[0.72rem] uppercase tracking-[0.2em] font-medium text-matcha-600 dark:text-matcha-400">
            <span className="w-1.5 h-1.5 rounded-full bg-matcha-500 dark:bg-matcha-400" aria-hidden="true" />
            {copy.eyebrow}
          </span>

          {/* Compact Wabi-Sabi EN / VI toggle matching LanguageSwitcher */}
          <div
            role="group"
            aria-label={copy.languageLabel}
            className="inline-flex items-center gap-0.5 p-0.5 rounded-pill bg-rice-paper-200/80 dark:bg-tea-slate-200/70 border border-rice-paper-400/70 dark:border-tea-slate-50/50"
          >
            {SUPPORTED_LOCALES.map((code) => {
              const meta = getLocaleMeta(code)
              const active = locale === code
              return (
                <button
                  key={code}
                  type="button"
                  onClick={() => {
                    localeTouchedRef.current = true
                    setLocale(code)
                  }}
                  aria-pressed={active}
                  lang={meta.hreflang}
                  className={[
                    'min-w-[2.75rem] h-7 px-2.5 rounded-pill text-[0.72rem] font-semibold tracking-[0.12em] leading-none',
                    'transition-colors duration-200 ease-zen motion-reduce:transition-none',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-matcha-500/60 dark:focus-visible:ring-matcha-400/60',
                    active
                      ? 'bg-rice-paper-50 dark:bg-tea-slate-50 text-matcha-600 dark:text-matcha-300 border border-matcha-300/60 dark:border-matcha-700/60 shadow-zen-sm'
                      : 'border border-transparent text-ink-500 dark:text-sage-400 hover:text-matcha-600 dark:hover:text-matcha-300',
                  ].join(' ')}
                >
                  {meta.short}
                </button>
              )
            })}
          </div>
        </div>

        <h1
          lang={getLocaleMeta(locale).hreflang}
          className="font-serif font-medium text-3xl sm:text-4xl text-ink-700 dark:text-sage-100 leading-tight mb-3"
        >
          {copy.title}
        </h1>
        <p
          lang={getLocaleMeta(locale).hreflang}
          className="text-[0.98rem] leading-relaxed text-ink-500 dark:text-sage-400 max-w-prose"
        >
          {copy.description}
        </p>
      </header>

      {/* ── Missing Formspree Config Notice ── */}
      {!IS_FORMSPREE_CONFIGURED && (
        <div
          role="status"
          className="mb-6 rounded-card px-5 py-4 bg-rice-paper-200/90 dark:bg-tea-slate-200/80 border border-earth-beige/80 dark:border-tea-slate-50/70"
        >
          <p className="text-[0.9rem] font-medium text-ink-700 dark:text-sage-100 mb-1">
            {copy.formUnavailableTitle}
          </p>
          <p className="text-[0.84rem] leading-relaxed text-ink-500 dark:text-sage-400 m-0">
            {copy.formUnavailableBody}
          </p>
        </div>
      )}

      {/* ── Success State ── */}
      {status === 'success' ? (
        <section
          role="status"
          aria-live="polite"
          className="rounded-card p-6 sm:p-8 bg-rice-paper-50 dark:bg-tea-slate-200/80 border border-matcha-300/70 dark:border-matcha-700/60 shadow-zen-sm"
        >
          <div className="w-10 h-10 rounded-full bg-matcha-100 dark:bg-matcha-900/60 text-matcha-600 dark:text-matcha-300 flex items-center justify-center mb-4">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <h2 className="font-serif text-xl font-medium text-ink-700 dark:text-sage-100 mb-2">
            {copy.successTitle}
          </h2>
          <p className="text-[0.92rem] leading-relaxed text-ink-500 dark:text-sage-400 mb-6">
            {copy.successBody}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleResetAfterSuccess}
              className="px-4 py-2 rounded-zen text-[0.85rem] font-medium bg-matcha-500 hover:bg-matcha-600 dark:bg-matcha-600 dark:hover:bg-matcha-500 text-white transition-colors duration-200 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-matcha-500/60"
            >
              {copy.sendAnother}
            </button>
            <Link
              href="/"
              className="px-4 py-2 rounded-zen text-[0.85rem] font-medium text-ink-600 dark:text-sage-300 border border-rice-paper-400 dark:border-tea-slate-50/70 hover:bg-rice-paper-200/70 dark:hover:bg-tea-slate-100/70 transition-colors duration-200 motion-reduce:transition-none no-underline"
            >
              {copy.backHome}
            </Link>
          </div>
        </section>
      ) : (
        /* ── Contact Form Card ── */
        <form
          onSubmit={handleSubmit}
          noValidate
          className="rounded-card p-6 sm:p-8 bg-rice-paper-50/90 dark:bg-tea-slate-200/60 border border-rice-paper-400/70 dark:border-tea-slate-50/50 shadow-zen-sm space-y-6"
        >
          {/* Submission Error Banner */}
          {status === 'error' && submitError && (
            <div
              role="alert"
              className="rounded-zen px-4 py-3 bg-rose-50/80 dark:bg-rose-950/30 border border-earth-rust/40 dark:border-rose-400/40 text-[0.86rem] text-earth-rust dark:text-rose-200"
            >
              {submitError}
            </div>
          )}

          {/* Hidden Honeypot Field (anti-spam, Formspree _gotcha) */}
          <div className="hidden" aria-hidden="true">
            <label htmlFor="contact-gotcha">Leave this field empty</label>
            <input
              id="contact-gotcha"
              name="_gotcha"
              type="text"
              tabIndex={-1}
              autoComplete="off"
              value={honeypot}
              onChange={(e) => setHoneypot(e.target.value)}
            />
          </div>

          {/* Name & Email Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            {/* Name (Optional, max 100) */}
            <div>
              <label htmlFor="contact-name" className={labelClass}>
                <span>{copy.fields.name.label}</span>
                <span className={badgeClass}>{copy.fields.name.optional}</span>
              </label>
              <input
                id="contact-name"
                name="name"
                type="text"
                autoComplete="name"
                maxLength={FIELD_LIMITS.nameMax}
                disabled={isDisabled}
                value={name}
                onChange={(e) => {
                  touchedFieldsRef.current.add('name')
                  setName(e.target.value)
                  clearFieldError('name')
                }}
                placeholder={copy.fields.name.placeholder}
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? 'contact-name-error' : undefined}
                className={`${inputBaseClass} ${errors.name ? inputErrorClass : ''}`}
              />
              {errors.name && (
                <p id="contact-name-error" role="alert" className="mt-1.5 text-[0.78rem] text-earth-rust dark:text-rose-300">
                  {errors.name}
                </p>
              )}
            </div>

            {/* Email (Required, max 254) */}
            <div>
              <label htmlFor="contact-email" className={labelClass}>
                <span>
                  {copy.fields.email.label}{' '}
                  <span className="text-matcha-600 dark:text-matcha-400" aria-hidden="true">*</span>
                </span>
                <span className={badgeClass}>{copy.fields.email.required}</span>
              </label>
              <input
                id="contact-email"
                name="email"
                type="email"
                autoComplete="email"
                required
                maxLength={FIELD_LIMITS.emailMax}
                disabled={isDisabled}
                value={email}
                onChange={(e) => {
                  touchedFieldsRef.current.add('email')
                  setEmail(e.target.value)
                  clearFieldError('email')
                }}
                placeholder={copy.fields.email.placeholder}
                aria-required="true"
                aria-invalid={Boolean(errors.email)}
                aria-describedby={errors.email ? 'contact-email-error' : undefined}
                className={`${inputBaseClass} ${errors.email ? inputErrorClass : ''}`}
              />
              {errors.email && (
                <p id="contact-email-error" role="alert" className="mt-1.5 text-[0.78rem] text-earth-rust dark:text-rose-300">
                  {errors.email}
                </p>
              )}
            </div>
          </div>

          {/* Subject (Required dropdown) */}
          <div>
            <label htmlFor="contact-subject" className={labelClass}>
              <span>
                {copy.fields.subject.label}{' '}
                <span className="text-matcha-600 dark:text-matcha-400" aria-hidden="true">*</span>
              </span>
              <span className={badgeClass}>{copy.fields.subject.required}</span>
            </label>
            <select
              id="contact-subject"
              name="subject"
              required
              disabled={isDisabled}
              value={subject}
              onChange={(e) => {
                touchedFieldsRef.current.add('subject')
                setSubject(e.target.value)
                clearFieldError('subject')
              }}
              aria-required="true"
              aria-invalid={Boolean(errors.subject)}
              aria-describedby={errors.subject ? 'contact-subject-error' : undefined}
              className={`${inputBaseClass} ${errors.subject ? inputErrorClass : ''}`}
            >
              {CONTACT_SUBJECT_KEYS.map((key) => (
                <option key={key} value={key}>
                  {copy.fields.subject.options[key]}
                </option>
              ))}
            </select>
            {errors.subject && (
              <p id="contact-subject-error" role="alert" className="mt-1.5 text-[0.78rem] text-earth-rust dark:text-rose-300">
                {errors.subject}
              </p>
            )}
          </div>

          {/* Related Article (Optional — Title + URL) */}
          <fieldset className="rounded-zen p-4 bg-rice-paper-200/50 dark:bg-tea-slate-300/50 border border-rice-paper-400/70 dark:border-tea-slate-50/40 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <legend className="text-[0.84rem] font-medium text-ink-700 dark:text-sage-200">
                {copy.fields.relatedArticle.sectionLabel}{' '}
                <span className="font-normal text-[0.74rem] text-ink-400 dark:text-sage-500">
                  ({copy.fields.relatedArticle.optional})
                </span>
              </legend>
              {(articleTitle || articleUrl) && !isDisabled && (
                <button
                  type="button"
                  onClick={handleClearRelatedArticle}
                  className="text-[0.75rem] text-ink-400 dark:text-sage-400 hover:text-matcha-600 dark:hover:text-matcha-300 underline underline-offset-2 transition-colors duration-150 motion-reduce:transition-none"
                >
                  {copy.fields.relatedArticle.clearButton}
                </button>
              )}
            </div>

            {prefilledFromArticle && (
              <p className="text-[0.78rem] text-matcha-700 dark:text-matcha-300 bg-matcha-50/90 dark:bg-matcha-900/30 border border-matcha-200/70 dark:border-matcha-700/40 rounded-zen px-3 py-2 m-0">
                {copy.fields.relatedArticle.prefilledNote}
              </p>
            )}

            <div>
              <label htmlFor="contact-articleTitle" className="block text-[0.8rem] text-ink-600 dark:text-sage-300 mb-1">
                {copy.fields.relatedArticle.titleLabel}
              </label>
              <input
                id="contact-articleTitle"
                name="related_article_title"
                type="text"
                maxLength={FIELD_LIMITS.articleTitleMax}
                disabled={isDisabled}
                value={articleTitle}
                onChange={(e) => {
                  touchedFieldsRef.current.add('articleTitle')
                  setArticleTitle(e.target.value)
                  clearFieldError('articleTitle')
                }}
                placeholder={copy.fields.relatedArticle.titlePlaceholder}
                aria-invalid={Boolean(errors.articleTitle)}
                aria-describedby={errors.articleTitle ? 'contact-articleTitle-error' : undefined}
                className={`${inputBaseClass} ${errors.articleTitle ? inputErrorClass : ''}`}
              />
              {errors.articleTitle && (
                <p id="contact-articleTitle-error" role="alert" className="mt-1.5 text-[0.78rem] text-earth-rust dark:text-rose-300">
                  {errors.articleTitle}
                </p>
              )}
            </div>

            <div>
              <label htmlFor="contact-articleUrl" className="block text-[0.8rem] text-ink-600 dark:text-sage-300 mb-1">
                {copy.fields.relatedArticle.urlLabel}
              </label>
              <input
                id="contact-articleUrl"
                name="related_article_url"
                type="url"
                maxLength={FIELD_LIMITS.articleUrlMax}
                disabled={isDisabled}
                value={articleUrl}
                onChange={(e) => {
                  touchedFieldsRef.current.add('articleUrl')
                  setArticleUrl(e.target.value)
                  clearFieldError('articleUrl')
                }}
                placeholder={copy.fields.relatedArticle.urlPlaceholder}
                aria-invalid={Boolean(errors.articleUrl)}
                aria-describedby={errors.articleUrl ? 'contact-articleUrl-error' : undefined}
                className={`${inputBaseClass} ${errors.articleUrl ? inputErrorClass : ''}`}
              />
              {errors.articleUrl && (
                <p id="contact-articleUrl-error" role="alert" className="mt-1.5 text-[0.78rem] text-earth-rust dark:text-rose-300">
                  {errors.articleUrl}
                </p>
              )}
            </div>
          </fieldset>

          {/* Message (Required, min 10, max 5000) */}
          <div>
            <label htmlFor="contact-message" className={labelClass}>
              <span>
                {copy.fields.message.label}{' '}
                <span className="text-matcha-600 dark:text-matcha-400" aria-hidden="true">*</span>
              </span>
              <span className={badgeClass}>{copy.fields.message.required}</span>
            </label>
            <textarea
              id="contact-message"
              name="message"
              rows={6}
              required
              minLength={FIELD_LIMITS.messageMin}
              maxLength={FIELD_LIMITS.messageMax}
              disabled={isDisabled}
              value={message}
              onChange={(e) => {
                touchedFieldsRef.current.add('message')
                setMessage(e.target.value)
                clearFieldError('message')
              }}
              placeholder={copy.fields.message.placeholder}
              aria-required="true"
              aria-invalid={Boolean(errors.message)}
              aria-describedby={
                errors.message ? 'contact-message-error contact-message-hint' : 'contact-message-hint'
              }
              className={`${inputBaseClass} resize-y min-h-[140px] leading-relaxed ${
                errors.message ? inputErrorClass : ''
              }`}
            />
            <div className="mt-1.5 flex items-center justify-between gap-2 text-[0.76rem] text-ink-400 dark:text-sage-500">
              <span id="contact-message-hint">{copy.fields.message.hint}</span>
              <span aria-live="off">
                {message.length.toLocaleString()} / {FIELD_LIMITS.messageMax.toLocaleString()}
              </span>
            </div>
            {errors.message && (
              <p id="contact-message-error" role="alert" className="mt-1.5 text-[0.78rem] text-earth-rust dark:text-rose-300">
                {errors.message}
              </p>
            )}
          </div>

          {/* Privacy Notice */}
          <p className="text-[0.78rem] leading-relaxed text-ink-400 dark:text-sage-500 pt-1">
            {copy.privacyNotice}
          </p>

          {/* Submit Button */}
          <div className="pt-1 flex items-center justify-end">
            <button
              type="submit"
              disabled={isDisabled}
              aria-busy={status === 'submitting'}
              className={[
                'inline-flex items-center justify-center gap-2',
                'w-full sm:w-auto min-w-[10rem] px-6 py-2.5 rounded-zen',
                'text-[0.9rem] font-medium text-white',
                'bg-matcha-500 hover:bg-matcha-600 dark:bg-matcha-600 dark:hover:bg-matcha-500',
                'shadow-zen-sm hover:shadow-matcha',
                'transition-all duration-200 ease-zen motion-reduce:transition-none',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-matcha-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-rice-paper-50 dark:focus-visible:ring-offset-tea-slate-200',
                'disabled:opacity-55 disabled:cursor-not-allowed disabled:shadow-none',
              ].join(' ')}
            >
              {status === 'submitting' ? (
                <>
                  <svg
                    className="w-4 h-4 animate-spin motion-reduce:animate-none"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="3"
                    />
                    <path
                      className="opacity-85"
                      fill="currentColor"
                      d="M4 12a8 8 0 0 1 8-8v3a5 5 0 0 0-5 5H4Z"
                    />
                  </svg>
                  <span>{copy.submitting}</span>
                </>
              ) : (
                <span>{copy.submit}</span>
              )}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
