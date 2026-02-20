import type { CheckResult } from '../types'

// All supported LLM providers (single source of truth)
const PROVIDERS = [
  { id: 'openai', displayName: 'OpenAI', envVars: ['OPENAI_API_KEY'], keyPrefix: 'sk-' },
  { id: 'anthropic', displayName: 'Anthropic', envVars: ['ANTHROPIC_API_KEY'], keyPrefix: 'sk-ant-' },
  { id: 'gemini', displayName: 'Gemini', envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] },
  { id: 'ollama', displayName: 'Ollama', envVars: ['OLLAMA_HOST'], isEndpoint: true },
] as const

type Provider = (typeof PROVIDERS)[number]

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
 * Run all LLM configuration checks with per-provider breakdown.
 *
 * Checks local environment variables for LLM provider keys.
 * Server-side keys are managed through the workspace secrets vault
 * (use `orch secrets list` to check).
 */
export async function runLlmChecks(options?: { skipServer?: boolean }): Promise<CheckResult[]> {
  const results: CheckResult[] = []

  // Per-provider results (local env vars only)
  let configuredCount = 0
  let firstUnconfigured: string | undefined

  for (const provider of PROVIDERS) {
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

    if (local) configuredCount++
    else if (!firstUnconfigured) firstUnconfigured = provider.id

    results.push({
      category: 'llm',
      name: `llm_provider_${provider.id}`,
      status: local ? 'success' : 'info',
      message: `${provider.id} — ${local ? 'Configured (local)' : 'Not configured locally'}`,
      details: {
        providerId: provider.id,
        displayName: provider.displayName,
        server: null,
        local,
        ...(localEnvVar && { localEnvVar }),
        ...(formatHint && { formatHint }),
      },
    })
  }

  // Summary result
  let summaryStatus: CheckResult['status']
  let summaryMessage: string
  let summaryFix: string | undefined

  if (configuredCount === 0) {
    summaryStatus = 'warning'
    summaryMessage = 'No LLM providers configured locally'
    summaryFix = 'For cloud runs, add keys to your workspace vault: orch secrets set ANTHROPIC_API_KEY <key>'
  } else {
    summaryStatus = 'success'
    summaryMessage = `${configuredCount} local provider${configuredCount > 1 ? 's' : ''} configured`
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
