import { Command } from 'commander'
import chalk from 'chalk'

import { getResolvedConfig } from '../lib/config'
import { printJson } from '../lib/output'

interface ServiceStatus {
  name: string
  status: 'operational' | 'degraded' | 'outage'
  latency_ms?: number
}

interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy'
  services: ServiceStatus[]
}

const STATUS_URL = 'https://api.orchagent.io/health/detailed'
const STATUS_PAGE_URL = 'https://status.orchagent.io'

function getStatusIcon(status: string): string {
  switch (status) {
    case 'operational':
      return chalk.green('\u2713')
    case 'degraded':
      return chalk.yellow('\u26a0')
    case 'outage':
      return chalk.red('\u2717')
    default:
      return chalk.gray('?')
  }
}

function getStatusLabel(status: string): string {
  switch (status) {
    case 'operational':
      return chalk.green('Operational')
    case 'degraded':
      return chalk.yellow('Degraded')
    case 'outage':
      return chalk.red('Outage')
    default:
      return chalk.gray('Unknown')
  }
}

function getOverallStatus(services: ServiceStatus[]): string {
  const hasOutage = services.some((s) => s.status === 'outage')
  const hasDegraded = services.some((s) => s.status === 'degraded')

  if (hasOutage) {
    return chalk.red('Service Outage')
  }
  if (hasDegraded) {
    return chalk.yellow('Partial Outage')
  }
  return chalk.green('All Systems Operational')
}

function formatLatency(latencyMs?: number): string {
  if (latencyMs === undefined) {
    return ''
  }
  return chalk.gray(` (${latencyMs}ms)`)
}

function printHumanStatus(data: HealthResponse): void {
  const overallStatus = getOverallStatus(data.services)
  process.stdout.write(`\norchagent Status: ${overallStatus}\n\n`)

  for (const service of data.services) {
    const icon = getStatusIcon(service.status)
    const label = getStatusLabel(service.status)
    const latency = formatLatency(service.latency_ms)
    const paddedName = service.name.padEnd(18)
    process.stdout.write(`  ${paddedName} ${icon} ${label}${latency}\n`)
  }

  process.stdout.write(`\nView details: ${chalk.cyan(STATUS_PAGE_URL)}\n`)
}

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Check orchagent service status')
    .option('--json', 'Output raw JSON')
    .action(async (options: { json?: boolean }) => {
      try {
        const response = await fetch(STATUS_URL, {
          headers: {
            Accept: 'application/json',
          },
        })

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        }

        const data = (await response.json()) as HealthResponse

        // Handle missing or malformed services array
        if (!data.services || !Array.isArray(data.services)) {
          data.services = []
        }

        if (options.json) {
          printJson(data)
          return
        }

        printHumanStatus(data)

        // Also verify actual API connectivity
        const config = await getResolvedConfig()
        const apiUrl = `${config.apiUrl.replace(/\/$/, '')}/health`
        try {
          const apiResponse = await fetch(apiUrl, {
            signal: AbortSignal.timeout(5000),
          })
          if (!apiResponse.ok) {
            process.stderr.write('\n' + chalk.yellow('⚠️  Status page shows operational, but API returned error.') + '\n')
            process.stderr.write('   Run "orchagent doctor" for detailed diagnostics.\n')
          }
        } catch {
          process.stderr.write('\n' + chalk.yellow('⚠️  Status page shows operational, but could not reach API.') + '\n')
          process.stderr.write('   Run "orchagent doctor" for detailed diagnostics.\n')
        }
      } catch (err) {
        if (options.json) {
          printJson({ error: 'Unable to fetch status', details: String(err) })
          process.exit(1)
        }

        process.stderr.write(
          chalk.red('\nUnable to fetch status\n\n') +
            chalk.gray(`Error: ${err instanceof Error ? err.message : String(err)}\n\n`) +
            `Check ${chalk.cyan(STATUS_PAGE_URL)} for current status.\n`
        )
        process.exit(1)
      }
    })
}
