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

interface RunDetail {
  id: string
  agent_name?: string
  agent_version?: string
  status: string
  error_message?: string | null
  duration_ms?: number | null
  trigger_source?: string | null
  started_at?: string | null
  created_at?: string
}

interface TraceHeader {
  id: string
  run_id: string
  workspace_id: string
  status: string
  created_at: string
  completed_at?: string | null
}

interface TraceEvent {
  id: string
  trace_id: string
  sequence_no: number
  event_type: string
  payload: Record<string, unknown>
  provider?: string | null
  model?: string | null
  token_input?: number | null
  token_output?: number | null
  cache_read_tokens?: number | null
  cache_write_tokens?: number | null
  cost_usd?: number | null
  duration_ms?: number | null
  error_type?: string | null
  error_message?: string | null
  created_at: string
}

interface TraceEventsResponse {
  events: TraceEvent[]
  total: number
  cursor: string
  next_cursor: string | null
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
      return chalk.yellow(status)
    case 'timeout':
      return chalk.red(status)
    default:
      return status
  }
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '-'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

function formatCost(usd: number | null | undefined): string {
  if (usd == null || usd === 0) return '-'
  if (usd < 0.01) return `$${usd.toFixed(6)}`
  return `$${usd.toFixed(4)}`
}

function formatTokens(input: number | null | undefined, output: number | null | undefined): string {
  const parts: string[] = []
  if (input) parts.push(`${input.toLocaleString()} in`)
  if (output) parts.push(`${output.toLocaleString()} out`)
  return parts.length > 0 ? parts.join(', ') : '-'
}

// ============================================
// COMMAND REGISTRATION
// ============================================

export function registerTraceCommand(program: Command): void {
  program
    .command('trace <run-id>')
    .description(
      'View the execution trace for a run. Shows LLM calls, tool calls, decisions, and errors in timeline order.'
    )
    .option('--workspace <slug>', 'Workspace slug (default: current workspace)')
    .option('--json', 'Output as JSON')
    .action(
      async (
        runId: string,
        options: {
          workspace?: string
          json?: boolean
        }
      ) => {
        const config = await getResolvedConfig()
        if (!config.apiKey) {
          throw new CliError('Missing API key. Run `orch login` first.')
        }

        const workspaceId = await resolveWorkspaceId(config, options.workspace)

        // Accept req_xxx format (gateway request_id shown in run output)
        if (/^req_[0-9a-f]+$/i.test(runId)) {
          runId = runId.slice(4)
        }

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

        // Fetch run detail for context
        const run = await request<RunDetail>(
          config,
          'GET',
          `/workspaces/${workspaceId}/runs/${resolvedRunId}`
        )

        // Fetch trace header
        let trace: TraceHeader
        try {
          const traceResp = await request<{ trace: TraceHeader }>(
            config,
            'GET',
            `/workspaces/${workspaceId}/runs/${resolvedRunId}/trace`
          )
          trace = traceResp.trace
        } catch {
          throw new CliError(
            `No trace available for run ${resolvedRunId.slice(0, 8)}. Traces are captured for cloud runs only.`
          )
        }

        // Fetch all trace events (paginate if needed)
        const allEvents: TraceEvent[] = []
        let offset = 0
        const pageSize = 500

        while (true) {
          const eventsResp = await request<TraceEventsResponse>(
            config,
            'GET',
            `/workspaces/${workspaceId}/traces/${trace.id}/events?limit=${pageSize}&offset=${offset}`
          )
          allEvents.push(...eventsResp.events)

          if (eventsResp.next_cursor === null || allEvents.length >= eventsResp.total) {
            break
          }
          offset = parseInt(eventsResp.next_cursor, 10)
        }

        if (options.json) {
          printJson({ run, trace, events: allEvents })
          return
        }

        renderTrace(run, trace, allEvents)
      }
    )
}

// ============================================
// TRACE RENDERING
// ============================================

function renderTrace(
  run: RunDetail,
  trace: TraceHeader,
  events: TraceEvent[]
): void {
  // Header
  process.stdout.write(
    chalk.bold(`\nTrace for run ${run.id}\n`) +
    `  Agent:    ${run.agent_name ?? '-'}@${run.agent_version ?? '-'}\n` +
    `  Status:   ${statusColor(run.status)}\n` +
    `  Duration: ${formatDuration(run.duration_ms)}\n` +
    `  Source:   ${run.trigger_source ?? '-'}\n`
  )

  // Aggregate stats
  const stats = computeStats(events)
  if (stats.totalLlmCalls > 0 || stats.totalToolCalls > 0) {
    process.stdout.write('\n' + chalk.bold('  Summary\n'))
    if (stats.totalLlmCalls > 0) {
      process.stdout.write(
        `    LLM calls:   ${stats.totalLlmCalls}` +
        `  (${formatTokens(stats.totalTokenInput, stats.totalTokenOutput)})` +
        `  cost: ${formatCost(stats.totalCostUsd)}\n`
      )
    }
    if (stats.totalToolCalls > 0) {
      process.stdout.write(
        `    Tool calls:  ${stats.totalToolCalls}\n`
      )
    }
    if (stats.providers.length > 0) {
      process.stdout.write(
        `    Providers:   ${stats.providers.join(', ')}\n`
      )
    }
    if (stats.totalErrors > 0) {
      process.stdout.write(
        `    Errors:      ${chalk.red(String(stats.totalErrors))}\n`
      )
    }
  }

  if (events.length === 0) {
    process.stdout.write(chalk.gray('\n  No trace events recorded.\n\n'))
    return
  }

  // Timeline
  process.stdout.write('\n' + chalk.bold('  Timeline\n'))

  for (const event of events) {
    renderEvent(event)
  }

  process.stdout.write('\n')

  // Footer hint
  process.stdout.write(
    chalk.gray(`View logs: orch logs ${run.id.slice(0, 8)}\n`)
  )
  process.stdout.write(
    chalk.gray(`Replay:   orch replay ${run.id.slice(0, 8)}\n`)
  )
}

interface TraceStats {
  totalLlmCalls: number
  totalToolCalls: number
  totalErrors: number
  totalTokenInput: number
  totalTokenOutput: number
  totalCostUsd: number
  providers: string[]
}

function computeStats(events: TraceEvent[]): TraceStats {
  const stats: TraceStats = {
    totalLlmCalls: 0,
    totalToolCalls: 0,
    totalErrors: 0,
    totalTokenInput: 0,
    totalTokenOutput: 0,
    totalCostUsd: 0,
    providers: [],
  }

  const providerSet = new Set<string>()

  for (const e of events) {
    if (e.event_type === 'llm_call_succeeded') {
      stats.totalLlmCalls++
      stats.totalTokenInput += e.token_input ?? 0
      stats.totalTokenOutput += e.token_output ?? 0
      stats.totalCostUsd += e.cost_usd ?? 0
      if (e.provider) providerSet.add(e.provider)
    } else if (e.event_type === 'llm_call_failed') {
      stats.totalLlmCalls++
      stats.totalErrors++
      if (e.provider) providerSet.add(e.provider)
    } else if (e.event_type === 'tool_call_succeeded') {
      stats.totalToolCalls++
    } else if (e.event_type === 'tool_call_failed') {
      stats.totalToolCalls++
      stats.totalErrors++
    } else if (e.event_type === 'error') {
      stats.totalErrors++
    } else if (e.event_type === 'policy_violation') {
      stats.totalErrors++
    }
  }

  stats.providers = Array.from(providerSet)
  return stats
}

function renderEvent(event: TraceEvent): void {
  const seq = chalk.gray(`  #${String(event.sequence_no).padStart(2, ' ')} `)

  switch (event.event_type) {
    case 'llm_call_started': {
      const provider = event.provider ?? '?'
      const model = event.model ?? '?'
      process.stdout.write(
        seq + chalk.blue('LLM ') + chalk.gray(`${provider}/${model} started\n`)
      )
      break
    }
    case 'llm_call_succeeded': {
      const provider = event.provider ?? '?'
      const model = event.model ?? '?'
      const tokens = formatTokens(event.token_input, event.token_output)
      const cost = formatCost(event.cost_usd)
      const dur = formatDuration(event.duration_ms)
      process.stdout.write(
        seq + chalk.green('LLM ') +
        `${provider}/${model}` +
        chalk.gray(` | ${tokens} | ${cost} | ${dur}`) + '\n'
      )
      break
    }
    case 'llm_call_failed': {
      const provider = event.provider ?? '?'
      const model = event.model ?? '?'
      const errMsg = event.error_message || event.error_type || 'unknown error'
      const dur = formatDuration(event.duration_ms)
      process.stdout.write(
        seq + chalk.red('LLM ') +
        `${provider}/${model} ` +
        chalk.red(errMsg) +
        chalk.gray(` | ${dur}`) + '\n'
      )
      break
    }
    case 'tool_call_started': {
      const toolName = (event.payload?.tool_name as string) || '?'
      process.stdout.write(
        seq + chalk.cyan('TOOL ') + chalk.gray(`${toolName} started\n`)
      )
      break
    }
    case 'tool_call_succeeded': {
      const toolName = (event.payload?.tool_name as string) || '?'
      const dur = formatDuration(event.duration_ms)
      process.stdout.write(
        seq + chalk.green('TOOL ') + `${toolName}` +
        chalk.gray(` | ${dur}`) + '\n'
      )
      break
    }
    case 'tool_call_failed': {
      const toolName = (event.payload?.tool_name as string) || '?'
      const errMsg = event.error_message || event.error_type || 'unknown error'
      const dur = formatDuration(event.duration_ms)
      process.stdout.write(
        seq + chalk.red('TOOL ') + `${toolName} ` +
        chalk.red(errMsg) +
        chalk.gray(` | ${dur}`) + '\n'
      )
      break
    }
    case 'decision': {
      const desc = (event.payload?.description as string) || 'decision'
      process.stdout.write(
        seq + chalk.magenta('DECIDE ') + chalk.gray(desc) + '\n'
      )
      break
    }
    case 'fallback_transition': {
      const from = (event.payload?.from_provider as string) || '?'
      const to = (event.payload?.to_provider as string) || '?'
      const reason = (event.payload?.reason as string) || ''
      process.stdout.write(
        seq + chalk.yellow('FALLBACK ') +
        `${from} -> ${to}` +
        (reason ? chalk.gray(` (${reason})`) : '') + '\n'
      )
      break
    }
    case 'policy_violation': {
      const vType = (event.payload?.violation_type as string) || 'violation'
      const detail = (event.payload?.detail as string) || ''
      process.stdout.write(
        seq + chalk.red('POLICY ') + chalk.red(vType) +
        (detail ? chalk.gray(` — ${detail}`) : '') + '\n'
      )
      break
    }
    case 'error': {
      const errType = event.error_type || 'error'
      const errMsg = event.error_message || ''
      process.stdout.write(
        seq + chalk.red('ERROR ') + chalk.red(errType) +
        (errMsg ? chalk.gray(` — ${errMsg}`) : '') + '\n'
      )
      break
    }
    default: {
      // Unknown event type — show raw
      process.stdout.write(
        seq + chalk.gray(event.event_type) + '\n'
      )
    }
  }
}
