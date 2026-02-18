import { getResolvedConfig } from '../../config'
import { listLlmKeys, ApiError } from '../../api'

import type { CheckResult } from '../types'

// All supported LLM providers (single source of truth)
const PROVIDERS = [
  { id: 'openai', displayName: 'OpenAI', envVars: ['OPENAI_API_KEY'], keyPrefix: 'sk-' },
  { id: 'anthropic', displayName: 'Anthropic', envVars: ['ANTHROPIC_API_KEY'], keyPrefix: 'sk-ant-' },
  { id: 'gemini', displayName: 'Gemini', envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] },
  { id: 'ollama', displayName: 'Ollama', envVars: ['OLLAMA_HOST'], isEndpoint: true },
] as const

type Provider = (typeof PROVIDERS)[number]

interface ProviderStatus {
  providerId: string
  displayName: string
  server: boolean | null // null = couldn't check (e.g. gateway unreachable)
  local: boolean
  localEnvVar?: string
  formatHint?: string
}

/**
 * Get a format hint for a key value, or null if the format looks OK.
 * Hints are informational only — never errors or warnings.
 */
function getFormatHint(provider: Provider, value: string): string | null {
  if ('isEndpoint' in provider && provider.isEndpoint) return null
  if (!('keyPrefix' in provider) || !provider.keyPrefix) return null

  const prefix = provider.keyPrefix
  if (!value.startsWith(prefix)) {
    return `Key doesn't match expected format (${prefix}...)`
  }
  return null
}

/**
 * Gather per-provider status from server keys and local env vars.
 */
function gatherProviderStatuses(serverProviders: string[] | null): ProviderStatus[] {
  return PROVIDERS.map((provider) => {
    // Server status
    const server = serverProviders === null ? null : serverProviders.includes(provider.id)

    // Local status — check each env var
    let local = false
    let localEnvVar: string | undefined
    let formatHint: string | undefined

    for (const envVar of provider.envVars) {
      const value = process.env[envVar]
      if (value) {
        local = true
        localEnvVar = envVar
        const hint = getFormatHint(provider, value)
        if (hint) formatHint = hint
        break
      }
    }

    return {
      providerId: provider.id,
      displayName: provider.displayName,
      server,
      local,
      localEnvVar,
      formatHint,
    }
  })
}

/**
 * Build a human-readable location string from server/local status.
 */
function locationString(status: ProviderStatus): string {
  if (status.server === null) {
    // Server unknown (offline)
    if (status.local) return 'Server unknown, local configured'
    return 'Server unknown, not local'
  }
  if (status.server && status.local) return 'Configured (server + local)'
  if (status.server) return 'Configured (server)'
  if (status.local) return 'Configured (local)'
  return 'Not configured'
}

/**
 * Run all LLM configuration checks with per-provider breakdown.
 *
 * When skipServer is true, server status is null for all providers
 * (shown as "unknown" in output). Use this when the gateway is unreachable.
 */
export async function runLlmChecks(options?: { skipServer?: boolean }): Promise<CheckResult[]> {
  let serverProviders: string[] | null = null

  if (!options?.skipServer) {
    try {
      const config = await getResolvedConfig()
      if (config.apiKey) {
        const keys = await listLlmKeys(config)
        serverProviders = keys.map((k) => k.provider)
      }
    } catch (err) {
      // If we can't reach the server, treat as unknown
      if (err instanceof ApiError && err.status === 401) {
        // Auth failed — server providers unknown
      }
      // Network error or other — server providers unknown
    }
  }

  const statuses = gatherProviderStatuses(serverProviders)
  const results: CheckResult[] = []

  // Per-provider results
  for (const status of statuses) {
    const configured = status.server === true || status.local
    results.push({
      category: 'llm',
      name: `llm_provider_${status.providerId}`,
      status: configured ? 'success' : 'info',
      message: `${status.providerId} — ${locationString(status)}`,
      details: {
        providerId: status.providerId,
        displayName: status.displayName,
        server: status.server,
        local: status.local,
        ...(status.localEnvVar && { localEnvVar: status.localEnvVar }),
        ...(status.formatHint && { formatHint: status.formatHint }),
      },
    })
  }

  // Summary result
  const configuredCount = statuses.filter((s) => s.server === true || s.local).length
  const firstUnconfigured = statuses.find((s) => s.server !== true && !s.local)

  let summaryStatus: CheckResult['status']
  let summaryMessage: string
  let summaryFix: string | undefined

  if (configuredCount === 0) {
    summaryStatus = 'warning'
    summaryMessage = 'No LLM providers configured'
    summaryFix = firstUnconfigured ? `Run: orchagent keys add ${firstUnconfigured.providerId}` : undefined
  } else {
    summaryStatus = 'success'
    summaryMessage =
      configuredCount < 2
        ? 'Tip: Multiple providers enable automatic rate limit fallback.'
        : `${configuredCount} providers configured`
    summaryFix = firstUnconfigured ? `Run: orchagent keys add ${firstUnconfigured.providerId}` : undefined
  }

  results.push({
    category: 'llm',
    name: 'llm_provider_summary',
    status: summaryStatus,
    message: summaryMessage,
    fix: summaryFix,
    details: { configuredCount, totalProviders: PROVIDERS.length },
  })

  return results
}
