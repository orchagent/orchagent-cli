import { getResolvedConfig } from '../../config'

import type { CheckResult } from '../types'

const LATENCY_WARNING_MS = 2000

/**
 * Check if gateway is reachable by pinging /health endpoint.
 * Also measures response time.
 */
export async function checkGatewayHealth(): Promise<CheckResult[]> {
  const config = await getResolvedConfig()
  const healthUrl = `${config.apiUrl.replace(/\/$/, '')}/health`

  const startTime = Date.now()

  try {
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(10000),
    })
    const latency = Date.now() - startTime

    if (!response.ok) {
      return [
        {
          category: 'connectivity',
          name: 'gateway_reachable',
          status: 'error',
          message: `Gateway returned ${response.status}`,
          fix: 'Check if orchagent API is operational at https://status.orchagent.io',
          details: {
            url: healthUrl,
            status: response.status,
            latency,
          },
        },
      ]
    }

    // Parse hostname for display
    const apiHost = new URL(config.apiUrl).host

    const results: CheckResult[] = [
      {
        category: 'connectivity',
        name: 'gateway_reachable',
        status: 'success',
        message: `Gateway reachable (${apiHost})`,
        details: {
          url: healthUrl,
          status: response.status,
          host: apiHost,
        },
      },
    ]

    // Add latency check
    if (latency > LATENCY_WARNING_MS) {
      results.push({
        category: 'connectivity',
        name: 'response_time',
        status: 'warning',
        message: `Response time: ${latency}ms (high latency)`,
        fix: 'High latency detected. Check network or try a different region.',
        details: { latency, threshold: LATENCY_WARNING_MS },
      })
    } else {
      results.push({
        category: 'connectivity',
        name: 'response_time',
        status: 'success',
        message: `Response time: ${latency}ms`,
        details: { latency, threshold: LATENCY_WARNING_MS },
      })
    }

    return results
  } catch (err) {
    const latency = Date.now() - startTime
    const isTimeout =
      err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')

    if (isTimeout) {
      return [
        {
          category: 'connectivity',
          name: 'gateway_reachable',
          status: 'error',
          message: 'Gateway connection timed out',
          fix: 'Check network, firewall, or proxy settings',
          details: { url: healthUrl, error: 'timeout', latency },
        },
      ]
    }

    return [
      {
        category: 'connectivity',
        name: 'gateway_reachable',
        status: 'error',
        message: 'Cannot reach gateway',
        fix: 'Check network, firewall, or proxy settings',
        details: {
          url: healthUrl,
          error: err instanceof Error ? err.message : 'unknown error',
          latency,
        },
      },
    ]
  }
}

/**
 * Run all connectivity checks.
 */
export async function runConnectivityChecks(): Promise<CheckResult[]> {
  return checkGatewayHealth()
}
