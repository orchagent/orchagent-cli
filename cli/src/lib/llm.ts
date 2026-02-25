/**
 * LLM Provider Abstraction
 *
 * Centralized LLM provider configuration and utilities.
 * Used by run, call, and skill commands.
 */

import { CliError } from './errors'
import { parseLlmError } from './llm-errors'
import type { ResolvedConfig } from '../types'

export class LlmError extends CliError {
  statusCode: number

  constructor(message: string, statusCode: number) {
    super(message)
    this.statusCode = statusCode
  }
}

export function isRateLimitError(error: unknown): boolean {
  return error instanceof LlmError && error.statusCode === 429
}

export type LlmProvider = 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'any'

// Environment variable names for each provider
export const PROVIDER_ENV_VARS: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  ollama: 'OLLAMA_HOST',
}

// Default models for each provider (best models)
export const DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-5.2',
  anthropic: 'claude-opus-4-5-20251101',
  gemini: 'gemini-2.5-pro',
  ollama: 'llama3.2',
}

/**
 * Detect LLM API key from environment variables based on supported providers.
 * Returns the first matching provider/key pair found.
 */
export function detectLlmKeyFromEnv(
  supportedProviders: LlmProvider[]
): { provider: string; key: string } | null {
  for (const provider of supportedProviders) {
    if (provider === 'any') {
      // 'any' means check all providers in order
      for (const [p, envVar] of Object.entries(PROVIDER_ENV_VARS)) {
        const key = process.env[envVar]
        if (key) {
          return { provider: p, key }
        }
      }
    } else {
      const envVar = PROVIDER_ENV_VARS[provider]
      if (envVar) {
        const key = process.env[envVar]
        if (key) {
          return { provider, key }
        }
      }
    }
  }
  return null
}

/**
 * Detect LLM API key with server fallback.
 * Checks local env vars first, then fetches from server if available.
 * Returns provider, key, and optionally the model from server config.
 */
export async function detectLlmKey(
  supportedProviders: LlmProvider[],
  _config?: ResolvedConfig
): Promise<{ provider: string; key: string; model?: string } | null> {
  // LLM keys are only available from local env vars.
  // Server-stored keys are never exported (security best practice).
  return detectLlmKeyFromEnv(supportedProviders)
}

/**
 * Get the default model for a provider.
 */
export function getDefaultModel(provider: string): string {
  return DEFAULT_MODELS[provider] || 'gpt-4o'
}

/**
 * Build a full prompt by injecting input data into the template.
 * Matches server behavior in gateway/src/gateway/llm.py:build_prompt
 */
export function buildPrompt(
  template: string,
  inputData: Record<string, unknown>
): string {
  let prompt = template

  // Simple variable substitution: {{key}} -> value
  for (const [key, value] of Object.entries(inputData)) {
    const placeholder = `{{${key}}}`
    if (prompt.includes(placeholder)) {
      prompt = prompt.split(placeholder).join(String(value))
    }
  }

  // Also append input as JSON for complex inputs
  if (Object.keys(inputData).length > 0) {
    prompt += `\n\nInput:\n\`\`\`json\n${JSON.stringify(inputData, null, 2)}\n\`\`\``
  }

  return prompt
}

/**
 * Call an LLM provider directly (for local execution).
 */
export async function callLlm(
  provider: string,
  apiKey: string,
  model: string,
  prompt: string,
  outputSchema?: object
): Promise<object> {
  if (provider === 'openai') {
    return callOpenAI(apiKey, model, prompt, outputSchema)
  } else if (provider === 'anthropic') {
    return callAnthropic(apiKey, model, prompt, outputSchema)
  } else if (provider === 'gemini') {
    return callGemini(apiKey, model, prompt, outputSchema)
  } else if (provider === 'ollama') {
    return callOllama(apiKey, model, prompt, outputSchema)
  }
  throw new CliError(`Unsupported provider: ${provider}`)
}

export interface ProviderConfig {
  provider: string
  apiKey: string
  model: string
}

/**
 * Call LLM with automatic fallback to next provider on rate limit.
 * Tries each provider in order until one succeeds.
 */
export async function callLlmWithFallback(
  providers: ProviderConfig[],
  prompt: string,
  outputSchema?: object
): Promise<object> {
  let lastError: Error | undefined

  for (const { provider, apiKey, model } of providers) {
    try {
      return await callLlm(provider, apiKey, model, prompt, outputSchema)
    } catch (error) {
      lastError = error as Error
      if (isRateLimitError(error)) {
        process.stderr.write(`${provider} rate-limited, trying next provider...\n`)
        continue
      }
      throw error // Don't retry non-rate-limit errors
    }
  }

  throw lastError ?? new CliError('All LLM providers failed')
}

async function callOpenAI(
  apiKey: string,
  model: string,
  prompt: string,
  outputSchema?: object
): Promise<object> {
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'user', content: prompt }],
  }

  if (outputSchema) {
    body.response_format = { type: 'json_object' }
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const text = await response.text()
    const parsed = parseLlmError('openai', text, response.status)
    throw new LlmError(parsed.message, response.status)
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>
  }
  const content = data.choices?.[0]?.message?.content || ''

  try {
    return JSON.parse(content)
  } catch {
    return { result: content }
  }
}

async function callAnthropic(
  apiKey: string,
  model: string,
  prompt: string,
  _outputSchema?: object
): Promise<object> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    const parsed = parseLlmError('anthropic', text, response.status)
    throw new LlmError(parsed.message, response.status)
  }

  const data = (await response.json()) as { content: Array<{ text: string }> }
  const content = data.content?.[0]?.text || ''

  try {
    return JSON.parse(content)
  } catch {
    return { result: content }
  }
}

async function callGemini(
  apiKey: string,
  model: string,
  prompt: string,
  _outputSchema?: object
): Promise<object> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    const parsed = parseLlmError('gemini', text, response.status)
    throw new LlmError(parsed.message, response.status)
  }

  const data = (await response.json()) as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>
  }
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text || ''

  try {
    return JSON.parse(content)
  } catch {
    return { result: content }
  }
}

async function callOllama(
  endpoint: string,
  model: string,
  prompt: string,
  _outputSchema?: object
): Promise<object> {
  // endpoint is passed via apiKey param for Ollama (it's the OLLAMA_HOST)
  const baseUrl = endpoint || 'http://localhost:11434'
  // Ensure /v1 path
  const normalizedBase = baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl.replace(/\/$/, '')}/v1`
  const url = `${normalizedBase}/chat/completions`

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      options: { num_ctx: 8192 },
    }),
  })

  if (!response.ok) {
    if (response.status === 404) {
      throw new LlmError(`Model '${model}' not found. Run: ollama pull ${model}`, 404)
    }
    const text = await response.text()
    const parsed = parseLlmError('ollama', text, response.status)
    throw new LlmError(parsed.message, response.status)
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>
  }
  const content = data.choices?.[0]?.message?.content || ''

  try {
    return JSON.parse(content)
  } catch {
    return { result: content }
  }
}

/**
 * Validate a provider string against known providers.
 */
export function validateProvider(provider: string): void {
  const validProviders = ['openai', 'anthropic', 'gemini', 'ollama']
  if (!validProviders.includes(provider)) {
    throw new CliError(
      `Invalid provider: ${provider}. Valid: ${validProviders.join(', ')}`
    )
  }
}

/**
 * Model-name patterns for auto-detecting the LLM provider.
 * Tested against the lowercased model string.
 */
export const MODEL_PROVIDER_PATTERNS: Record<string, RegExp> = {
  openai: /^(gpt-|o1-|o3-|o4-|davinci|text-)/,
  anthropic: /^claude-/,
  gemini: /^gemini-/,
  ollama: /^(llama|mistral|deepseek|phi|qwen)/,
}

/**
 * Auto-detect the LLM provider from a model name using prefix patterns.
 * Returns the provider string if a match is found, or null if ambiguous/unknown.
 */
export function detectProviderFromModel(model: string): string | null {
  const modelLower = model.toLowerCase()
  for (const [provider, pattern] of Object.entries(MODEL_PROVIDER_PATTERNS)) {
    if (pattern.test(modelLower)) {
      return provider
    }
  }
  return null
}

/**
 * Warn if a model name doesn't match the expected provider's pattern.
 * Used when both --model and --provider are explicitly specified.
 */
export function warnProviderModelMismatch(model: string, provider: string): void {
  const modelLower = model.toLowerCase()
  const expectedPattern = MODEL_PROVIDER_PATTERNS[provider]
  if (expectedPattern && !expectedPattern.test(modelLower)) {
    process.stderr.write(
      `Warning: Model '${model}' may not be a ${provider} model.\n\n`
    )
  }
}
