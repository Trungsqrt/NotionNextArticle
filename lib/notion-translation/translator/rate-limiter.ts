import type { TranslationConfig } from '../config'
import type { WorkerLogger } from '../types'
import { QuotaExhaustedError, parseDurationHeaderMs } from './errors'

/**
 * Sliding-window RateLimiter supporting RPM, TPM, RPD, and TPD budgets.
 * Shared across batches and provider response header updates within a translation run.
 */
export class ProviderRateLimiter {
  private readonly rpmLimit: number
  private readonly tpmLimit: number
  private readonly rpdLimit: number
  private readonly tpdLimit: number
  private readonly provider: string
  private readonly model: string
  private readonly minuteWindow: Array<{ ts: number; tokens: number }> = []
  private readonly dayWindow: Array<{ ts: number; tokens: number }> = []
  private cooldownUntilMs = 0

  constructor(config: Partial<TranslationConfig>) {
    this.rpmLimit = Math.max(0, Number(config.rpmLimit || 0))
    this.tpmLimit = Math.max(0, Number(config.tpmLimit || 0))
    this.rpdLimit = Math.max(0, Number(config.rpdLimit || 0))
    this.tpdLimit = Math.max(0, Number(config.tpdLimit || 0))
    this.provider = config.aiProvider || 'openai'
    this.model = config.aiModel || 'unknown'
  }

  private prune(now: number): void {
    const oneMinuteAgo = now - 60_000
    while (
      this.minuteWindow.length > 0 &&
      this.minuteWindow[0]!.ts <= oneMinuteAgo
    ) {
      this.minuteWindow.shift()
    }
    const oneDayAgo = now - 86_400_000
    while (this.dayWindow.length > 0 && this.dayWindow[0]!.ts <= oneDayAgo) {
      this.dayWindow.shift()
    }
  }

  async acquire(estimatedTokens: number, logger?: WorkerLogger): Promise<void> {
    const now = Date.now()
    this.prune(now)

    // 1. Check daily RPD / TPD budgets first
    if (this.rpdLimit > 0 && this.dayWindow.length >= this.rpdLimit) {
      throw new QuotaExhaustedError(
        `Configured daily request limit (TRANSLATION_RPD_LIMIT=${this.rpdLimit}) reached for ${this.provider}/${this.model}. Pausing job safely.`,
        { provider: this.provider, model: this.model }
      )
    }
    const dayTokensUsed = this.dayWindow.reduce((acc, e) => acc + e.tokens, 0)
    if (
      this.tpdLimit > 0 &&
      dayTokensUsed + estimatedTokens > this.tpdLimit &&
      dayTokensUsed > 0
    ) {
      throw new QuotaExhaustedError(
        `Configured daily token limit (TRANSLATION_TPD_LIMIT=${this.tpdLimit}, used=${dayTokensUsed}) reached for ${this.provider}/${this.model}. Pausing job safely.`,
        { provider: this.provider, model: this.model }
      )
    }

    // 2. Respect provider Retry-After cooldown if active
    if (this.cooldownUntilMs > Date.now()) {
      const waitMs = this.cooldownUntilMs - Date.now()
      if (waitMs > 0) {
        logger?.info(
          `Waiting ${Math.ceil(waitMs / 1000)}s for AI provider rate-limit cooldown...`
        )
        await new Promise((r) => setTimeout(r, waitMs))
      }
    }

    // 3. Check per-minute RPM / TPM sliding window
    for (let guard = 0; guard < 5; guard++) {
      const currentNow = Date.now()
      this.prune(currentNow)

      const minuteReqs = this.minuteWindow.length
      const minuteTokens = this.minuteWindow.reduce(
        (acc, e) => acc + e.tokens,
        0
      )

      const rpmExceeded = this.rpmLimit > 0 && minuteReqs >= this.rpmLimit
      const tpmExceeded =
        this.tpmLimit > 0 &&
        minuteTokens + estimatedTokens > this.tpmLimit &&
        minuteTokens > 0

      if (!rpmExceeded && !tpmExceeded) {
        break
      }

      const oldestTs = this.minuteWindow[0]?.ts || currentNow
      const sleepMs = Math.max(250, oldestTs + 60_050 - currentNow)
      logger?.info(
        `Pacing AI request to stay within per-minute rate limit (${rpmExceeded ? `RPM ${minuteReqs}/${this.rpmLimit}` : `TPM ${minuteTokens}/${this.tpmLimit}`}); waiting ${Math.ceil(sleepMs / 1000)}s...`
      )
      await new Promise((r) => setTimeout(r, sleepMs))
    }

    const recordTs = Date.now()
    this.minuteWindow.push({ ts: recordTs, tokens: estimatedTokens })
    this.dayWindow.push({ ts: recordTs, tokens: estimatedTokens })
  }

  recordActualUsage(estimatedTokens: number, actualTotalTokens: number): void {
    if (actualTotalTokens <= 0) return
    const delta = actualTotalTokens - estimatedTokens
    const lastMinute = this.minuteWindow[this.minuteWindow.length - 1]
    if (lastMinute) {
      lastMinute.tokens = Math.max(1, lastMinute.tokens + delta)
    }
    const lastDay = this.dayWindow[this.dayWindow.length - 1]
    if (lastDay) {
      lastDay.tokens = Math.max(1, lastDay.tokens + delta)
    }
  }

  applyHeadersCooldown(headers: Headers): void {
    const retryAfterMs = parseDurationHeaderMs(headers.get('retry-after'))
    if (retryAfterMs > 0 && retryAfterMs <= 10 * 60 * 1000) {
      this.cooldownUntilMs = Math.max(
        this.cooldownUntilMs,
        Date.now() + retryAfterMs
      )
      return
    }

    const remReqs = headers.get('x-ratelimit-remaining-requests')
    const resetReqsMs = parseDurationHeaderMs(
      headers.get('x-ratelimit-reset-requests')
    )
    if (
      remReqs !== null &&
      Number(remReqs) <= 1 &&
      resetReqsMs > 0 &&
      resetReqsMs <= 60_000
    ) {
      this.cooldownUntilMs = Math.max(
        this.cooldownUntilMs,
        Date.now() + resetReqsMs
      )
    }

    const remTokens = headers.get('x-ratelimit-remaining-tokens')
    const resetTokensMs = parseDurationHeaderMs(
      headers.get('x-ratelimit-reset-tokens')
    )
    if (
      remTokens !== null &&
      Number(remTokens) <= 250 &&
      resetTokensMs > 0 &&
      resetTokensMs <= 60_000
    ) {
      this.cooldownUntilMs = Math.max(
        this.cooldownUntilMs,
        Date.now() + resetTokensMs
      )
    }
  }
}
