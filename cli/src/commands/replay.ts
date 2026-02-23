import { Command } from 'commander'
import chalk from 'chalk'

import { getResolvedConfig, loadConfig } from '../lib/config'
import { request } from '../lib/api'
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

interface ReplayResponse {
  run_id: string
  job_id: string
  replay_of_run_id: string
  status: string
}

interface RunDetail {
  id: string
  agent_name?: string
  agent_version?: string
  status: string
  error_message?: string | null
  duration_ms?: number | null
  input_data?: unknown
  output_data?: unknown
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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

function isShortUuid(value: string): boolean {
  return /^[0-9a-f]{7,}$/i.test(value) && !value.includes('/')
}

async function resolveShortRunId(
  config: ResolvedConfig,
  workspaceId: string,
  shortId: string
): Promise<string> {
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

function statusColor(status: string | null): string {
  if (!status) return '-'
  switch (status) {
    case 'completed':
      return chalk.green(status)
    case 'failed':
      return chalk.red(status)
    case 'running':
    case 'queued':
    case 'claimed':
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

const POLL_INTERVAL_MS = 2000
const MAX_POLL_MS = 600000 // 10 minutes

// ============================================
// COMMAND REGISTRATION
// ============================================

export function registerReplayCommand(program: Command): void {
  program
    .command('replay <run-id>')
    .description(
      'Replay a previous run. Re-executes with the same input and config from the original snapshot.'
    )
    .option('--workspace <slug>', 'Workspace slug (default: current workspace)')
    .option('--reason <text>', 'Reason for replay (stored in audit log)')
    .option('--override-policy <id>', 'Override provider policy ID for this replay')
    .option('--no-wait', 'Queue the replay and return immediately without waiting for results')
    .option('--json', 'Output as JSON')
    .action(
      async (
        runId: string,
        options: {
          workspace?: string
          reason?: string
          overridePolicy?: string
          wait?: boolean
          json?: boolean
        }
      ) => {
        const config = await getResolvedConfig()
        if (!config.apiKey) {
          throw new CliError('Missing API key. Run `orch login` first.')
        }

        const workspaceId = await resolveWorkspaceId(config, options.workspace)

        // Resolve short run IDs
        let resolvedRunId = runId
        if (isUuid(runId)) {
          resolvedRunId = runId
        } else if (isShortUuid(runId)) {
          resolvedRunId = await resolveShortRunId(config, workspaceId, runId)
        } else {
          throw new CliError(
            `Invalid run ID '${runId}'. Provide a full UUID or a short hex prefix (7+ characters).`
          )
        }

        // Submit replay request
        const body: Record<string, string | undefined> = {}
        if (options.reason) body.reason = options.reason
        if (options.overridePolicy) body.override_provider_policy_id = options.overridePolicy

        const replay = await request<ReplayResponse>(
          config,
          'POST',
          `/workspaces/${workspaceId}/runs/${resolvedRunId}/replay`,
          {
            body: JSON.stringify(body),
            headers: { 'Content-Type': 'application/json' },
          }
        )

        if (options.json && options.wait === false) {
          printJson(replay)
          return
        }

        if (options.wait === false) {
          process.stdout.write(
            chalk.green('Replay queued.\n') +
            `  Run ID:     ${replay.run_id}\n` +
            `  Job ID:     ${replay.job_id}\n` +
            `  Replaying:  ${replay.replay_of_run_id}\n` +
            chalk.gray('\nCheck status: orch logs ' + replay.run_id.slice(0, 8) + '\n')
          )
          return
        }

        // Poll for completion
        if (!options.json) {
          process.stderr.write(
            chalk.gray(`Replaying run ${resolvedRunId.slice(0, 8)}... `)
          )
        }

        const startTime = Date.now()
        let lastStatus = 'queued'
        let pollResult: RunDetail | null = null

        while (Date.now() - startTime < MAX_POLL_MS) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))

          try {
            pollResult = await request<RunDetail>(
              config,
              'GET',
              `/workspaces/${workspaceId}/runs/${replay.run_id}`
            )
          } catch {
            // Run may not exist yet if job worker hasn't picked it up
            continue
          }

          lastStatus = pollResult.status

          if (!options.json) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
            process.stderr.write(
              `\r${chalk.gray(`Replaying run ${resolvedRunId.slice(0, 8)}... ${statusColor(lastStatus)} (${elapsed}s)`)}`
            )
          }

          if (['completed', 'failed', 'timeout', 'dead_letter', 'cancelled'].includes(lastStatus)) {
            break
          }
        }

        if (!options.json) {
          process.stderr.write('\n')
        }

        // Fetch final logs
        const logs = await request<RunLogsResponse>(
          config,
          'GET',
          `/workspaces/${workspaceId}/runs/${replay.run_id}/logs`
        )

        if (options.json) {
          printJson({
            replay: {
              run_id: replay.run_id,
              replay_of_run_id: replay.replay_of_run_id,
              job_id: replay.job_id,
            },
            result: logs,
          })
          return
        }

        // Render results
        renderReplayResult(replay, logs)
      }
    )
}

// ============================================
// RENDER REPLAY RESULT
// ============================================

function renderReplayResult(
  replay: ReplayResponse,
  logs: RunLogsResponse
): void {
  process.stdout.write(
    chalk.bold(`\nReplay ${replay.run_id}\n`) +
    `  Original:  ${replay.replay_of_run_id.slice(0, 8)}\n` +
    `  Agent:     ${logs.agent_name ?? '-'}@${logs.agent_version ?? '-'}\n` +
    `  Status:    ${statusColor(logs.run_status)}\n` +
    `  Duration:  ${formatDuration(logs.execution_time_ms)}\n`
  )

  if (logs.exit_code != null) {
    const exitLabel =
      logs.exit_code === 0 ? chalk.green(String(logs.exit_code)) : chalk.red(String(logs.exit_code))
    process.stdout.write(`  Exit code: ${exitLabel}\n`)
  }

  if (logs.output_data != null && Object.keys(logs.output_data as object).length > 0) {
    process.stdout.write(
      '\n' + chalk.bold.green('--- output ---') + '\n' +
      JSON.stringify(logs.output_data, null, 2) + '\n'
    )
  }

  if (logs.error_message) {
    process.stdout.write(
      '\n' + chalk.red.bold('Error:\n') + chalk.red(logs.error_message) + '\n'
    )
  }

  if (logs.stdout) {
    process.stdout.write(
      '\n' + chalk.bold.cyan('--- stdout ---') + '\n' + logs.stdout + '\n'
    )
  }

  if (logs.stderr) {
    process.stdout.write(
      '\n' + chalk.bold.yellow('--- stderr ---') + '\n' + logs.stderr + '\n'
    )
  }

  process.stdout.write('\n')

  // Footer hint
  process.stdout.write(
    chalk.gray(`View trace: orch trace ${replay.run_id.slice(0, 8)}\n`)
  )
}
