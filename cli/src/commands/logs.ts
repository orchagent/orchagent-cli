import { Command } from 'commander'
import Table from 'cli-table3'
import chalk from 'chalk'

import { getResolvedConfig, loadConfig } from '../lib/config'
import { request } from '../lib/api'
import { CliError } from '../lib/errors'
import { printJson } from '../lib/output'
import type { ResolvedConfig } from '../types'

// ============================================
// TYPES
// ============================================

interface RunSummary {
  id: string
  agent_name: string
  agent_version: string
  status: string
  error_message: string | null
  duration_ms: number | null
  trigger_source: string | null
  started_at: string | null
  created_at: string
}

interface RunsListResponse {
  runs: RunSummary[]
  total: number
}

interface RunLogsResponse {
  run_id: string
  agent_name: string | null
  agent_version: string | null
  run_status: string | null
  error_message: string | null
  input_data: unknown | null
  output_data: unknown | null
  has_execution_log: boolean
  stdout: string | null
  stderr: string | null
  exit_code: number | null
  execution_time_ms: number | null
}

interface Workspace {
  id: string
  name: string
  slug: string
}

interface WorkspacesResponse {
  workspaces: Workspace[]
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

  if (!targetSlug) {
    throw new CliError(
      'No workspace specified. Use --workspace <slug> or run `orch workspace use <slug>` first.'
    )
  }

  const response = await request<WorkspacesResponse>(config, 'GET', '/workspaces')
  const workspace = response.workspaces.find((w) => w.slug === targetSlug)

  if (!workspace) {
    throw new CliError(`Workspace '${targetSlug}' not found.`)
  }

  return workspace.id
}

function formatDate(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString()
}

function statusColor(status: string | null): string {
  if (!status) return '-'
  switch (status) {
    case 'completed':
      return chalk.green(status)
    case 'failed':
      return chalk.red(status)
    case 'running':
      return chalk.yellow(status)
    case 'timeout':
      return chalk.red(status)
    default:
      return status
  }
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '-'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

/** Detect if a string looks like a full UUID (run ID) */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

/** Detect if a string looks like a short UUID prefix (8+ hex chars) */
function isShortUuid(value: string): boolean {
  return /^[0-9a-f]{7,}$/i.test(value) && !value.includes('/')
}

// ============================================
// COMMAND REGISTRATION
// ============================================

export function registerLogsCommand(program: Command): void {
  program
    .command('logs [target]')
    .description(
      'View execution logs. Use with no args to list recent runs, an agent name to filter, or a run ID for full detail.'
    )
    .option('--workspace <slug>', 'Workspace slug (default: current workspace)')
    .option('--status <status>', 'Filter by status: running, completed, failed, timeout')
    .option('--limit <n>', 'Number of runs to show (default: 20)', '20')
    .option('--json', 'Output as JSON')
    .action(
      async (
        target: string | undefined,
        options: {
          workspace?: string
          status?: string
          limit?: string
          json?: boolean
        }
      ) => {
        const config = await getResolvedConfig()
        if (!config.apiKey) {
          throw new CliError('Missing API key. Run `orch login` first.')
        }

        const workspaceId = await resolveWorkspaceId(config, options.workspace)

        // If target looks like a UUID (full or short prefix), show detailed logs for that run
        if (target && isUuid(target)) {
          await showRunLogs(config, workspaceId, target, options.json)
          return
        }

        if (target && isShortUuid(target)) {
          // Short UUID prefix — find the matching run from the list
          const fullId = await resolveShortRunId(config, workspaceId, target)
          await showRunLogs(config, workspaceId, fullId, options.json)
          return
        }

        // Otherwise list runs, optionally filtered by agent name.
        // Strip org prefix if provided (e.g. "joe/my-agent" → "my-agent")
        const agentFilter = target?.includes('/') ? target.split('/').pop() : target
        await listRuns(config, workspaceId, agentFilter, options)
      }
    )
}

// ============================================
// SHORT RUN ID RESOLUTION
// ============================================

async function resolveShortRunId(
  config: ResolvedConfig,
  workspaceId: string,
  shortId: string
): Promise<string> {
  // Server-side prefix matching — searches ALL runs, not just the last 200
  const result = await request<RunsListResponse>(
    config,
    'GET',
    `/workspaces/${workspaceId}/runs?limit=200&run_id_prefix=${encodeURIComponent(shortId)}`
  )

  if (result.runs.length === 0) {
    throw new CliError(`No run found matching '${shortId}'.`)
  }
  if (result.runs.length > 1) {
    throw new CliError(
      `Ambiguous run ID '${shortId}' — matches ${result.runs.length} runs. Use more characters to narrow it down.`
    )
  }

  return result.runs[0].id
}

// ============================================
// LIST RUNS
// ============================================

async function listRuns(
  config: ResolvedConfig,
  workspaceId: string,
  agentName: string | undefined,
  options: { status?: string; limit?: string; json?: boolean }
): Promise<void> {
  const params = new URLSearchParams()
  if (agentName) params.set('agent_name', agentName)
  if (options.status) params.set('status', options.status)
  const limit = parseInt(options.limit ?? '20', 10)
  params.set('limit', String(Math.min(Math.max(1, limit), 200)))

  const qs = params.toString() ? `?${params.toString()}` : ''
  const result = await request<RunsListResponse>(
    config,
    'GET',
    `/workspaces/${workspaceId}/runs${qs}`
  )

  if (options.json) {
    printJson(result)
    return
  }

  if (result.runs.length === 0) {
    if (agentName) {
      process.stdout.write(`No runs found for agent '${agentName}'.\n`)
    } else {
      process.stdout.write('No runs found in this workspace.\n')
    }
    return
  }

  const table = new Table({
    head: [
      chalk.bold('Run ID'),
      chalk.bold('Agent'),
      chalk.bold('Status'),
      chalk.bold('Duration'),
      chalk.bold('Source'),
      chalk.bold('Started'),
      chalk.bold('Error'),
    ],
  })

  result.runs.forEach((r) => {
    const errorPreview = r.error_message
      ? chalk.red(r.error_message.length > 50 ? r.error_message.slice(0, 50) + '...' : r.error_message)
      : chalk.gray('-')

    table.push([
      r.id.slice(0, 8),
      `${r.agent_name}@${r.agent_version}`,
      statusColor(r.status),
      formatDuration(r.duration_ms),
      r.trigger_source ?? '-',
      formatDate(r.started_at || r.created_at),
      errorPreview,
    ])
  })

  process.stdout.write(table.toString() + '\n')

  if (result.total > result.runs.length) {
    process.stdout.write(
      chalk.gray(`\nShowing ${result.runs.length} of ${result.total} runs. Use --limit to see more.\n`)
    )
  }

  process.stdout.write(
    chalk.gray('\nView detailed logs for a run: orch logs <run-id>\n')
  )
}

// ============================================
// SHOW RUN LOGS
// ============================================

async function showRunLogs(
  config: ResolvedConfig,
  workspaceId: string,
  runId: string,
  json?: boolean
): Promise<void> {
  const result = await request<RunLogsResponse>(
    config,
    'GET',
    `/workspaces/${workspaceId}/runs/${runId}/logs`
  )

  if (json) {
    printJson(result)
    return
  }

  // Header
  process.stdout.write(
    chalk.bold(`\nRun ${runId}\n`) +
    `Agent:    ${result.agent_name ?? '-'}@${result.agent_version ?? '-'}\n` +
    `Status:   ${statusColor(result.run_status)}\n` +
    `Duration: ${formatDuration(result.execution_time_ms)}\n`
  )

  if (result.exit_code != null) {
    const exitLabel =
      result.exit_code === 0 ? chalk.green(String(result.exit_code)) : chalk.red(String(result.exit_code))
    process.stdout.write(`Exit code: ${exitLabel}\n`)
  }

  // Input data
  if (result.input_data != null && Object.keys(result.input_data as object).length > 0) {
    process.stdout.write(
      '\n' + chalk.bold.blue('--- input ---') + '\n' +
      JSON.stringify(result.input_data, null, 2) + '\n'
    )
  }

  // Output data
  if (result.output_data != null && Object.keys(result.output_data as object).length > 0) {
    process.stdout.write(
      '\n' + chalk.bold.green('--- output ---') + '\n' +
      JSON.stringify(result.output_data, null, 2) + '\n'
    )
  }

  // Error message
  if (result.error_message) {
    process.stdout.write(
      '\n' + chalk.red.bold('Error:\n') + chalk.red(result.error_message) + '\n'
    )
  }

  // Stdout
  if (result.stdout) {
    process.stdout.write(
      '\n' + chalk.bold.cyan('--- stdout ---') + '\n' + result.stdout + '\n'
    )
  }

  // Stderr
  if (result.stderr) {
    process.stdout.write(
      '\n' + chalk.bold.yellow('--- stderr ---') + '\n' + result.stderr + '\n'
    )
  }

  // No execution log available
  if (!result.has_execution_log && !result.error_message) {
    process.stdout.write(
      chalk.gray(
        '\nNo sandbox output available for this run. ' +
        'Execution logs are captured for agents with a code runtime (tool/agent types with runtime.command).\n'
      )
    )
  }

  process.stdout.write('\n')
}
