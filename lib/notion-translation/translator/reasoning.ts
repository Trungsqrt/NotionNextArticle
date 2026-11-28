import type { WorkerLogger } from '../types'
import { defaultLogger } from '../../../worker/logger'

export type ReasoningControlMode =
  | 'not_reasoning_model'
  | 'disabled_via_effort_none'
  | 'disabled_via_thinking_budget_zero'
  | 'disabled_via_openrouter_reasoning'
  | 'always_on_cannot_disable'
  | 'enabled_by_config'

export interface ModelReasoningCapability {
  provider: string
  model: string
  isReasoningModel: boolean
  canDisableReasoning: boolean
  mode: ReasoningControlMode
  supportsNemotronSystemDirective: boolean
  recommendedMinOutputTokens: number
  recommendedMaxOutputTokens: number
  warningMessage: string | null
}

const warnedReasoningModels = new Set<string>()

/**
 * Determines provider and model capabilities for reasoning control and output token limits.
 * Never claims reasoning is disabled when a model does not officially support disabling it.
 */
export function resolveModelReasoningCapability(
  providerRaw: string,
  modelRaw: string,
  disableReasoning = true
): ModelReasoningCapability {
  const provider = (providerRaw || 'openai').trim().toLowerCase()
  const model = (modelRaw || 'gpt-4o-mini').trim()
  const lowerModel = model.toLowerCase()

  const isNemotron = lowerModel.includes('nemotron')
  const isDeepSeekR1 =
    lowerModel.includes('deepseek-r1') ||
    lowerModel.includes('deepseek-reasoner') ||
    /(?:^|\/)r1(?:-|:|$)/.test(lowerModel)
  const isQwQOrThinkingOnly =
    lowerModel.includes('qwq') || lowerModel.includes('thinking')
  const isOpenAiOSeries = /^(?:openai\/)?o[134](?:-|:|$)/.test(lowerModel)
  const isGptOss = lowerModel.includes('gpt-oss')
  const isQwen3Hybrid =
    lowerModel.includes('qwen3') && !lowerModel.includes('thinking')
  const isGemini25Pro = lowerModel.includes('gemini-2.5-pro')
  const isGemini25Flash = lowerModel.includes('gemini-2.5-flash')
  const isClaudeHybrid =
    lowerModel.includes('claude-3-7') ||
    lowerModel.includes('claude-3.7') ||
    lowerModel.includes('claude-sonnet-4') ||
    lowerModel.includes('claude-opus-4')

  const isAlwaysOnReasoning =
    isNemotron ||
    isDeepSeekR1 ||
    isQwQOrThinkingOnly ||
    isOpenAiOSeries ||
    isGptOss ||
    isGemini25Pro

  const isHybridReasoning =
    isQwen3Hybrid || isGemini25Flash || isClaudeHybrid

  const isReasoningModel = isAlwaysOnReasoning || isHybridReasoning

  if (!isReasoningModel) {
    return {
      provider,
      model,
      isReasoningModel: false,
      canDisableReasoning: true,
      mode: 'not_reasoning_model',
      supportsNemotronSystemDirective: false,
      recommendedMinOutputTokens: 2048,
      recommendedMaxOutputTokens: 8192,
      warningMessage: null,
    }
  }

  if (!disableReasoning) {
    return {
      provider,
      model,
      isReasoningModel: true,
      canDisableReasoning: !isAlwaysOnReasoning,
      mode: 'enabled_by_config',
      supportsNemotronSystemDirective: false,
      recommendedMinOutputTokens: 2048,
      recommendedMaxOutputTokens: 8192,
      warningMessage: null,
    }
  }

  // 1. Groq + Qwen3 hybrid models officially support reasoning_effort="none"
  if (provider === 'groq' && isQwen3Hybrid) {
    return {
      provider,
      model,
      isReasoningModel: true,
      canDisableReasoning: true,
      mode: 'disabled_via_effort_none',
      supportsNemotronSystemDirective: false,
      recommendedMinOutputTokens: 2048,
      recommendedMaxOutputTokens: 8192,
      warningMessage: null,
    }
  }

  // 2. Native Gemini API + gemini-2.5-flash officially supports thinkingBudget=0
  if (
    (provider === 'gemini' || provider === 'google') &&
    isGemini25Flash
  ) {
    return {
      provider,
      model,
      isReasoningModel: true,
      canDisableReasoning: true,
      mode: 'disabled_via_thinking_budget_zero',
      supportsNemotronSystemDirective: false,
      recommendedMinOutputTokens: 2048,
      recommendedMaxOutputTokens: 8192,
      warningMessage: null,
    }
  }

  // 3. OpenRouter + hybrid reasoning models (Qwen3 non-thinking, Gemini 2.5 Flash, Claude 3.7/4)
  if (provider === 'openrouter' && isHybridReasoning) {
    return {
      provider,
      model,
      isReasoningModel: true,
      canDisableReasoning: true,
      mode: 'disabled_via_openrouter_reasoning',
      supportsNemotronSystemDirective: false,
      recommendedMinOutputTokens: 2048,
      recommendedMaxOutputTokens: 8192,
      warningMessage: null,
    }
  }

  // 4. Always-on reasoning models (Nemotron Ultra/Super, DeepSeek R1, QwQ, Qwen3-Thinking, o1/o3/o4, Gemini 2.5 Pro)
  return {
    provider,
    model,
    isReasoningModel: true,
    canDisableReasoning: false,
    mode: 'always_on_cannot_disable',
    supportsNemotronSystemDirective: isNemotron,
    recommendedMinOutputTokens: 2048,
    recommendedMaxOutputTokens: 8192,
    warningMessage:
      `Model "${model}" on provider "${provider}" is an always-on reasoning model whose chain-of-thought cannot be disabled via API and consumes output token budget (max_tokens). ` +
      `Using output-aware batching (~5000 output tokens target) and max_tokens escalation up to TRANSLATION_MAX_OUTPUT_TOKENS to prevent truncation.`,
  }
}

export function logReasoningCapabilityWarningOnce(
  capability: ModelReasoningCapability,
  logger: WorkerLogger = defaultLogger
): void {
  if (!capability.warningMessage) return
  const key = `${capability.provider}::${capability.model}`
  if (warnedReasoningModels.has(key)) return
  warnedReasoningModels.add(key)
  logger.warn(capability.warningMessage, {
    provider: capability.provider,
    model: capability.model,
    reasoningMode: capability.mode,
    recommendedMinOutputTokens: capability.recommendedMinOutputTokens,
    recommendedMaxOutputTokens: capability.recommendedMaxOutputTokens,
  })
}
