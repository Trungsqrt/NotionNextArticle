import type { TranslationFailureStage } from '../types'

export class ChildTaskTranslationError extends Error {
  readonly isChildTaskError = true
  readonly childPageTitle: string
  readonly childSourcePageId: string
  readonly failureStage: TranslationFailureStage
  readonly provider: string
  readonly model: string
  readonly shortError: string

  constructor(params: {
    childPageTitle: string
    childSourcePageId: string
    failureStage: TranslationFailureStage
    provider: string
    model: string
    shortError: string
  }) {
    const cleanShort = String(params.shortError || 'Unknown error')
      .replace(/\s+/g, ' ')
      .trim()
    super(
      `Child page "${params.childPageTitle}" (${params.childSourcePageId}) failed at stage "${params.failureStage}" (${params.provider}/${params.model}): ${cleanShort}`
    )
    this.name = 'ChildTaskTranslationError'
    this.childPageTitle = params.childPageTitle
    this.childSourcePageId = params.childSourcePageId
    this.failureStage = params.failureStage
    this.provider = params.provider
    this.model = params.model
    this.shortError = cleanShort
  }
}

export function summarizeShortErrorMessage(rawError: string): string {
  const oneLine = String(rawError || '')
    .replace(/\s+/g, ' ')
    .trim()
  return oneLine.length > 360 ? `${oneLine.slice(0, 357)}...` : oneLine
}

export function formatNotionTranslationErrorSummary(params: {
  pageTitle: string
  isChildPage?: boolean
  failureStage: TranslationFailureStage
  provider: string
  model: string
  rawError: string
  failedAt: string
}): string {
  const shortMsg = summarizeShortErrorMessage(params.rawError)
  const label = params.isChildPage ? 'Child page' : 'Page'
  return `[Failed at ${params.failedAt}] ${label}: "${params.pageTitle}" | Stage: ${params.failureStage} | Model: ${params.provider}/${params.model} | Error: ${shortMsg}`.slice(
    0,
    1950
  )
}
