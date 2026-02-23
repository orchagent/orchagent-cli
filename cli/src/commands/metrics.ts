import { Command } from 'commander'
import chalk from 'chalk'

import { getResolvedConfig, loadConfig } from '../lib/config'
import { request, ApiError } from '../lib/api'
import { CliError } from '../lib/errors'
import { printJson } from '../lib/output'
import type { ResolvedConfig } from '../types'

// ============================================
// TYPES
// ============================================

interface Workspace {
  id: string
  name: string
  slug: string
}

interface WorkspacesResponse {
  workspaces: Workspace[]
}

interface MetricsOverview {
  total_runs: number
  completed: number
  failed: number
  timeout: number
  success_rate: number
  error_rate: number
  p50_latency_ms: number
  p95_latency_ms: number
  avg_latency_ms: number
  runs_per_day: number
}

interface MetricsAgent {
  agent_name: string
  agent_id: string
  latest_version: string
  total_runs: number
  completed: number
  failed: number
  timeout: number
  success_rate: number
  error_rate: number
  p50_latency_ms: number
  p95_latency_ms: number
  avg_latency_ms: number
  top_error: string | null
  trigger_sources: Record<string, number>
}

interface MetricsDashboardResponse {
  overview: MetricsOverview
  agents: MetricsAgent[]
  daily_series: unknown[]
  period: string
  total_agents: number
}

// ============================================
// HELPERS
// ============================================

async function resolveWorkspaceId(
  config: ResolvedConfig,
  slug?: string
): Promise<string> {
  const configFile = await loadConfig()
  const targetSlug = slug ?? configFile.workspace

  const response = await request<WorkspacesResponse>(config, 'GET', '/workspaces')

  if (targetSlug) {
    const workspace = response.workspaces.find((w) => w.slug === targetSlug)
    if (!workspace) {
      throw new CliError(`Workspace '${targetSlug}' not found.`)
    }
    return workspace.id
  }

  // No workspace specified — auto-select if user has exactly one
  if (response.workspaces.length === 0) {
    throw new CliError('No workspaces found. Create one with `orch workspace create <name>`.')
  }

  if (response.workspaces.length === 1) {
    return response.workspaces[0].id
  }

  const slugs = response.workspaces.map((w) => w.slug).join(', ')
  throw new CliError(
    `Multiple workspaces available: ${slugs}\n` +
    'Specify one with --workspace <slug> or run `orch workspace use <slug>`.'
  )
}

function formatDuration(ms: number): string {
  if (ms === 0) return '-'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function rateColor(rate: number): string {
  if (rate >= 95) return chalk.green(`${rate}%`)
  if (rate >= 80) return chalk.yellow(`${rate}%`)
  return chalk.red(`${rate}%`)
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + ' '.repeat(len - str.length)
}

function padLeft(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : ' '.repeat(len - str.length) + str
}

// ============================================
// COMMAND
// ============================================

export function registerMetricsCommand(program: Command): void {
  program
    .command('metrics')
    .description('Show agent performance metrics for a workspace')
    .option('--workspace <slug>', 'Workspace slug (default: active workspace)')
    .option('--days <n>', 'Number of days to analyze', '30')
    .option('--agent <name>', 'Filter to a specific agent')
    .option('--json', 'Output as JSON')
    .action(async (options: {
      workspace?: string
      days?: string
      agent?: string
      json?: boolean
    }) => {
      const config = await getResolvedConfig()
      const workspaceId = await resolveWorkspaceId(config, options.workspace)

      const days = parseInt(options.days || '30', 10)
      if (isNaN(days) || days < 1 || days > 365) {
        process.stderr.write(chalk.red('Error: --days must be between 1 and 365\n'))
        process.exit(1)
      }

      const params = new URLSearchParams({ days: String(days) })
      if (options.agent) params.set('agent_name', options.agent)

      let data: MetricsDashboardResponse
      try {
        data = await request<MetricsDashboardResponse>(
          config,
          'GET',
          `/workspaces/${workspaceId}/metrics/dashboard?${params}`,
          { headers: { 'X-Workspace-Id': workspaceId } }
        )
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) {
          process.stderr.write(chalk.red('Error: Not a member of this workspace\n'))
          process.exit(1)
        }
        throw err
      }

      if (options.json) {
        printJson(data)
        return
      }

      const { overview, agents } = data

      // Header
      process.stdout.write('\n')
      process.stdout.write(chalk.bold('Agent Metrics') + chalk.gray(` (last ${days}d)\n`))
      process.stdout.write('='.repeat(50) + '\n\n')

      // Overview stats
      if (overview.total_runs === 0) {
        process.stdout.write(chalk.yellow('No runs in this period.\n\n'))
        return
      }

      process.stdout.write(`  Total Runs:   ${chalk.bold(String(overview.total_runs))}\n`)
      process.stdout.write(`  Success Rate: ${rateColor(overview.success_rate)}\n`)
      process.stdout.write(`  Error Rate:   ${overview.error_rate}% ${chalk.gray(`(${overview.failed} failed, ${overview.timeout} timeout)`)}\n`)
      process.stdout.write(`  p50 Latency:  ${chalk.cyan(formatDuration(overview.p50_latency_ms))}\n`)
      process.stdout.write(`  p95 Latency:  ${chalk.yellow(formatDuration(overview.p95_latency_ms))}\n`)
      process.stdout.write(`  Avg Latency:  ${formatDuration(overview.avg_latency_ms)}\n`)
      process.stdout.write(`  Runs/Day:     ${overview.runs_per_day}\n`)

      // Per-agent table
      if (agents.length > 0) {
        process.stdout.write(`\n${chalk.bold('Per Agent')}\n`)
        process.stdout.write('-'.repeat(90) + '\n')

        // Header
        process.stdout.write(
          padRight('Agent', 25) +
          padLeft('Runs', 8) +
          padLeft('Success', 10) +
          padLeft('p50', 10) +
          padLeft('p95', 10) +
          padLeft('Errors', 8) +
          '  Top Error\n'
        )
        process.stdout.write('-'.repeat(90) + '\n')

        for (const agent of agents) {
          const nameStr = agent.agent_name.length > 22
            ? agent.agent_name.slice(0, 22) + '..'
            : agent.agent_name
          const errorStr = agent.top_error
            ? agent.top_error.slice(0, 20)
            : '-'

          process.stdout.write(
            padRight(nameStr, 25) +
            padLeft(String(agent.total_runs), 8) +
            padLeft(
              agent.success_rate >= 95 ? chalk.green(`${agent.success_rate}%`) :
              agent.success_rate >= 80 ? chalk.yellow(`${agent.success_rate}%`) :
              chalk.red(`${agent.success_rate}%`),
              // chalk adds escape chars — pad the raw value, then colorize
              10
            ) +
            padLeft(formatDuration(agent.p50_latency_ms), 10) +
            padLeft(formatDuration(agent.p95_latency_ms), 10) +
            padLeft(String(agent.failed + agent.timeout), 8) +
            '  ' + chalk.gray(errorStr) + '\n'
          )
        }
      }

      process.stdout.write('\n')
    })
}
