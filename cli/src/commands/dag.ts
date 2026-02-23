import { Command } from 'commander'
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

interface Workspace {
  id: string
  name: string
  slug: string
}

interface WorkspacesResponse {
  workspaces: Workspace[]
}

interface RunsListResponse {
  runs: { id: string }[]
  total: number
}

interface DagNodeTraceSummary {
  llm_calls: number
  tool_calls: number
  errors: number
  total_tokens: number
  total_cost_usd: number
}

interface DagNode {
  run_id: string
  agent_name: string
  agent_version: string
  status: string
  duration_ms: number | null
  started_at: string
  self_cost_usd: number
  subtree_cost_usd: number
  cost_pct: number
  input_tokens: number
  output_tokens: number
  llm_model: string | null
  llm_provider: string | null
  trace_summary: DagNodeTraceSummary
  children: DagNode[]
}

interface LiveDagResponse {
  root_run_id: string
  is_live: boolean
  total_cost_usd: number
  total_duration_ms: number
  node_count: number
  active_count: number
  completed_count: number
  failed_count: number
  most_expensive_agent: string
  tree: DagNode
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
      `Ambiguous run ID '${shortId}' — matches ${result.runs.length} runs. Use more characters.`
    )
  }

  return result.runs[0].id
}

// ============================================
// FORMATTERS
// ============================================

function statusColor(status: string): string {
  switch (status) {
    case 'completed':
      return chalk.green(status)
    case 'failed':
    case 'timeout':
    case 'dead_letter':
      return chalk.red(status)
    case 'running':
      return chalk.yellow(status)
    case 'queued':
    case 'claimed':
      return chalk.cyan(status)
    default:
      return chalk.gray(status)
  }
}

function statusIcon(status: string): string {
  switch (status) {
    case 'completed':
      return chalk.green('✓')
    case 'failed':
    case 'timeout':
    case 'dead_letter':
      return chalk.red('✗')
    case 'running':
      return chalk.yellow('◉')
    case 'queued':
    case 'claimed':
      return chalk.cyan('○')
    default:
      return chalk.gray('?')
  }
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '-'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

function formatCost(usd: number): string {
  if (usd === 0) return '-'
  if (usd < 0.01) return `$${usd.toFixed(6)}`
  return `$${usd.toFixed(4)}`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

// ============================================
// ASCII DAG RENDERER
// ============================================

function renderDagHeader(dag: LiveDagResponse): void {
  const liveTag = dag.is_live ? chalk.blue(' [LIVE]') : ''
  process.stdout.write(
    chalk.bold(`\nOrchestration DAG`) + liveTag + '\n' +
    `  Root:     ${dag.root_run_id.slice(0, 8)}...\n` +
    `  Agents:   ${dag.node_count}\n` +
    `  Duration: ${formatDuration(dag.total_duration_ms)}\n` +
    `  Cost:     ${formatCost(dag.total_cost_usd)}\n`
  )

  if (dag.active_count > 0 || dag.failed_count > 0) {
    const parts: string[] = []
    if (dag.completed_count > 0) parts.push(chalk.green(`${dag.completed_count} completed`))
    if (dag.active_count > 0) parts.push(chalk.yellow(`${dag.active_count} active`))
    if (dag.failed_count > 0) parts.push(chalk.red(`${dag.failed_count} failed`))
    process.stdout.write(`  Status:   ${parts.join(', ')}\n`)
  }

  if (dag.most_expensive_agent) {
    process.stdout.write(`  Costly:   ${chalk.yellow(dag.most_expensive_agent)}\n`)
  }
}

function renderDagTree(node: DagNode, prefix: string, isLast: boolean, isRoot: boolean): void {
  // Connector characters
  const connector = isRoot ? '' : (isLast ? '└── ' : '├── ')
  const childPrefix = isRoot ? '' : (isLast ? '    ' : '│   ')

  // Status icon + agent name
  const icon = statusIcon(node.status)
  const name = chalk.bold(node.agent_name)
  const version = chalk.gray(node.agent_version)

  // Metrics line
  const metricParts: string[] = []
  metricParts.push(statusColor(node.status))
  if (node.duration_ms != null) metricParts.push(chalk.gray(formatDuration(node.duration_ms)))
  if (node.self_cost_usd > 0) metricParts.push(chalk.gray(formatCost(node.self_cost_usd)))
  if (node.llm_model) metricParts.push(chalk.gray(node.llm_model))
  const metrics = metricParts.join(chalk.gray(' | '))

  // Trace summary
  const ts = node.trace_summary
  const traceParts: string[] = []
  if (ts.llm_calls > 0) traceParts.push(`${ts.llm_calls} LLM`)
  if (ts.tool_calls > 0) traceParts.push(`${ts.tool_calls} tool`)
  if (ts.errors > 0) traceParts.push(chalk.red(`${ts.errors} err`))
  if (ts.total_tokens > 0) traceParts.push(`${formatTokens(ts.total_tokens)} tok`)
  const traceInfo = traceParts.length > 0 ? chalk.gray(` (${traceParts.join(', ')})`) : ''

  process.stdout.write(
    `${prefix}${connector}${icon} ${name} ${version}\n` +
    `${prefix}${childPrefix}  ${metrics}${traceInfo}\n`
  )

  // Render children
  for (let i = 0; i < node.children.length; i++) {
    const isChildLast = i === node.children.length - 1
    renderDagTree(node.children[i], prefix + childPrefix, isChildLast, false)
  }
}

function clearScreen(): void {
  process.stdout.write('\x1b[2J\x1b[H')
}

// ============================================
// COMMAND
// ============================================

export function registerDagCommand(program: Command): void {
  program
    .command('dag <run-id>')
    .description(
      'Visualize the orchestration call graph for a run. Shows all agents in the chain with real-time status.'
    )
    .option('--workspace <slug>', 'Workspace slug (default: current workspace)')
    .option('--live', 'Keep polling for updates while the run is active')
    .option('--interval <seconds>', 'Poll interval in seconds for --live mode', '2')
    .option('--json', 'Output as JSON')
    .action(
      async (
        runId: string,
        options: {
          workspace?: string
          live?: boolean
          interval?: string
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

        const interval = Math.max(1, Math.min(30, parseFloat(options.interval || '2')))

        // Fetch DAG
        const spinner = createSpinner('Fetching orchestration DAG...')
        spinner.start()

        let dag: LiveDagResponse
        try {
          dag = await request<LiveDagResponse>(
            config,
            'GET',
            `/workspaces/${workspaceId}/runs/${resolvedRunId}/dag`
          )
          spinner.stop()
        } catch (e) {
          spinner.stop()
          const msg = e instanceof Error ? e.message : 'Unknown error'
          if (msg.includes('404') || msg.includes('not found') || msg.includes('Not part of')) {
            throw new CliError(
              `Run ${resolvedRunId.slice(0, 8)}... is not part of an orchestration chain.`
            )
          }
          throw e
        }

        if (options.json && !options.live) {
          printJson(dag)
          return
        }

        // Render initial DAG
        renderDagHeader(dag)
        process.stdout.write('\n')
        renderDagTree(dag.tree, '  ', true, true)
        process.stdout.write('\n')

        // Live mode: poll for updates
        if (options.live && dag.is_live) {
          process.stdout.write(
            chalk.gray(`Live mode: polling every ${interval}s. Press Ctrl+C to stop.\n\n`)
          )

          while (true) {
            await new Promise((resolve) => setTimeout(resolve, interval * 1000))

            try {
              dag = await request<LiveDagResponse>(
                config,
                'GET',
                `/workspaces/${workspaceId}/runs/${resolvedRunId}/dag`
              )
            } catch {
              // Ignore transient errors during polling
              continue
            }

            if (options.json) {
              printJson(dag)
            } else {
              clearScreen()
              renderDagHeader(dag)
              process.stdout.write('\n')
              renderDagTree(dag.tree, '  ', true, true)
              process.stdout.write('\n')
            }

            if (!dag.is_live) {
              process.stdout.write(chalk.green('Execution complete.\n'))
              break
            }
          }
        } else if (options.live && !dag.is_live) {
          process.stdout.write(chalk.gray('Run is not active. Showing final state.\n'))
        }

        // Footer hints
        process.stdout.write(
          chalk.gray(`View trace:  orch trace ${resolvedRunId.slice(0, 8)}\n`) +
          chalk.gray(`View logs:   orch logs ${resolvedRunId.slice(0, 8)}\n`)
        )
      }
    )
}
