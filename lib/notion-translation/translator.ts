/**
 * lib/notion-translation/translator.ts — Public Translation Worker AI Translator entry point
 * ──────────────────────────────────────────────────────────────────────────────────────────
 * Preserves all public exports while delegating to cohesive modules under
 * `lib/notion-translation/translator/`:
 *   - `errors.ts`          — `QuotaExhaustedError`, `HttpError`, error & quota classification
 *   - `reasoning.ts`       — model reasoning capability detection and one-time warnings
 *   - `rate-limiter.ts`    — sliding-window RPM/TPM/RPD/TPD limiter & cooldown tracking
 *   - `prompts.ts`         — system/user prompts, short keys, token estimates & output budgets
 *   - `batching.ts`        — adaptive section-aware batching and oversized segment splitting
 *   - `response-parser.ts` — JSON extraction, truncation salvage, validation & whitespace rules
 *   - `providers.ts`       — Gemini, Anthropic, and OpenAI-compatible HTTP provider adapters
 *   - `execution.ts`       — `translateManifest` retry, salvage, split & cache orchestration
 */

export {
  QuotaExhaustedError,
  isQuotaExhaustedError,
  type HttpError,
} from './translator/errors'

export {
  resolveModelReasoningCapability,
  logReasoningCapabilityWarningOnce,
  type ReasoningControlMode,
  type ModelReasoningCapability,
} from './translator/reasoning'

export {
  PROMPT_VERSION,
  SERVICENOW_SYSTEM_PROMPT,
  estimateTokenCount,
  indexToShortKey,
  buildSystemPrompt,
  computeBatchOutputTokenBudget,
  buildCompactBatchPrompt,
  buildUserPrompt,
  type BatchOutputBudgetOptions,
  type BatchPromptBuildResult,
} from './translator/prompts'

export {
  DEFAULT_ASSUMED_OUTPUT_TOKENS_PER_SEC,
  createTranslationBatches,
  splitOversizedSegmentText,
  type CreateTranslationBatchesOptions,
} from './translator/batching'

export {
  extractJsonFromModelText,
  salvageCompletePairsFromTruncatedJson,
  validateBatchTranslationResponse,
  preserveBoundaryWhitespace,
} from './translator/response-parser'

export {
  createAiProviderAdapter,
  type CreateAiProviderOptions,
} from './translator/providers'

export {
  translateManifest,
  type TranslateManifestOptions,
} from './translator/execution'
