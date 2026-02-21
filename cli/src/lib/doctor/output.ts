import chalk from 'chalk'

import type { CheckResult, DoctorSummary, DoctorJsonOutput } from './types'

// Status symbols
const SYMBOLS: Record<string, string> = {
  success: chalk.green('\u2713'), // checkmark
  warning: chalk.yellow('\u26a0'), // warning sign
  error: chalk.red('\u2717'), // X mark
  info: chalk.blue('\u2139'), // info sign
}

// Category display names
const CATEGORY_NAMES: Record<string, string> = {
  environment: 'Environment',
  configuration: 'Configuration',
  connectivity: 'Connectivity',
  authentication: 'Authentication',
  llm: 'LLM Providers',
}

// Symbol for server-unknown state
const UNKNOWN_SYMBOL = chalk.dim('?')

/**
 * Render the LLM section with per-provider table layout.
 */
function renderLlmSection(checks: CheckResult[], verbose: boolean): void {
  const providerChecks = checks.filter(
    (c) => c.name.startsWith('llm_provider_') && c.name !== 'llm_provider_summary'
  )
  const summaryCheck = checks.find((c) => c.name === 'llm_provider_summary')

  // Calculate padding for aligned columns
  const maxIdLen = Math.max(...providerChecks.map((c) => {
    const id = (c.details?.providerId as string) || ''
    return id.length
  }))

  for (const check of providerChecks) {
    const id = (check.details?.providerId as string) || ''
    const padded = id.padEnd(maxIdLen)
    const serverVal = check.details?.server
    const localVal = check.details?.local as boolean
    const configured = serverVal === true || localVal

    // Pick symbol: ✓ for configured, ✗ for not configured, ? for server-unknown
    let symbol: string
    if (configured) {
      symbol = SYMBOLS.success
    } else if (serverVal === null) {
      symbol = UNKNOWN_SYMBOL
    } else {
      symbol = SYMBOLS.error
    }

    // Build location text
    let location: string
    if (serverVal === null) {
      location = localVal ? 'Local configured (vault keys not checked)' : 'Not configured locally (vault keys used for cloud runs)'
    } else if (serverVal && localVal) {
      location = 'Configured (server + local)'
    } else if (serverVal) {
      location = 'Configured (server)'
    } else if (localVal) {
      location = 'Configured (local)'
    } else {
      location = 'Not configured'
    }

    process.stdout.write(`  ${symbol} ${padded}  ${location}\n`)

    // Show format hint as dim indented text
    const formatHint = check.details?.formatHint as string | undefined
    if (formatHint) {
      process.stdout.write(chalk.dim(`    \u26a0 ${formatHint}\n`))
    }

    // Verbose: show details
    if (verbose && check.details) {
      for (const [key, value] of Object.entries(check.details)) {
        if (key === 'providerId' || key === 'displayName' || key === 'formatHint') continue
        const displayValue = typeof value === 'object' ? JSON.stringify(value) : String(value)
        process.stdout.write(chalk.dim(`    ${key}: ${displayValue}\n`))
      }
    }
  }

  // Summary tip/fix
  if (summaryCheck) {
    process.stdout.write('\n')
    const symbol = SYMBOLS[summaryCheck.status] || SYMBOLS.info
    process.stdout.write(`  ${symbol} ${summaryCheck.message}\n`)
    if (summaryCheck.fix) {
      process.stdout.write(chalk.dim(`    \u2192 ${summaryCheck.fix}\n`))
    }
  }
}

/**
 * Group check results by category.
 */
function groupByCategory(results: CheckResult[]): Map<string, CheckResult[]> {
  const groups = new Map<string, CheckResult[]>()

  // Define category order
  const categoryOrder = [
    'environment',
    'configuration',
    'connectivity',
    'authentication',
    'llm',
  ]

  // Initialize groups in order
  for (const cat of categoryOrder) {
    groups.set(cat, [])
  }

  // Add results to groups
  for (const result of results) {
    const existing = groups.get(result.category) || []
    existing.push(result)
    groups.set(result.category, existing)
  }

  // Remove empty groups
  for (const [key, value] of groups) {
    if (value.length === 0) {
      groups.delete(key)
    }
  }

  return groups
}

/**
 * Print human-readable output to stdout.
 */
export function printHumanOutput(
  results: CheckResult[],
  summary: DoctorSummary,
  verbose: boolean
): void {
  // Header
  process.stdout.write('\n')
  process.stdout.write(chalk.bold('orchagent Doctor\n'))
  process.stdout.write('================\n\n')

  // Group and print results
  const groups = groupByCategory(results)

  for (const [category, checks] of groups) {
    const displayName = CATEGORY_NAMES[category] || category
    process.stdout.write(chalk.bold(`${displayName}\n`))

    if (category === 'llm') {
      renderLlmSection(checks, verbose)
    } else {
      for (const check of checks) {
        const symbol = SYMBOLS[check.status] || SYMBOLS.info
        process.stdout.write(`  ${symbol} ${check.message}\n`)

        // Show fix suggestion for warnings/errors (not for success/info)
        if (check.fix && (check.status === 'warning' || check.status === 'error')) {
          process.stdout.write(chalk.dim(`    \u2192 ${check.fix}\n`))
        }

        // Show details in verbose mode
        if (verbose && check.details) {
          for (const [key, value] of Object.entries(check.details)) {
            const displayValue =
              typeof value === 'object' ? JSON.stringify(value) : String(value)
            process.stdout.write(chalk.dim(`    ${key}: ${displayValue}\n`))
          }
        }
      }
    }

    process.stdout.write('\n')
  }

  // Summary line
  const summaryParts: string[] = []

  if (summary.passed > 0) {
    summaryParts.push(chalk.green(`${summary.passed} passed`))
  }
  if (summary.warnings > 0) {
    summaryParts.push(chalk.yellow(`${summary.warnings} warning${summary.warnings > 1 ? 's' : ''}`))
  }
  if (summary.errors > 0) {
    summaryParts.push(chalk.red(`${summary.errors} error${summary.errors > 1 ? 's' : ''}`))
  }

  process.stdout.write(`Summary: ${summaryParts.join(', ')}\n`)
}

/**
 * Format results as JSON output.
 */
export function formatJsonOutput(
  results: CheckResult[],
  summary: DoctorSummary
): DoctorJsonOutput {
  return {
    summary,
    checks: results,
  }
}
