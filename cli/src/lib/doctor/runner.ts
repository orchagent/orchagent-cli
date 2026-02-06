import { runEnvironmentChecks } from './checks/environment'
import { runConfigChecks } from './checks/config'
import { runAuthChecks } from './checks/auth'
import { runConnectivityChecks } from './checks/connectivity'
import { runLlmChecks } from './checks/llm'

import type { CheckResult, DoctorSummary } from './types'

/**
 * Run all diagnostic checks in order.
 * Checks are organized by category and run in a logical sequence.
 */
export async function runAllChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = []

  // Environment checks (no dependencies)
  const envResults = await runEnvironmentChecks()
  results.push(...envResults)

  // Config checks (no dependencies)
  const configResults = await runConfigChecks()
  results.push(...configResults)

  // Connectivity checks (test gateway before auth)
  const connectivityResults = await runConnectivityChecks()
  results.push(...connectivityResults)

  // Check if gateway is reachable before running auth/LLM checks
  const gatewayOk = connectivityResults.some(
    (r) => r.name === 'gateway_reachable' && r.status === 'success'
  )

  if (gatewayOk) {
    // Auth checks (requires gateway)
    const authResults = await runAuthChecks()
    results.push(...authResults)

    // LLM checks (requires auth for server keys)
    const llmResults = await runLlmChecks()
    results.push(...llmResults)
  } else {
    // Add placeholder results when gateway is unreachable
    results.push({
      category: 'authentication',
      name: 'api_key_present',
      status: 'warning',
      message: 'Skipped (gateway unreachable)',
      details: { skipped: true, reason: 'gateway unreachable' },
    })

    // LLM checks with server status unknown — local env vars still checked
    const llmResults = await runLlmChecks({ skipServer: true })
    results.push(...llmResults)
  }

  return results
}

/**
 * Calculate summary statistics from check results.
 * 'info' status counts as passed (informational, not a problem).
 */
export function calculateSummary(results: CheckResult[]): DoctorSummary {
  return {
    passed: results.filter((r) => r.status === 'success' || r.status === 'info').length,
    warnings: results.filter((r) => r.status === 'warning').length,
    errors: results.filter((r) => r.status === 'error').length,
  }
}
