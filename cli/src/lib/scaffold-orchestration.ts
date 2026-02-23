export interface OrchestrationDependency {
  org: string
  name: string
  version: string
  description?: string | null
  inputSchema?: unknown
}

export interface OrchestrationCustomTool {
  name: string
  description: string
  input_schema: object
  command: string
}

export interface DependencyVersionConflict {
  id: string
  versions: string[]
}

export interface DedupeDependenciesResult {
  dependencies: OrchestrationDependency[]
  duplicates: string[]
  conflicts: DependencyVersionConflict[]
}

const BUILTIN_TOOL_NAMES = new Set([
  'bash',
  'read_file',
  'write_file',
  'list_files',
  'submit_result',
])

const DEFAULT_MAX_TURNS = 25
const DEFAULT_TIMEOUT_MS = 180000
const DEFAULT_PER_CALL_DOWNSTREAM_CAP = 50

function dependencyId(dep: OrchestrationDependency): string {
  return `${dep.org}/${dep.name}`
}

export function dependencyRef(dep: OrchestrationDependency): string {
  return `${dependencyId(dep)}@${dep.version}`
}

function sanitizeToolToken(value: string): string {
  const token = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return token || 'dependency'
}

function defaultToolInputSchema(): object {
  return {
    type: 'object',
    description: 'JSON payload forwarded to the dependency agent',
    additionalProperties: true,
  }
}

function normalizeToolInputSchema(inputSchema: unknown): object {
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    return defaultToolInputSchema()
  }
  return inputSchema as object
}

function summarizeDependencyDescription(dep: OrchestrationDependency): string {
  const prefix = `Call ${dependencyRef(dep)}`
  const raw = dep.description?.trim()
  if (!raw) return prefix
  const compact = raw.replace(/\s+/g, ' ')
  if (compact.length <= 140) return `${prefix}: ${compact}`
  return `${prefix}: ${compact.slice(0, 137)}...`
}

function nextUniqueToolName(
  dep: OrchestrationDependency,
  usedNames: Set<string>
): string {
  const candidates = [
    `call_${sanitizeToolToken(dep.name)}`,
    `call_${sanitizeToolToken(dep.org)}_${sanitizeToolToken(dep.name)}`,
  ]

  for (const candidate of candidates) {
    if (!usedNames.has(candidate) && !BUILTIN_TOOL_NAMES.has(candidate)) {
      usedNames.add(candidate)
      return candidate
    }
  }

  let suffix = 2
  const stablePrefix = `call_${sanitizeToolToken(dep.org)}_${sanitizeToolToken(dep.name)}`
  while (true) {
    const candidate = `${stablePrefix}_${suffix}`
    if (!usedNames.has(candidate) && !BUILTIN_TOOL_NAMES.has(candidate)) {
      usedNames.add(candidate)
      return candidate
    }
    suffix += 1
  }
}

function defaultMaxHops(depCount: number): number {
  return Math.max(2, Math.min(8, depCount + 1))
}

export function validateScaffoldAgentName(name: string): string[] {
  const errors: string[] = []
  const trimmed = name.trim()
  const nameRegex = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/

  if (trimmed.length < 2 || trimmed.length > 50) {
    errors.push('Agent name must be 2-50 characters')
  }
  if (trimmed !== trimmed.toLowerCase()) {
    errors.push('Agent name must be lowercase')
  }
  if (trimmed.length > 1 && !nameRegex.test(trimmed)) {
    errors.push(
      'Agent name must contain only lowercase letters, numbers, and hyphens, and must start/end with a letter or number'
    )
  }
  if (trimmed.includes('--')) {
    errors.push('Agent name must not contain consecutive hyphens')
  }
  return errors
}

export function dedupeOrchestrationDependencies(
  dependencies: OrchestrationDependency[]
): DedupeDependenciesResult {
  const deduped: OrchestrationDependency[] = []
  const duplicates: string[] = []
  const byId = new Map<string, OrchestrationDependency>()
  const versionsById = new Map<string, Set<string>>()

  for (const dep of dependencies) {
    const id = dependencyId(dep)
    const existing = byId.get(id)

    if (!existing) {
      byId.set(id, dep)
      deduped.push(dep)
      versionsById.set(id, new Set([dep.version]))
      continue
    }

    versionsById.get(id)?.add(dep.version)
    if (existing.version === dep.version) {
      duplicates.push(dependencyRef(dep))
    }
  }

  const conflicts: DependencyVersionConflict[] = []
  for (const [id, versions] of versionsById.entries()) {
    if (versions.size > 1) {
      conflicts.push({ id, versions: [...versions].sort() })
    }
  }

  return { dependencies: deduped, duplicates, conflicts }
}

export function buildOrchestrationCustomTools(
  dependencies: OrchestrationDependency[]
): OrchestrationCustomTool[] {
  const usedNames = new Set<string>()
  return dependencies.map((dep) => {
    return {
      name: nextUniqueToolName(dep, usedNames),
      description: summarizeDependencyDescription(dep),
      input_schema: normalizeToolInputSchema(dep.inputSchema),
      command: `python3 /home/user/helpers/orch_call.py ${dependencyRef(dep)}`,
    }
  })
}

export function buildOrchestrationManifest(args: {
  name: string
  dependencies: OrchestrationDependency[]
  customTools: OrchestrationCustomTool[]
  maxTurns?: number
  timeoutMs?: number
  maxHops?: number
  perCallDownstreamCap?: number
}): Record<string, unknown> {
  const maxTurns = args.maxTurns ?? DEFAULT_MAX_TURNS
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxHops = args.maxHops ?? defaultMaxHops(args.dependencies.length)
  const perCallDownstreamCap = args.perCallDownstreamCap ?? DEFAULT_PER_CALL_DOWNSTREAM_CAP

  return {
    name: args.name,
    type: 'agent',
    description: `Managed-loop orchestrator that coordinates ${args.dependencies.length} dependency agents`,
    run_mode: 'on_demand',
    tags: ['orchestration'],
    supported_providers: ['any'],
    required_secrets: [],
    max_turns: maxTurns,
    custom_tools: args.customTools,
    // Keep loop in sync with top-level compatibility fields for local + cloud parity.
    loop: {
      max_turns: maxTurns,
      custom_tools: args.customTools,
    },
    manifest: {
      manifest_version: 1,
      dependencies: args.dependencies.map((dep) => ({
        id: `${dep.org}/${dep.name}`,
        version: dep.version,
      })),
      max_hops: maxHops,
      timeout_ms: timeoutMs,
      per_call_downstream_cap: perCallDownstreamCap,
    },
  }
}

export function buildOrchestrationPrompt(args: {
  name: string
  dependencies: OrchestrationDependency[]
  customTools: OrchestrationCustomTool[]
}): string {
  const toolLines = args.customTools.map((tool, idx) => {
    const dep = args.dependencies[idx]
    const description = dep.description?.trim() ? ` — ${dep.description.trim()}` : ''
    return `- \`${tool.name}\` -> \`${dependencyRef(dep)}\`${description}`
  })

  return [
    `You are ${args.name}, an orchestration agent that delegates work to specialist dependency agents.`,
    '',
    'Primary objective:',
    '- Use the dependency tools to solve the incoming task with accurate, well-structured results.',
    '',
    'Available dependency tools:',
    ...toolLines,
    '',
    'Operating rules:',
    '1. Prefer the dependency tools over ad-hoc bash implementations when a dependency can handle the task.',
    '2. Pass only relevant fields to each tool call; do not invent required fields.',
    '3. Chain tool calls when needed and reconcile conflicting outputs before finalizing.',
    '4. If a dependency fails, retry once with corrected input; if still failing, return a clear partial result with the failure reason.',
    '5. Always finish by calling submit_result with output that matches schema.json.',
    '',
    'Input template:',
    '- `{{task}}`: the user task you must complete.',
    '',
    'Use concise, factual language in the final response.',
    '',
  ].join('\n')
}

export function buildOrchestrationSchema(): Record<string, object> {
  return {
    input: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Task to delegate across dependency agents',
        },
        context: {
          type: 'object',
          description: 'Optional context payload forwarded to dependency tools as needed',
          additionalProperties: true,
        },
      },
      required: ['task'],
    },
    output: {
      type: 'object',
      properties: {
        result: {
          type: 'string',
          description: 'Final synthesized answer for the task',
        },
        used_tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Dependency tool names used to produce the result',
        },
        notes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Warnings, fallbacks, or caveats encountered during orchestration',
        },
      },
      required: ['result', 'used_tools'],
    },
  }
}
