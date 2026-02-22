import { Command } from 'commander'
import chalk from 'chalk'

import { getResolvedConfig } from '../lib/config'
import { ApiError, getOrg, listMyAgents, getPublicAgent, resolveWorkspaceIdForOrg } from '../lib/api'
import { parseAgentRef } from '../lib/agent-ref'
import { withSpinner } from '../lib/spinner'
import type { AgentTypeValue } from '../types'

// ── Types ──────────────────────────────────────────────────────

type SchemaProperty = {
  type?: string
  description?: string
  items?: { type?: string }
}

type Schema = {
  type?: string
  properties?: Record<string, SchemaProperty>
  required?: string[]
}

type ManifestDependency = {
  id: string
  version: string
}

type CustomTool = {
  name: string
  description?: string
  command?: string
}

/** Normalised snapshot of a single agent version — all fields we diff on. */
type AgentSnapshot = {
  org: string
  name: string
  version: string
  type: string
  description?: string
  callable?: boolean
  run_mode?: string | null
  execution_engine?: string | null
  supported_providers: string[]
  tags: string[]
  input_schema?: Schema
  output_schema?: Schema
  prompt?: string
  dependencies: ManifestDependency[]
  default_skills: string[]
  custom_tools: CustomTool[]
  required_secrets: string[]
  source_url?: string
  run_command?: string
  default_models?: Record<string, string>
  timeout_seconds?: number
  max_turns?: number
}

type FieldDiff = {
  field: string
  kind: 'changed' | 'added' | 'removed'
  old?: unknown
  new?: unknown
}

// ── Helpers ────────────────────────────────────────────────────

function extractDependencies(
  manifest: Record<string, unknown> | undefined
): ManifestDependency[] {
  if (!manifest) return []
  const deps = manifest.dependencies as Array<{ id?: string; version?: string }> | undefined
  if (!Array.isArray(deps)) return []
  return deps
    .filter(d => d && typeof d.id === 'string' && typeof d.version === 'string')
    .map(d => ({ id: d.id!, version: d.version! }))
}

function extractCustomTools(
  manifest: Record<string, unknown> | undefined
): CustomTool[] {
  if (!manifest) return []
  const tools = manifest.custom_tools as Array<{ name?: string; description?: string; command?: string }> | undefined
  if (!Array.isArray(tools)) return []
  return tools
    .filter(t => t && typeof t.name === 'string')
    .map(t => ({ name: t.name!, description: t.description, command: t.command }))
}

/** Fetch a normalised snapshot for one agent version. */
async function fetchSnapshot(
  config: { apiKey?: string; apiUrl: string; defaultOrg?: string },
  org: string,
  agent: string,
  version: string,
  workspaceId?: string
): Promise<AgentSnapshot> {
  // Try public endpoint first
  try {
    const pub = await getPublicAgent(config, org, agent, version)
    const raw = pub as Record<string, unknown>
    const manifest = raw.manifest as Record<string, unknown> | undefined
    return {
      org,
      name: pub.name,
      version: pub.version,
      type: (pub.type || 'tool') as string,
      description: (pub.description ?? undefined) as string | undefined,
      callable: pub.callable ?? false,
      run_mode: pub.run_mode ?? null,
      execution_engine: pub.execution_engine ?? null,
      supported_providers: pub.supported_providers || ['any'],
      tags: pub.tags || [],
      input_schema: pub.input_schema as Schema | undefined,
      output_schema: pub.output_schema as Schema | undefined,
      dependencies: extractDependencies(manifest),
      default_skills: (raw.default_skills as string[] | undefined) || [],
      custom_tools: extractCustomTools(manifest),
      required_secrets: (raw.required_secrets as string[] | undefined) || [],
      source_url: raw.source_url as string | undefined,
      run_command: raw.run_command as string | undefined,
      default_models: raw.default_models as Record<string, string> | undefined,
      timeout_seconds: manifest?.timeout_seconds as number | undefined,
      max_turns: manifest?.max_turns as number | undefined,
    }
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 404) throw err
  }

  // Fallback to authenticated endpoint
  if (!config.apiKey) {
    throw new ApiError(`Agent '${org}/${agent}@${version}' not found`, 404)
  }

  const userOrg = await getOrg(config as { apiKey: string; apiUrl: string }, workspaceId)
  if (userOrg.slug !== org) {
    throw new ApiError(`Agent '${org}/${agent}@${version}' not found`, 404)
  }

  const agents = await listMyAgents(config as { apiKey: string; apiUrl: string }, workspaceId)
  const matching = agents.filter(a => a.name === agent)
  if (matching.length === 0) {
    throw new ApiError(`Agent '${org}/${agent}@${version}' not found`, 404)
  }

  let target = matching[0]
  if (version !== 'latest') {
    const found = matching.find(a => a.version === version)
    if (!found) throw new ApiError(`Agent '${org}/${agent}@${version}' not found`, 404)
    target = found
  } else {
    target = matching.sort((a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )[0]
  }

  const manifest = target.manifest as Record<string, unknown> | undefined
  return {
    org,
    name: target.name,
    version: target.version,
    type: target.type,
    description: target.description,
    callable: target.callable ?? false,
    run_mode: target.run_mode ?? null,
    execution_engine: target.execution_engine ?? null,
    supported_providers: target.supported_providers || ['any'],
    tags: target.tags || [],
    input_schema: target.input_schema as Schema | undefined,
    output_schema: target.output_schema as Schema | undefined,
    prompt: target.prompt,
    dependencies: extractDependencies(manifest),
    default_skills: target.default_skills || [],
    custom_tools: extractCustomTools(manifest),
    required_secrets: target.required_secrets || [],
    source_url: target.source_url,
    run_command: target.run_command,
    default_models: target.default_models,
    timeout_seconds: manifest?.timeout_seconds as number | undefined,
    max_turns: manifest?.max_turns as number | undefined,
  }
}

// ── Diffing ────────────────────────────────────────────────────

function isEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function isEmpty(val: unknown): boolean {
  if (val === undefined || val === null) return true
  if (Array.isArray(val)) return val.length === 0
  if (typeof val === 'object') return Object.keys(val as object).length === 0
  return false
}

/** Compare two snapshots field-by-field and return a list of diffs. */
export function computeDiffs(a: AgentSnapshot, b: AgentSnapshot): FieldDiff[] {
  const diffs: FieldDiff[] = []

  // Simple scalar fields
  const scalars: Array<{ field: string; key: keyof AgentSnapshot }> = [
    { field: 'type', key: 'type' },
    { field: 'description', key: 'description' },
    { field: 'callable', key: 'callable' },
    { field: 'run_mode', key: 'run_mode' },
    { field: 'execution_engine', key: 'execution_engine' },
    { field: 'source_url', key: 'source_url' },
    { field: 'run_command', key: 'run_command' },
    { field: 'timeout_seconds', key: 'timeout_seconds' },
    { field: 'max_turns', key: 'max_turns' },
  ]

  for (const { field, key } of scalars) {
    const oldVal = a[key]
    const newVal = b[key]
    if (!isEqual(oldVal, newVal)) {
      if (isEmpty(oldVal) && !isEmpty(newVal)) {
        diffs.push({ field, kind: 'added', new: newVal })
      } else if (!isEmpty(oldVal) && isEmpty(newVal)) {
        diffs.push({ field, kind: 'removed', old: oldVal })
      } else {
        diffs.push({ field, kind: 'changed', old: oldVal, new: newVal })
      }
    }
  }

  // Array fields — show as changed with old/new
  const arrays: Array<{ field: string; key: keyof AgentSnapshot }> = [
    { field: 'supported_providers', key: 'supported_providers' },
    { field: 'tags', key: 'tags' },
    { field: 'default_skills', key: 'default_skills' },
    { field: 'required_secrets', key: 'required_secrets' },
  ]

  for (const { field, key } of arrays) {
    const oldArr = (a[key] || []) as unknown[]
    const newArr = (b[key] || []) as unknown[]
    if (!isEqual(oldArr, newArr)) {
      if (oldArr.length === 0 && newArr.length > 0) {
        diffs.push({ field, kind: 'added', new: newArr })
      } else if (oldArr.length > 0 && newArr.length === 0) {
        diffs.push({ field, kind: 'removed', old: oldArr })
      } else {
        diffs.push({ field, kind: 'changed', old: oldArr, new: newArr })
      }
    }
  }

  // Object fields — schemas, default_models
  const objects: Array<{ field: string; key: keyof AgentSnapshot }> = [
    { field: 'input_schema', key: 'input_schema' },
    { field: 'output_schema', key: 'output_schema' },
    { field: 'default_models', key: 'default_models' },
  ]

  for (const { field, key } of objects) {
    const oldObj = a[key]
    const newObj = b[key]
    if (!isEqual(oldObj, newObj)) {
      if (isEmpty(oldObj) && !isEmpty(newObj)) {
        diffs.push({ field, kind: 'added', new: newObj })
      } else if (!isEmpty(oldObj) && isEmpty(newObj)) {
        diffs.push({ field, kind: 'removed', old: oldObj })
      } else {
        diffs.push({ field, kind: 'changed', old: oldObj, new: newObj })
      }
    }
  }

  // Structured arrays — dependencies, custom_tools
  if (!isEqual(a.dependencies, b.dependencies)) {
    if (a.dependencies.length === 0 && b.dependencies.length > 0) {
      diffs.push({ field: 'dependencies', kind: 'added', new: b.dependencies })
    } else if (a.dependencies.length > 0 && b.dependencies.length === 0) {
      diffs.push({ field: 'dependencies', kind: 'removed', old: a.dependencies })
    } else {
      diffs.push({ field: 'dependencies', kind: 'changed', old: a.dependencies, new: b.dependencies })
    }
  }

  if (!isEqual(a.custom_tools, b.custom_tools)) {
    if (a.custom_tools.length === 0 && b.custom_tools.length > 0) {
      diffs.push({ field: 'custom_tools', kind: 'added', new: b.custom_tools })
    } else if (a.custom_tools.length > 0 && b.custom_tools.length === 0) {
      diffs.push({ field: 'custom_tools', kind: 'removed', old: a.custom_tools })
    } else {
      diffs.push({ field: 'custom_tools', kind: 'changed', old: a.custom_tools, new: b.custom_tools })
    }
  }

  // Prompt (may only be available for owned agents)
  if (a.prompt !== undefined && b.prompt !== undefined && a.prompt !== b.prompt) {
    diffs.push({ field: 'prompt', kind: 'changed', old: a.prompt, new: b.prompt })
  } else if (a.prompt === undefined && b.prompt !== undefined) {
    diffs.push({ field: 'prompt', kind: 'added', new: b.prompt })
  } else if (a.prompt !== undefined && b.prompt === undefined) {
    diffs.push({ field: 'prompt', kind: 'removed', old: a.prompt })
  }

  return diffs
}

// ── Formatting ─────────────────────────────────────────────────

function formatValue(val: unknown): string {
  if (val === undefined || val === null) return chalk.gray('(none)')
  if (typeof val === 'boolean') return val ? chalk.green('true') : chalk.red('false')
  if (typeof val === 'string') {
    if (val.length > 120) return val.slice(0, 117) + '...'
    return val
  }
  if (Array.isArray(val)) {
    if (val.length === 0) return chalk.gray('[]')
    // Array of strings
    if (typeof val[0] === 'string') return val.join(', ')
    // Array of objects — compact JSON
    return JSON.stringify(val, null, 2)
  }
  if (typeof val === 'object') return JSON.stringify(val, null, 2)
  return String(val)
}

function formatPromptDiff(oldPrompt: string | undefined, newPrompt: string | undefined): string {
  const oldLines = (oldPrompt || '').split('\n')
  const newLines = (newPrompt || '').split('\n')
  const lines: string[] = []

  // Simple line-by-line diff (not LCS — good enough for prompt comparison)
  const maxLines = Math.max(oldLines.length, newLines.length)
  const oldSet = new Set(oldLines)
  const newSet = new Set(newLines)

  for (const line of oldLines) {
    if (!newSet.has(line)) {
      lines.push(chalk.red(`  - ${line}`))
    }
  }
  for (const line of newLines) {
    if (!oldSet.has(line)) {
      lines.push(chalk.green(`  + ${line}`))
    }
  }

  if (lines.length === 0) {
    // Lines are the same but order changed
    lines.push(chalk.yellow('  (line order changed)'))
  }

  // Truncate if very large
  if (lines.length > 40) {
    const shown = lines.slice(0, 40)
    shown.push(chalk.gray(`  ... and ${lines.length - 40} more lines`))
    return shown.join('\n')
  }

  return lines.join('\n')
}

function formatSchemaDiff(field: string, oldSchema: Schema | undefined, newSchema: Schema | undefined): string {
  const lines: string[] = []
  const oldProps = oldSchema?.properties || {}
  const newProps = newSchema?.properties || {}
  const oldRequired = new Set(oldSchema?.required || [])
  const newRequired = new Set(newSchema?.required || [])
  const allKeys = new Set([...Object.keys(oldProps), ...Object.keys(newProps)])

  for (const key of allKeys) {
    const inOld = key in oldProps
    const inNew = key in newProps
    if (!inOld && inNew) {
      const reqMark = newRequired.has(key) ? '' : '?'
      lines.push(chalk.green(`  + ${key}${reqMark}: ${newProps[key].type || 'any'}`))
    } else if (inOld && !inNew) {
      const reqMark = oldRequired.has(key) ? '' : '?'
      lines.push(chalk.red(`  - ${key}${reqMark}: ${oldProps[key].type || 'any'}`))
    } else if (inOld && inNew) {
      const oldType = oldProps[key].type || 'any'
      const newType = newProps[key].type || 'any'
      const wasReq = oldRequired.has(key)
      const isReq = newRequired.has(key)
      if (oldType !== newType || wasReq !== isReq) {
        const oldMark = wasReq ? '' : '?'
        const newMark = isReq ? '' : '?'
        lines.push(chalk.red(`  - ${key}${oldMark}: ${oldType}`))
        lines.push(chalk.green(`  + ${key}${newMark}: ${newType}`))
      }
    }
  }

  return lines.join('\n')
}

function printDiffs(
  refA: string,
  refB: string,
  diffs: FieldDiff[]
): void {
  process.stdout.write('\n')
  process.stdout.write(chalk.bold(`${refA}  ${chalk.yellow('→')}  ${refB}`) + '\n')
  process.stdout.write('='.repeat(50) + '\n\n')

  if (diffs.length === 0) {
    process.stdout.write(chalk.green('No differences found.') + '\n')
    return
  }

  process.stdout.write(`${chalk.bold(String(diffs.length))} ${diffs.length === 1 ? 'change' : 'changes'}:\n\n`)

  for (const diff of diffs) {
    // Schema fields get special formatting
    if ((diff.field === 'input_schema' || diff.field === 'output_schema') && diff.kind === 'changed') {
      process.stdout.write(chalk.cyan(`~ ${diff.field}:`) + '\n')
      process.stdout.write(formatSchemaDiff(diff.field, diff.old as Schema, diff.new as Schema) + '\n\n')
      continue
    }

    // Prompt gets special formatting
    if (diff.field === 'prompt' && diff.kind === 'changed') {
      process.stdout.write(chalk.cyan(`~ prompt:`) + '\n')
      process.stdout.write(formatPromptDiff(diff.old as string, diff.new as string) + '\n\n')
      continue
    }

    // Standard fields
    const prefix = diff.kind === 'added' ? chalk.green('+')
      : diff.kind === 'removed' ? chalk.red('-')
      : chalk.cyan('~')

    if (diff.kind === 'added') {
      process.stdout.write(`${prefix} ${chalk.bold(diff.field)}: ${formatValue(diff.new)}\n`)
    } else if (diff.kind === 'removed') {
      process.stdout.write(`${prefix} ${chalk.bold(diff.field)}: ${formatValue(diff.old)}\n`)
    } else {
      process.stdout.write(`${prefix} ${chalk.bold(diff.field)}: ${formatValue(diff.old)} ${chalk.yellow('→')} ${formatValue(diff.new)}\n`)
    }
  }
}

// ── Ref parsing ────────────────────────────────────────────────

/**
 * Parse second ref which can be:
 * - Full ref: "org/agent@version"
 * - Version-only shorthand: "v2" (inherits org/agent from first ref)
 */
function parseSecondRef(value: string, firstOrg: string, firstName: string): { org: string; agent: string; version: string } {
  // If it contains '/', treat as full ref
  if (value.includes('/')) {
    return parseAgentRef(value)
  }
  // Otherwise treat as a version shorthand for the same agent
  return { org: firstOrg, agent: firstName, version: value }
}

// ── Command ────────────────────────────────────────────────────

export function registerDiffCommand(program: Command): void {
  program
    .command('diff <ref1> [ref2]')
    .description('Compare two versions of an agent')
    .option('--json', 'Output as JSON')
    .action(async (ref1Arg: string, ref2Arg: string | undefined, options: { json?: boolean }) => {
      const config = await getResolvedConfig()
      const ref1 = parseAgentRef(ref1Arg)

      let ref2: { org: string; agent: string; version: string }
      if (ref2Arg) {
        ref2 = parseSecondRef(ref2Arg, ref1.org, ref1.agent)
      } else {
        // No second ref — compare ref1 against latest
        if (ref1.version === 'latest') {
          throw new ApiError(
            'Two versions are required. Use: orch diff org/agent@v1 v2',
            400
          )
        }
        ref2 = { org: ref1.org, agent: ref1.agent, version: 'latest' }
      }

      // Resolve workspace
      const workspaceId = await resolveWorkspaceIdForOrg(config, ref1.org)

      // Fetch both versions in parallel
      const [snapA, snapB] = await withSpinner(
        'Fetching agent versions',
        () => Promise.all([
          fetchSnapshot(config, ref1.org, ref1.agent, ref1.version, workspaceId),
          fetchSnapshot(config, ref2.org, ref2.agent, ref2.version,
            ref2.org === ref1.org ? workspaceId : undefined),
        ]),
        { successText: 'Fetched both versions' }
      )

      const refALabel = `${snapA.org}/${snapA.name}@${snapA.version}`
      const refBLabel = `${snapB.org}/${snapB.name}@${snapB.version}`

      const diffs = computeDiffs(snapA, snapB)

      if (options.json) {
        process.stdout.write(JSON.stringify({
          from: refALabel,
          to: refBLabel,
          identical: diffs.length === 0,
          changes: diffs,
        }, null, 2) + '\n')
        return
      }

      printDiffs(refALabel, refBLabel, diffs)
    })
}
