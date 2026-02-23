import { Command } from 'commander'

import { getResolvedConfig, loadConfig } from '../lib/config'
import { ApiError, getOrg, listMyAgents, getPublicAgent, resolveWorkspaceIdForOrg } from '../lib/api'
import { parseAgentRef } from '../lib/agent-ref'
import { CliError } from '../lib/errors'
import { withSpinner } from '../lib/spinner'
import { printDiffs } from './diff-format'

// ── Types ──────────────────────────────────────────────────────

export type SchemaProperty = {
  type?: string
  description?: string
  items?: { type?: string }
}

export type Schema = {
  type?: string
  properties?: Record<string, SchemaProperty>
  required?: string[]
}

export type ManifestDependency = {
  id: string
  version: string
}

export type CustomTool = {
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

export type FieldDiff = {
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

// ── Ref parsing ────────────────────────────────────────────────

/**
 * Parse second ref which can be:
 * - Full ref: "org/agent@version"
 * - Version-only shorthand: "v2" (inherits org/agent from first ref)
 */
function parseSecondRef(value: string, firstOrg: string, firstName: string): { org: string; agent: string; version: string } {
  // If it contains '/', treat as full ref
  if (value.includes('/')) {
    const parsed = parseAgentRef(value)
    return { org: parsed.org ?? firstOrg, agent: parsed.agent, version: parsed.version }
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
      const ref1Raw = parseAgentRef(ref1Arg)
      const configFile = await loadConfig()
      const ref1Org = ref1Raw.org ?? configFile.workspace ?? config.defaultOrg
      if (!ref1Org) {
        throw new CliError('Missing org. Use org/agent format or set default org.')
      }
      const ref1 = { org: ref1Org, agent: ref1Raw.agent, version: ref1Raw.version }

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
