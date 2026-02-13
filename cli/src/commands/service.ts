import { Command } from 'commander'
import Table from 'cli-table3'
import chalk from 'chalk'

import { getResolvedConfig, loadConfig } from '../lib/config'
import { request } from '../lib/api'
import { CliError } from '../lib/errors'
import { printJson } from '../lib/output'
import { createSpinner } from '../lib/spinner'
import type { ResolvedConfig } from '../types'

// ============================================
// TYPES
// ============================================

interface AutomationService {
  id: string
  workspace_id: string
  service_name: string
  agent_id: string
  agent_name: string
  agent_version: string
  desired_state: 'running' | 'stopped'
  current_state: 'provisioning' | 'running' | 'unhealthy' | 'failed' | 'migrating' | 'deleting' | 'deleted'
  health_status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
  infrastructure_provider: string | null
  service_tier: string | null
  provider_service_id: string | null
  provider_region: string | null
  provider_url: string | null
  cloud_run_service: string | null
  cloud_run_region: string | null
  cloud_run_url: string | null
  min_instances: number
  max_instances: number
  restart_count: number
  last_restart_at: string | null
  last_deployed_at: string | null
  last_error: string | null
  consecutive_restart_failures: number
  max_restart_failures: number
  auto_paused_at: string | null
  alert_webhook_url: string | null
  created_at: string
  updated_at: string
}

interface ServicesListResponse {
  services: AutomationService[]
  total: number
}

interface ServiceResponse {
  service: AutomationService & { events?: ServiceEvent[] }
}

interface ServiceEvent {
  id: string
  event_type: string
  message: string
  created_at: string
}

interface LogEntry {
  timestamp: string | null
  severity: string
  message: string
}

interface LogsResponse {
  logs: LogEntry[]
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

function stateColor(state: string): string {
  switch (state) {
    case 'running':
      return chalk.green(state)
    case 'provisioning':
      return chalk.yellow(state)
    case 'unhealthy':
    case 'failed':
      return chalk.red(state)
    case 'deleting':
    case 'deleted':
      return chalk.gray(state)
    default:
      return state
  }
}

function healthColor(health: string): string {
  switch (health) {
    case 'healthy':
      return chalk.green(health)
    case 'degraded':
      return chalk.yellow(health)
    case 'unhealthy':
      return chalk.red(health)
    default:
      return chalk.gray(health)
  }
}

function severityColor(severity: string, message: string): string {
  switch (severity.toUpperCase()) {
    case 'ERROR':
    case 'CRITICAL':
      return chalk.red(message)
    case 'WARNING':
      return chalk.yellow(message)
    case 'INFO':
      return chalk.white(message)
    default:
      return chalk.gray(message)
  }
}

// ============================================
// COMMAND REGISTRATION
// ============================================

export function registerServiceCommand(program: Command): void {
  const service = program
    .command('service')
    .description('Manage always-on automation services')

  // orch service deploy <org/agent[@version]>
  service
    .command('deploy <agent>')
    .description('Deploy an always-on automation service')
    .option('--workspace <slug>', 'Workspace slug (default: current workspace)')
    .option('--name <service-name>', 'Service name (default: agent name)')
    .option('--min-instances <n>', 'Minimum instances (default: 1)', '1')
    .option('--max-instances <n>', 'Maximum instances (default: 1)', '1')
    .option('--env <KEY=VALUE>', 'Environment variable (repeatable)', collectKeyValue, {})
    .option('--secret <NAME>', 'Workspace secret name (repeatable)', collectArray, [])
    .option('--command <cmd>', 'Override entrypoint command')
    .option('--arg <value>', 'Command argument (repeatable)', collectArray, [])
    .option('--json', 'Output as JSON')
    .action(async (agentArg: string, options: {
      workspace?: string
      name?: string
      minInstances: string
      maxInstances: string
      env: Record<string, string>
      secret: string[]
      command?: string
      arg: string[]
      json?: boolean
    }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orch login` first.')
      }

      const workspaceId = await resolveWorkspaceId(config, options.workspace)

      // Parse agent ref: org/agent[@version]
      const parts = agentArg.split('/')
      if (parts.length !== 2) {
        throw new CliError('Agent must be in format: org/agent[@version]')
      }
      const [, agentPart] = parts
      const atIndex = agentPart.indexOf('@')
      const agentName = atIndex >= 0 ? agentPart.slice(0, atIndex) : agentPart
      const agentVersion = atIndex >= 0 ? agentPart.slice(atIndex + 1) : 'latest'
      const serviceName = options.name || agentName

      const minInstances = parseInt(options.minInstances, 10)
      const maxInstances = parseInt(options.maxInstances, 10)

      if (isNaN(minInstances) || isNaN(maxInstances)) {
        throw new CliError('--min-instances and --max-instances must be numbers')
      }

      // First, resolve the agent to get agent_id
      const spinner = createSpinner('Resolving agent...')
      spinner.start()

      let agentId: string
      try {
        // List agents for the workspace via the correct gateway endpoint
        const agentsList = await request<Array<{ id: string; name: string; version: string; created_at?: string }>>(
          config, 'GET', `/agents?workspace_id=${workspaceId}`
        )
        let match: typeof agentsList[number] | undefined
        if (agentVersion === 'latest') {
          // Filter all matching agents by name, sort by created_at desc to get newest
          const candidates = agentsList
            .filter(a => a.name === agentName)
            .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
          match = candidates[0]
        } else {
          match = agentsList.find(a => a.name === agentName && a.version === agentVersion)
        }
        if (!match) {
          spinner.fail('Agent not found')
          throw new CliError(`Agent '${agentName}' (version ${agentVersion}) not found in workspace`)
        }
        agentId = match.id
        spinner.succeed('Agent resolved')
      } catch (e) {
        if (e instanceof CliError) throw e
        spinner.fail('Failed to resolve agent')
        throw e
      }

      const deploySpinner = createSpinner('Deploying service...')
      deploySpinner.start()

      try {
        const result = await request<ServiceResponse>(
          config,
          'POST',
          `/workspaces/${workspaceId}/services`,
          {
            body: JSON.stringify({
              agent_id: agentId,
              agent_name: agentName,
              agent_version: agentVersion,
              service_name: serviceName,
              min_instances: minInstances,
              max_instances: maxInstances,
              command: options.command || null,
              args: options.arg.length > 0 ? options.arg : null,
              env: Object.keys(options.env).length > 0 ? options.env : null,
              secret_names: options.secret.length > 0 ? options.secret : null,
            }),
            headers: { 'Content-Type': 'application/json' },
          }
        )

        deploySpinner.succeed('Service deployed')

        if (options.json) {
          printJson(result.service)
          return
        }

        const svc = result.service
        process.stdout.write(`\n${chalk.green('\u2713')} Service deployed successfully\n\n`)
        process.stdout.write(`  ${chalk.bold('ID:')}       ${svc.id}\n`)
        process.stdout.write(`  ${chalk.bold('Name:')}     ${svc.service_name}\n`)
        process.stdout.write(`  ${chalk.bold('Agent:')}    ${svc.agent_name}@${svc.agent_version}\n`)
        process.stdout.write(`  ${chalk.bold('State:')}    ${stateColor(svc.current_state)}\n`)
        process.stdout.write(`  ${chalk.bold('URL:')}      ${svc.provider_url || svc.cloud_run_url || '-'}\n`)
        process.stdout.write(`\n`)
        process.stdout.write(chalk.gray(`View logs: orch service logs ${svc.id}\n`))
      } catch (e) {
        deploySpinner.fail('Deploy failed')
        throw e
      }
    })

  // orch service list
  service
    .command('list')
    .description('List automation services in your workspace')
    .option('--workspace <slug>', 'Workspace slug (default: current workspace)')
    .option('--status <state>', 'Filter by state')
    .option('--json', 'Output as JSON')
    .action(async (options: { workspace?: string; status?: string; json?: boolean }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orch login` first.')
      }

      const workspaceId = await resolveWorkspaceId(config, options.workspace)

      const params = new URLSearchParams()
      if (options.status) params.set('status', options.status)
      params.set('limit', '100')
      const qs = params.toString() ? `?${params.toString()}` : ''

      const result = await request<ServicesListResponse>(
        config, 'GET', `/workspaces/${workspaceId}/services${qs}`
      )

      if (options.json) {
        printJson(result)
        return
      }

      if (!result.services.length) {
        process.stdout.write('No services found.\n')
        process.stdout.write(chalk.gray('Deploy one with: orch service deploy <org/agent>\n'))
        return
      }

      const table = new Table({
        head: [
          chalk.bold('Name'),
          chalk.bold('Agent'),
          chalk.bold('State'),
          chalk.bold('Health'),
          chalk.bold('Restarts'),
          chalk.bold('Deployed'),
        ],
      })

      for (const svc of result.services) {
        const stateLabel = svc.auto_paused_at
          ? chalk.bgRed.white(' CRASH-LOOP ')
          : stateColor(svc.current_state)

        const restartsLabel = svc.consecutive_restart_failures > 0
          ? `${svc.restart_count} (${chalk.red(String(svc.consecutive_restart_failures))} fails)`
          : String(svc.restart_count)

        table.push([
          svc.service_name,
          `${svc.agent_name}@${svc.agent_version}`,
          stateLabel,
          healthColor(svc.health_status),
          restartsLabel,
          formatDate(svc.last_deployed_at),
        ])
      }

      process.stdout.write(`${table.toString()}\n`)
      process.stdout.write(chalk.gray(`\n${result.total} service${result.total !== 1 ? 's' : ''}\n`))
    })

  // orch service logs <service-id>
  service
    .command('logs <service-id>')
    .description('Fetch recent logs for a service')
    .option('--workspace <slug>', 'Workspace slug (default: current workspace)')
    .option('--limit <n>', 'Number of log lines (default: 100)', '100')
    .option('--since <timestamp>', 'Only show logs after this ISO timestamp')
    .option('--json', 'Output as JSON')
    .action(async (serviceId: string, options: {
      workspace?: string
      limit: string
      since?: string
      json?: boolean
    }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orch login` first.')
      }

      const workspaceId = await resolveWorkspaceId(config, options.workspace)

      const params = new URLSearchParams()
      params.set('limit', options.limit)
      if (options.since) params.set('since', options.since)
      const qs = `?${params.toString()}`

      const result = await request<LogsResponse>(
        config, 'GET', `/workspaces/${workspaceId}/services/${serviceId}/logs${qs}`
      )

      if (options.json) {
        printJson(result)
        return
      }

      if (!result.logs.length) {
        process.stdout.write('No logs found.\n')
        return
      }

      for (const entry of result.logs) {
        const ts = entry.timestamp ? new Date(entry.timestamp).toISOString().replace('T', ' ').replace('Z', '') : '???'
        const sev = entry.severity.padEnd(7)
        process.stdout.write(`${chalk.gray(ts)} ${severityColor(entry.severity, sev)} ${entry.message}\n`)
      }
    })

  // orch service restart <service-id>
  service
    .command('restart <service-id>')
    .description('Restart an automation service')
    .option('--workspace <slug>', 'Workspace slug (default: current workspace)')
    .option('--json', 'Output as JSON')
    .action(async (serviceId: string, options: { workspace?: string; json?: boolean }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orch login` first.')
      }

      const workspaceId = await resolveWorkspaceId(config, options.workspace)

      const spinner = createSpinner('Restarting service...')
      spinner.start()

      try {
        const result = await request<ServiceResponse>(
          config, 'POST', `/workspaces/${workspaceId}/services/${serviceId}/restart`
        )

        spinner.succeed('Service restarted')

        if (options.json) {
          printJson(result.service)
          return
        }

        process.stdout.write(`${chalk.green('\u2713')} Service '${result.service.service_name}' restarted (restarts: ${result.service.restart_count})\n`)
      } catch (e) {
        spinner.fail('Restart failed')
        throw e
      }
    })

  // orch service info <service-id>
  service
    .command('info <service-id>')
    .description('Show detailed service information with events')
    .option('--workspace <slug>', 'Workspace slug (default: current workspace)')
    .option('--json', 'Output as JSON')
    .action(async (serviceId: string, options: { workspace?: string; json?: boolean }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orch login` first.')
      }

      const workspaceId = await resolveWorkspaceId(config, options.workspace)

      const result = await request<ServiceResponse>(
        config, 'GET', `/workspaces/${workspaceId}/services/${serviceId}`
      )

      if (options.json) {
        printJson(result.service)
        return
      }

      const svc = result.service
      process.stdout.write(`\n${chalk.bold('Service Details')}\n\n`)
      process.stdout.write(`  ID:           ${svc.id}\n`)
      process.stdout.write(`  Name:         ${svc.service_name}\n`)
      process.stdout.write(`  Agent:        ${svc.agent_name}@${svc.agent_version}\n`)
      process.stdout.write(`  State:        ${stateColor(svc.current_state)}\n`)
      process.stdout.write(`  Health:       ${healthColor(svc.health_status)}\n`)

      if (svc.auto_paused_at) {
        process.stdout.write(`  ${chalk.bgRed.white(' CRASH-LOOP ')} auto-paused at ${formatDate(svc.auto_paused_at)}\n`)
      }

      process.stdout.write(`  Restarts:     ${svc.restart_count}\n`)
      if (svc.consecutive_restart_failures > 0) {
        process.stdout.write(`  Fail Streak:  ${chalk.red(String(svc.consecutive_restart_failures))} / ${svc.max_restart_failures}\n`)
      }
      process.stdout.write(`  Instances:    ${svc.min_instances}-${svc.max_instances}\n`)
      process.stdout.write(`  Service ID:   ${svc.provider_service_id || svc.cloud_run_service || '-'}\n`)
      process.stdout.write(`  URL:          ${svc.provider_url || svc.cloud_run_url || '-'}\n`)
      process.stdout.write(`  Deployed:     ${formatDate(svc.last_deployed_at)}\n`)
      process.stdout.write(`  Last Restart: ${formatDate(svc.last_restart_at)}\n`)

      if (svc.last_error) {
        process.stdout.write(`  Last Error:   ${chalk.red(svc.last_error)}\n`)
      }
      if (svc.alert_webhook_url) {
        process.stdout.write(`  Alert URL:    ${svc.alert_webhook_url.slice(0, 50)}...\n`)
      }

      // Events timeline
      const events = svc.events || []
      if (events.length > 0) {
        process.stdout.write(`\n${chalk.bold('Recent Events')}\n`)
        for (const e of events.slice(0, 10)) {
          const color = e.event_type.includes('fail') || e.event_type.includes('paused') ? chalk.red : chalk.gray
          process.stdout.write(`  ${chalk.gray(formatDate(e.created_at))} ${color(e.event_type)} ${e.message || ''}\n`)
        }
      }

      process.stdout.write('\n')
    })

  // orch service delete <service-id>
  service
    .command('delete <service-id>')
    .description('Delete an automation service')
    .option('--workspace <slug>', 'Workspace slug (default: current workspace)')
    .option('--json', 'Output as JSON')
    .action(async (serviceId: string, options: { workspace?: string; json?: boolean }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orch login` first.')
      }

      const workspaceId = await resolveWorkspaceId(config, options.workspace)

      const spinner = createSpinner('Deleting service...')
      spinner.start()

      try {
        const result = await request<{ deleted: boolean; service: AutomationService }>(
          config, 'DELETE', `/workspaces/${workspaceId}/services/${serviceId}`
        )

        spinner.succeed('Service deleted')

        if (options.json) {
          printJson(result)
          return
        }

        process.stdout.write(`${chalk.green('\u2713')} Service '${result.service.service_name}' deleted\n`)
      } catch (e) {
        spinner.fail('Delete failed')
        throw e
      }
    })
}

// ============================================
// OPTION COLLECTORS
// ============================================

function collectKeyValue(value: string, previous: Record<string, string>): Record<string, string> {
  const idx = value.indexOf('=')
  if (idx < 0) {
    throw new CliError(`Invalid env format: '${value}'. Use KEY=VALUE.`)
  }
  previous[value.slice(0, idx)] = value.slice(idx + 1)
  return previous
}

function collectArray(value: string, previous: string[]): string[] {
  previous.push(value)
  return previous
}
