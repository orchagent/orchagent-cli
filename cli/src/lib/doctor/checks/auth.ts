import { getResolvedConfig, loadConfig } from '../../config'
import { getOrg, ApiError } from '../../api'

import type { CheckResult } from '../types'

/**
 * Check if API key is configured (in config file or env var).
 */
export async function checkApiKeyPresent(): Promise<CheckResult> {
  const config = await getResolvedConfig()
  const fileConfig = await loadConfig()

  if (config.apiKey) {
    // Determine source of the API key
    let source = 'unknown'
    if (process.env.ORCHAGENT_API_KEY) {
      source = 'ORCHAGENT_API_KEY environment variable'
    } else if (fileConfig.api_key) {
      source = '~/.orchagent/config.json'
    }

    // Get key prefix for verbose output (mask most of the key)
    const keyPrefix = config.apiKey.slice(0, 12) + '...'

    return {
      category: 'authentication',
      name: 'api_key_present',
      status: 'success',
      message: 'API key configured',
      details: { source, keyPrefix },
    }
  }

  return {
    category: 'authentication',
    name: 'api_key_present',
    status: 'error',
    message: 'No API key configured',
    fix: 'Run `orchagent login` or set ORCHAGENT_API_KEY environment variable',
    details: { configured: false },
  }
}

/**
 * Check if API key is valid by calling the /org endpoint.
 */
export async function checkApiKeyValid(): Promise<CheckResult> {
  const config = await getResolvedConfig()

  if (!config.apiKey) {
    return {
      category: 'authentication',
      name: 'api_key_valid',
      status: 'error',
      message: 'Cannot validate API key (not configured)',
      details: { reason: 'no api key' },
    }
  }

  try {
    const org = await getOrg(config)

    return {
      category: 'authentication',
      name: 'api_key_valid',
      status: 'success',
      message: `API key valid (logged in as: ${org.name})`,
      details: {
        orgName: org.name,
        orgSlug: org.slug,
        apiUrl: config.apiUrl,
      },
    }
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 401) {
        return {
          category: 'authentication',
          name: 'api_key_valid',
          status: 'error',
          message: 'API key is invalid or expired',
          fix: 'Run `orchagent login` to get a new key',
          details: { error: err.message, status: err.status },
        }
      }

      return {
        category: 'authentication',
        name: 'api_key_valid',
        status: 'error',
        message: `API key validation failed (${err.status})`,
        fix: 'Check your network connection and try again',
        details: { error: err.message, status: err.status },
      }
    }

    return {
      category: 'authentication',
      name: 'api_key_valid',
      status: 'error',
      message: 'Could not validate API key',
      fix: 'Check your network connection and try again',
      details: { error: err instanceof Error ? err.message : 'unknown error' },
    }
  }
}

/**
 * Run all auth checks.
 */
export async function runAuthChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = []

  // First check if key is present
  const keyPresent = await checkApiKeyPresent()
  results.push(keyPresent)

  // Only validate key if it's present
  if (keyPresent.status === 'success') {
    const keyValid = await checkApiKeyValid()
    results.push(keyValid)
  }

  return results
}
