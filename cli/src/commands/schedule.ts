import { Command } from 'commander'
import Table from 'cli-table3'
import chalk from 'chalk'

import { getResolvedConfig, loadConfig } from '../lib/config'
import { request } from '../lib/api'
import { CliError } from '../lib/errors'
import { printJson } from '../lib/output'
import { parseAgentRef } from '../lib/agent-ref'
import { getAgentWithFallback } from '../lib/api'
import type { ResolvedConfig } from '../types'

// ============================================
// TYPES
// ============================================

interface Schedule {
  id: string
  workspace_id: string
  agent_id: string
  agent_name: string
  agent_version: string
  schedule_type: 'cron' | 'webhook'
  cron_expression: string | null
  timezone: string
  input_data: Record<string, unknown>
  llm_provider: string | null
  enabled: boolean
  auto_update: boolean
  webhook_secret_preview?: string
  webhook_url?: string
  webhook_secret?: string
  last_run_at: string | null
  last_run_status: string | null
  next_run_at: string | null
  run_count: number
  consecutive_failures: number
  max_consecutive_failures: number
  auto_disabled_at: string | null
  alert_webhook_url: string | null
  alert_on_failure_count: number | null
  created_at: string
}

interface ScheduleRun {
  id: string
  status: string
  error_message: string | null
  duration_ms: number | null
  trigger_source: string | null
  started_at: string
}

interface ScheduleRunsResponse {
  runs: ScheduleRun[]
  total: number
}

interface ScheduleEvent {
  id: string
  event_type: string
  message: string | null
  created_at: string
}

interface ScheduleEventsResponse {
  events: ScheduleEvent[]
}

interface SchedulesListResponse {
  schedules: Schedule[]
  total: number
}

interface ScheduleResponse {
  schedule: Schedule
}

interface TriggerResponse {
  run_id: string
  status: string
  duration_ms: number
  output: unknown
  error: string | null
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
    case 'completed': return chalk.green(status)
    case 'failed': return chalk.red(status)
    case 'running': return chalk.yellow(status)
    default: return status
  }
}

// ============================================
// COMMAND REGISTRATION
// ============================================

export function registerScheduleCommand(program: Command): void {
  const schedule = program
    .command('schedule')
    .description('Manage scheduled agent runs (cron and webhooks)')

  // orch schedule list
  schedule
    .command('list')
    .description('List schedules in your workspace')
    .option('--workspace <slug>', 'Workspace slug (default: current workspace)')
    .option('--agent <name>', 'Filter by agent name')
    .option('--type <type>', 'Filter by type (cron or webhook)')
    .option('--json', 'Output as JSON')
    .action(async (options: { workspace?: string; agent?: string; type?: string; json?: boolean }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orch login` first.')
      }

      const workspaceId = await resolveWorkspaceId(config, options.workspace)
      const params = new URLSearchParams()
      if (options.agent) params.set('agent_name', options.agent)
      if (options.type) params.set('schedule_type', options.type)
      params.set('limit', '100')

      const qs = params.toString() ? `?${params.toString()}` : ''
      const result = await request<SchedulesListResponse>(
        config,
        'GET',
        `/workspaces/${workspaceId}/schedules${qs}`
      )

      if (options.json) {
        printJson(result)
        return
      }

      if (result.schedules.length === 0) {
        process.stdout.write('No schedules found.\n')
        process.stdout.write(chalk.gray('\nCreate one with: orch schedule create <org/agent> --cron "0 9 * * *"\n'))
        return
      }

      const table = new Table({
        head: [
          chalk.bold('ID'),
          chalk.bold('Agent'),
          chalk.bold('Type'),
          chalk.bold('Schedule'),
          chalk.bold('Enabled'),
          chalk.bold('Fails'),
          chalk.bold('Last Run'),
          chalk.bold('Status'),
          chalk.bold('Runs'),
        ],
      })

      result.schedules.forEach((s) => {
        const enabledLabel = s.auto_disabled_at
          ? chalk.bgRed.white(' AUTO-DISABLED ')
          : s.enabled ? chalk.green('yes') : chalk.red('no')

        const failsLabel = s.consecutive_failures > 0
          ? chalk.red(String(s.consecutive_failures))
          : chalk.gray('0')

        const agentLabel = s.auto_update === false
          ? `${s.agent_name}@${s.agent_version} ${chalk.yellow('[pinned]')}`
          : `${s.agent_name}@${s.agent_version}`

        table.push([
          s.id.slice(0, 8),
          agentLabel,
          s.schedule_type,
          s.schedule_type === 'cron' ? (s.cron_expression ?? '-') : 'webhook',
          enabledLabel,
          failsLabel,
          formatDate(s.last_run_at),
          statusColor(s.last_run_status),
          s.run_count.toString(),
        ])
      })

      process.stdout.write(`\n${table.toString()}\n`)
      process.stdout.write(chalk.gray(`\n${result.total} schedule(s) total\n`))
    })

  // orch schedule create <agent>
  schedule
    .command('create <agent>')
    .description('Create a cron or webhook schedule (org/agent[@version])')
    .option('--cron <expression>', 'Cron expression (e.g., "0 9 * * 1" for every Monday 9am)')
    .option('--webhook', 'Create a webhook-triggered schedule instead of cron')
    .option('--timezone <tz>', 'Timezone for cron schedule (default: UTC)', 'UTC')
    .option('--input <json>', 'Input data as JSON string')
    .option('--provider <provider>', 'LLM provider (anthropic, openai, gemini)')
    .option('--pin-version', 'Pin to this version (disable auto-update on publish)')
    .option('--workspace <slug>', 'Workspace slug (default: current workspace)')
    .action(async (agentArg: string, options: {
      cron?: string
      webhook?: boolean
      timezone?: string
      input?: string
      provider?: string
      pinVersion?: boolean
      workspace?: string
    }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orch login` first.')
      }

      if (!options.cron && !options.webhook) {
        throw new CliError('Specify --cron <expression> or --webhook')
      }

      if (options.cron && options.webhook) {
        throw new CliError('Cannot use both --cron and --webhook. Choose one.')
      }

      const workspaceId = await resolveWorkspaceId(config, options.workspace)
      const ref = parseAgentRef(agentArg)

      // Resolve agent to get the ID
      const agent = await getAgentWithFallback(config, ref.org, ref.agent, ref.version)

      // Parse input data
      let inputData: Record<string, unknown> | undefined
      if (options.input) {
        try {
          inputData = JSON.parse(options.input)
        } catch {
          throw new CliError('Invalid JSON in --input. Use single quotes: --input \'{"key": "value"}\'')
        }
      }

      const scheduleType = options.webhook ? 'webhook' : 'cron'

      const body: Record<string, unknown> = {
        agent_id: agent.id,
        agent_name: ref.agent,
        agent_version: ref.version === 'latest' ? (agent.version ?? ref.version) : ref.version,
        schedule_type: scheduleType,
        timezone: options.timezone ?? 'UTC',
      }

      if (options.cron) body.cron_expression = options.cron
      if (inputData) body.input_data = inputData
      if (options.provider) body.llm_provider = options.provider
      if (options.pinVersion) body.auto_update = false

      const result = await request<ScheduleResponse>(
        config,
        'POST',
        `/workspaces/${workspaceId}/schedules`,
        {
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json' },
        }
      )

      const s = result.schedule
      process.stdout.write(chalk.green('\u2713') + ` Schedule created\n\n`)
      process.stdout.write(`  ID:     ${s.id}\n`)
      process.stdout.write(`  Agent:  ${s.agent_name}@${s.agent_version}\n`)
      process.stdout.write(`  Type:   ${s.schedule_type}\n`)

      if (s.schedule_type === 'cron') {
        process.stdout.write(`  Cron:   ${s.cron_expression}\n`)
        process.stdout.write(`  TZ:     ${s.timezone}\n`)
        if (s.next_run_at) {
          process.stdout.write(`  Next:   ${formatDate(s.next_run_at)}\n`)
        }
      } else {
        if (s.webhook_url) {
          process.stdout.write(`\n  ${chalk.bold('Webhook URL')} (save this — secret shown once):\n`)
          process.stdout.write(`  ${s.webhook_url}\n`)
        }
      }

      process.stdout.write('\n')
    })

  // orch schedule update <schedule-id>
  schedule
    .command('update <schedule-id>')
    .description('Update a schedule')
    .option('--cron <expression>', 'New cron expression')
    .option('--timezone <tz>', 'New timezone')
    .option('--input <json>', 'New input data as JSON')
    .option('--provider <provider>', 'New LLM provider')
    .option('--enable', 'Enable the schedule')
    .option('--disable', 'Disable the schedule')
    .option('--auto-update', 'Enable auto-update on publish')
    .option('--pin-version', 'Pin to current version (disable auto-update)')
    .option('--workspace <slug>', 'Workspace slug (default: current workspace)')
    .action(async (scheduleId: string, options: {
      cron?: string
      timezone?: string
      input?: string
      provider?: string
      enable?: boolean
      disable?: boolean
      autoUpdate?: boolean
      pinVersion?: boolean
      workspace?: string
    }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orch login` first.')
      }

      if (options.enable && options.disable) {
        throw new CliError('Cannot use both --enable and --disable')
      }
      if (options.autoUpdate && options.pinVersion) {
        throw new CliError('Cannot use both --auto-update and --pin-version')
      }

      const workspaceId = await resolveWorkspaceId(config, options.workspace)

      const updates: Record<string, unknown> = {}
      if (options.cron) updates.cron_expression = options.cron
      if (options.timezone) updates.timezone = options.timezone
      if (options.provider) updates.llm_provider = options.provider
      if (options.enable) updates.enabled = true
      if (options.disable) updates.enabled = false
      if (options.autoUpdate) updates.auto_update = true
      if (options.pinVersion) updates.auto_update = false

      if (options.input) {
        try {
          updates.input_data = JSON.parse(options.input)
        } catch {
          throw new CliError('Invalid JSON in --input')
        }
      }

      if (Object.keys(updates).length === 0) {
        throw new CliError('Nothing to update. Specify at least one option.')
      }

      const result = await request<ScheduleResponse>(
        config,
        'PATCH',
        `/workspaces/${workspaceId}/schedules/${scheduleId}`,
        {
          body: JSON.stringify(updates),
          headers: { 'Content-Type': 'application/json' },
        }
      )

      const s = result.schedule
      process.stdout.write(chalk.green('\u2713') + ` Schedule updated\n\n`)
      process.stdout.write(`  ID:      ${s.id}\n`)
      process.stdout.write(`  Enabled: ${s.enabled ? chalk.green('yes') : chalk.red('no')}\n`)
      if (s.cron_expression) {
        process.stdout.write(`  Cron:    ${s.cron_expression}\n`)
        process.stdout.write(`  TZ:      ${s.timezone}\n`)
      }
      if (s.next_run_at) {
        process.stdout.write(`  Next:    ${formatDate(s.next_run_at)}\n`)
      }
      process.stdout.write('\n')
    })

  // orch schedule delete <schedule-id>
  schedule
    .command('delete <schedule-id>')
    .description('Delete a schedule')
    .option('--workspace <slug>', 'Workspace slug (default: current workspace)')
    .action(async (scheduleId: string, options: { workspace?: string }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orch login` first.')
      }

      const workspaceId = await resolveWorkspaceId(config, options.workspace)

      await request<{ deleted: boolean }>(
        config,
        'DELETE',
        `/workspaces/${workspaceId}/schedules/${scheduleId}`
      )

      process.stdout.write(chalk.green('\u2713') + ` Schedule ${scheduleId} deleted\n`)
    })

  // orch schedule trigger <schedule-id>
  schedule
    .command('trigger <schedule-id>')
    .description('Manually trigger a schedule execution')
    .option('--input <json>', 'Override input data as JSON')
    .option('--workspace <slug>', 'Workspace slug (default: current workspace)')
    .action(async (scheduleId: string, options: { input?: string; workspace?: string }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orch login` first.')
      }

      const workspaceId = await resolveWorkspaceId(config, options.workspace)

      let body: string | undefined
      if (options.input) {
        try {
          JSON.parse(options.input) // validate
          body = options.input
        } catch {
          throw new CliError('Invalid JSON in --input')
        }
      }

      process.stdout.write('Triggering schedule...\n')

      const result = await request<TriggerResponse>(
        config,
        'POST',
        `/workspaces/${workspaceId}/schedules/${scheduleId}/trigger`,
        body ? {
          body,
          headers: { 'Content-Type': 'application/json' },
        } : {}
      )

      process.stdout.write(chalk.green('\u2713') + ` Run completed\n\n`)
      process.stdout.write(`  Run ID:   ${result.run_id}\n`)
      process.stdout.write(`  Status:   ${statusColor(result.status)}\n`)
      process.stdout.write(`  Duration: ${result.duration_ms}ms\n`)

      if (result.error) {
        process.stdout.write(`  Error:    ${chalk.red(result.error)}\n`)
      }

      if (result.output) {
        process.stdout.write(`\n  Output:\n`)
        process.stdout.write(`  ${JSON.stringify(result.output, null, 2).split('\n').join('\n  ')}\n`)
      }

      process.stdout.write('\n')
    })

  // orch schedule info <schedule-id>
  schedule
    .command('info <schedule-id>')
    .description('Show detailed schedule information with recent runs and events')
    .option('--workspace <slug>', 'Workspace slug (default: current workspace)')
    .option('--json', 'Output as JSON')
    .action(async (scheduleId: string, options: { workspace?: string; json?: boolean }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orch login` first.')
      }

      const workspaceId = await resolveWorkspaceId(config, options.workspace)

      const [scheduleRes, runsRes, eventsRes] = await Promise.all([
        request<ScheduleResponse>(config, 'GET', `/workspaces/${workspaceId}/schedules/${scheduleId}`),
        request<ScheduleRunsResponse>(config, 'GET', `/workspaces/${workspaceId}/schedules/${scheduleId}/runs?limit=5`),
        request<ScheduleEventsResponse>(config, 'GET', `/workspaces/${workspaceId}/schedules/${scheduleId}/events?limit=5`),
      ])

      if (options.json) {
        printJson({ schedule: scheduleRes.schedule, runs: runsRes.runs, events: eventsRes.events })
        return
      }

      const s = scheduleRes.schedule
      process.stdout.write(`\n${chalk.bold('Schedule Details')}\n\n`)
      process.stdout.write(`  ID:         ${s.id}\n`)
      process.stdout.write(`  Agent:      ${s.agent_name}@${s.agent_version}\n`)
      process.stdout.write(`  Type:       ${s.schedule_type}\n`)
      if (s.cron_expression) {
        process.stdout.write(`  Cron:       ${s.cron_expression}\n`)
        process.stdout.write(`  Timezone:   ${s.timezone}\n`)
      }
      process.stdout.write(`  Enabled:    ${s.enabled ? chalk.green('yes') : chalk.red('no')}\n`)
      process.stdout.write(`  Auto-update: ${s.auto_update === false ? chalk.yellow('pinned') : chalk.green('yes')}\n`)

      if (s.auto_disabled_at) {
        process.stdout.write(`  ${chalk.bgRed.white(' AUTO-DISABLED ')} at ${formatDate(s.auto_disabled_at)}\n`)
      }

      process.stdout.write(`  Runs:       ${s.run_count}\n`)
      process.stdout.write(`  Failures:   ${s.consecutive_failures > 0 ? chalk.red(String(s.consecutive_failures)) : '0'} / ${s.max_consecutive_failures}\n`)

      if (s.next_run_at) {
        process.stdout.write(`  Next Run:   ${formatDate(s.next_run_at)}\n`)
      }
      if (s.alert_webhook_url) {
        process.stdout.write(`  Alert URL:  ${s.alert_webhook_url.slice(0, 50)}...\n`)
      }

      // Recent runs
      if (runsRes.runs.length > 0) {
        process.stdout.write(`\n${chalk.bold('Recent Runs')}\n`)
        const runsTable = new Table({
          head: [chalk.bold('Status'), chalk.bold('Duration'), chalk.bold('Error'), chalk.bold('Started')],
        })
        for (const r of runsRes.runs) {
          runsTable.push([
            statusColor(r.status),
            r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)}s` : '-',
            r.error_message ? chalk.red(r.error_message.slice(0, 60)) : '-',
            formatDate(r.started_at),
          ])
        }
        process.stdout.write(`${runsTable.toString()}\n`)
      }

      // Recent events
      if (eventsRes.events.length > 0) {
        process.stdout.write(`\n${chalk.bold('Recent Events')}\n`)
        for (const e of eventsRes.events) {
          const color = e.event_type.includes('fail') || e.event_type.includes('disabled') ? chalk.red : chalk.gray
          process.stdout.write(`  ${chalk.gray(formatDate(e.created_at))} ${color(e.event_type)} ${e.message || ''}\n`)
        }
      }

      process.stdout.write('\n')
    })

  // orch schedule runs <schedule-id>
  schedule
    .command('runs <schedule-id>')
    .description('List run history for a schedule')
    .option('--workspace <slug>', 'Workspace slug (default: current workspace)')
    .option('--status <status>', 'Filter by status (completed, failed, running, timeout)')
    .option('--limit <n>', 'Number of runs to show (default: 20)', '20')
    .option('--json', 'Output as JSON')
    .action(async (scheduleId: string, options: {
      workspace?: string
      status?: string
      limit: string
      json?: boolean
    }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orch login` first.')
      }

      const workspaceId = await resolveWorkspaceId(config, options.workspace)

      const params = new URLSearchParams()
      params.set('limit', options.limit)
      if (options.status) params.set('status', options.status)
      const qs = `?${params.toString()}`

      const result = await request<ScheduleRunsResponse>(
        config, 'GET', `/workspaces/${workspaceId}/schedules/${scheduleId}/runs${qs}`
      )

      if (options.json) {
        printJson(result)
        return
      }

      if (!result.runs.length) {
        process.stdout.write('No runs found.\n')
        return
      }

      const table = new Table({
        head: [
          chalk.bold('Run ID'),
          chalk.bold('Status'),
          chalk.bold('Source'),
          chalk.bold('Duration'),
          chalk.bold('Error'),
          chalk.bold('Started'),
        ],
      })

      for (const r of result.runs) {
        table.push([
          r.id.slice(0, 8),
          statusColor(r.status),
          r.trigger_source || '-',
          r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)}s` : '-',
          r.error_message ? chalk.red(r.error_message.slice(0, 50)) : '-',
          formatDate(r.started_at),
        ])
      }

      process.stdout.write(`${table.toString()}\n`)
      process.stdout.write(chalk.gray(`\n${result.total} run${result.total !== 1 ? 's' : ''} total\n`))
    })
}
