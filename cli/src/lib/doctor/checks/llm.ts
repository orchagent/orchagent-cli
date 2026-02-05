import { getResolvedConfig } from '../../config'
import { fetchLlmKeys, ApiError } from '../../api'

import type { CheckResult } from '../types'

// Common LLM provider environment variables
const LLM_ENV_VARS = [
  { name: 'OPENAI_API_KEY', provider: 'OpenAI' },
  { name: 'ANTHROPIC_API_KEY', provider: 'Anthropic' },
  { name: 'GOOGLE_API_KEY', provider: 'Google' },
  { name: 'GEMINI_API_KEY', provider: 'Gemini' },
]

/**
 * Check if LLM keys are configured on the server.
 */
export async function checkServerLlmKeys(): Promise<CheckResult> {
  const config = await getResolvedConfig()

  if (!config.apiKey) {
    return {
      category: 'llm',
      name: 'server_llm_keys',
      status: 'warning',
      message: 'Cannot check server LLM keys (not logged in)',
      details: { reason: 'no api key' },
    }
  }

  try {
    const keys = await fetchLlmKeys(config)

    if (keys.length === 0) {
      return {
        category: 'llm',
        name: 'server_llm_keys',
        status: 'warning',
        message: 'No LLM keys configured on server',
        fix: 'Run `orch keys add <provider>` or add keys at orchagent.io/settings',
        details: { count: 0, providers: [] },
      }
    }

    const providers = keys.map((k) => k.provider)

    // Warn if only one provider configured (no fallback for rate limits)
    if (keys.length === 1) {
      return {
        category: 'llm',
        name: 'server_llm_keys',
        status: 'warning',
        message: `Only 1 LLM provider configured (${providers[0]}). Consider adding a backup for rate limit fallback.`,
        fix: 'Run: orchagent keys add <provider>',
        details: { count: keys.length, providers },
      }
    }

    return {
      category: 'llm',
      name: 'server_llm_keys',
      status: 'success',
      message: `Server LLM keys configured (${providers.join(', ')})`,
      details: { count: keys.length, providers },
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      return {
        category: 'llm',
        name: 'server_llm_keys',
        status: 'warning',
        message: 'Cannot check server LLM keys (auth failed)',
        details: { error: err.message },
      }
    }

    return {
      category: 'llm',
      name: 'server_llm_keys',
      status: 'warning',
      message: 'Could not check server LLM keys',
      details: { error: err instanceof Error ? err.message : 'unknown error' },
    }
  }
}

/**
 * Check if common LLM provider API keys are set in environment.
 */
export async function checkLocalLlmEnvVars(): Promise<CheckResult> {
  const configuredProviders: string[] = []
  const details: Record<string, boolean> = {}

  for (const { name, provider } of LLM_ENV_VARS) {
    const isSet = !!process.env[name]
    details[name] = isSet
    if (isSet) {
      configuredProviders.push(provider)
    }
  }

  if (configuredProviders.length === 0) {
    return {
      category: 'llm',
      name: 'local_llm_env',
      status: 'warning',
      message: 'No local LLM API keys found in environment',
      fix: 'Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or similar for local runs',
      details,
    }
  }

  // Deduplicate (Google and Gemini might both be set)
  const uniqueProviders = [...new Set(configuredProviders)]

  return {
    category: 'llm',
    name: 'local_llm_env',
    status: 'success',
    message: `Local LLM keys found (${uniqueProviders.join(', ')})`,
    details,
  }
}

/**
 * Run all LLM configuration checks.
 * If server keys are configured, local keys warning becomes informational.
 */
export async function runLlmChecks(): Promise<CheckResult[]> {
  const serverResult = await checkServerLlmKeys()
  const localResult = await checkLocalLlmEnvVars()

  // If server keys are configured, downgrade local keys warning to info
  // Users who only use server-side calls don't need local keys
  if (serverResult.status === 'success' && localResult.status === 'warning') {
    localResult.status = 'info'
    localResult.message = 'No local LLM API keys (using server keys)'
    localResult.fix = undefined
  }

  return [serverResult, localResult]
}
