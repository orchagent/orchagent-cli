import { Command } from 'commander'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { spawn } from 'child_process'

import chalk from 'chalk'
import { loadDotEnv } from '../lib/dotenv'
import { getResolvedConfig, loadConfig, getDefaultProvider } from '../lib/config'
import {
  getPublicAgent,
  publicRequest,
  downloadCodeBundle,
  ApiError,
  getOrg,
  listMyAgents,
  downloadCodeBundleAuthenticated,
  request,
  getAgentWithFallback,
  safeFetchWithRetryForCalls,
  getCreditsBalance,
  resolveWorkspaceIdForOrg,
} from '../lib/api'
import { CliError, jsonInputError, ExitCodes } from '../lib/errors'
import { printJson } from '../lib/output'
import { createSpinner, withSpinner } from '../lib/spinner'
import {
  detectLlmKey,
  getDefaultModel,
  buildPrompt,
  callLlm,
  callLlmWithFallback,
  validateProvider,
  type LlmProvider,
  type ProviderConfig,
  PROVIDER_ENV_VARS,
} from '../lib/llm'
import { track } from '../lib/analytics'
import { isPaidAgent, formatPrice } from '../lib/pricing'
import packageJson from '../../package.json'
import type { ResolvedConfig, PublicAgent, Agent } from '../types'

const DEFAULT_VERSION = 'latest'
const AGENTS_DIR = path.join(os.homedir(), '.orchagent', 'agents')

// Local execution environment variables
const LOCAL_EXECUTION_ENV = 'ORCHAGENT_LOCAL_EXECUTION'
const AGENTS_DIR_ENV = 'ORCHAGENT_AGENTS_DIR'
const CALL_CHAIN_ENV = 'ORCHAGENT_CALL_CHAIN'
const DEADLINE_MS_ENV = 'ORCHAGENT_DEADLINE_MS'
const MAX_HOPS_ENV = 'ORCHAGENT_MAX_HOPS'
const DOWNSTREAM_REMAINING_ENV = 'ORCHAGENT_DOWNSTREAM_REMAINING'

// Well-known field names for file content in prompt agent schemas (priority order)
const CONTENT_FIELD_NAMES = ['code', 'content', 'text', 'source', 'input', 'file_content', 'body']

// Keys that might indicate local file path references in JSON payloads
const LOCAL_PATH_KEYS = ['path', 'directory', 'file', 'filepath', 'dir', 'folder', 'local']

type AgentRef = {
  org?: string
  agent: string
  version: string
}

function parseAgentRef(value: string): AgentRef {
  const [ref, versionPart] = value.split('@')
  const version = versionPart?.trim() || DEFAULT_VERSION
  const segments = ref.split('/')
  if (segments.length === 1) {
    return { agent: segments[0], version }
  }
  if (segments.length === 2) {
    return { org: segments[0], agent: segments[1], version }
  }
  throw new CliError('Invalid agent reference. Use org/agent or agent format.')
}

type AgentDependency = {
  id: string      // org/agent format
  version: string // e.g., "v1"
}

type AgentDownload = {
  id?: string              // Agent ID (for private agents)
  type: 'agent' | 'skill' | 'prompt' | 'tool' | 'agentic' | 'code'
  run_mode?: 'on_demand' | 'always_on' | null
  execution_engine?: 'direct_llm' | 'managed_loop' | 'code_runtime' | null
  callable?: boolean
  name: string
  version: string
  description?: string
  prompt?: string
  input_schema?: object
  output_schema?: object
  supported_providers: string[]
  default_models?: Record<string, string>
  // For tool agents - local execution
  source_url?: string      // Git URL to pip install from
  pip_package?: string     // PyPI package name
  run_command?: string     // Command to run (e.g., "python -m leak_finder.cli")
  url?: string             // Cloud Run URL (for remote execution)
  files?: Array<{ path: string; content: string }>
  // Bundle-based local execution
  has_bundle?: boolean     // Whether the agent has a bundle available
  entrypoint?: string      // Entry point file (e.g., "sandbox_main.py")
  // Dependencies (for orchestrator agents)
  dependencies?: AgentDependency[]
}

function canonicalAgentType(typeValue: AgentDownload['type'] | string | undefined): 'agent' | 'skill' {
  const normalized = (typeValue || 'agent').toLowerCase()
  return normalized === 'skill' ? 'skill' : 'agent'
}

function resolveExecutionEngine(agentData: {
  type?: string
  execution_engine?: string | null
  runtime?: { command?: string } | null
  loop?: Record<string, unknown> | null
}): 'direct_llm' | 'managed_loop' | 'code_runtime' {
  if (agentData.execution_engine === 'direct_llm' || agentData.execution_engine === 'managed_loop' || agentData.execution_engine === 'code_runtime') {
    return agentData.execution_engine
  }
  const runtimeCommand = agentData.runtime?.command
  if (runtimeCommand && runtimeCommand.trim()) return 'code_runtime'
  if (agentData.loop && Object.keys(agentData.loop).length > 0) return 'managed_loop'

  const normalized = (agentData.type || '').toLowerCase()
  if (normalized === 'tool' || normalized === 'code') return 'code_runtime'
  if (normalized === 'agentic') return 'managed_loop'
  if (normalized === 'skill') return 'direct_llm'
  return 'direct_llm'
}

// ─── Validation helpers ─────────────────────────────────────────────────────

async function validateFilePath(filePath: string): Promise<void> {
  const stat = await fs.stat(filePath)
  if (stat.isDirectory()) {
    throw new CliError(
      `Cannot upload a directory for cloud execution: ${filePath}\n\n` +
      `Options:\n` +
      `  Use --local to run locally with filesystem access:\n` +
      `    orch run <agent> --local --path ${filePath}\n` +
      `  Or specify individual files:\n` +
      `    orch run <agent> --file ${filePath}/specific-file.ts`
    )
  }
}

// ─── Cloud execution helpers (from call.ts) ─────────────────────────────────

function findLocalPathKey(obj: unknown): string | undefined {
  if (typeof obj !== 'object' || obj === null) {
    return undefined
  }
  const keys = Object.keys(obj as Record<string, unknown>)
  for (const key of keys) {
    if (LOCAL_PATH_KEYS.includes(key.toLowerCase())) {
      return key
    }
  }
  return undefined
}

function warnIfLocalPathReference(jsonBody: string): void {
  try {
    const parsed = JSON.parse(jsonBody)
    const pathKey = findLocalPathKey(parsed)
    if (pathKey) {
      process.stderr.write(
        `Warning: Your payload contains a local path reference ('${pathKey}').\n` +
        `Remote agents cannot access your local filesystem. The path will be interpreted\n` +
        `by the server, not your local machine.\n\n` +
        `Tip: Use 'orchagent run <agent> --local' to execute locally with filesystem access.\n\n`
      )
    }
  } catch {
    // If parsing fails, skip the warning
  }
}

function inferFileField(inputSchema?: object): string {
  if (!inputSchema || typeof inputSchema !== 'object') return 'content'
  const props = (inputSchema as Record<string, unknown>).properties
  if (!props || typeof props !== 'object') return 'content'

  const properties = props as Record<string, { type?: string }>

  for (const field of CONTENT_FIELD_NAMES) {
    if (properties[field] && properties[field].type === 'string') return field
  }

  const required = ((inputSchema as Record<string, unknown>).required ?? []) as string[]
  const stringProps = Object.entries(properties)
    .filter(([, v]) => v.type === 'string')
    .map(([k]) => k)

  if (stringProps.length === 1) return stringProps[0]

  const requiredStrings = stringProps.filter(k => required.includes(k))
  if (requiredStrings.length === 1) return requiredStrings[0]

  return 'content'
}

function applySchemaDefaults(
  body: Record<string, unknown>,
  schema?: object
): Record<string, unknown> {
  if (!schema) return body
  const props = (schema as Record<string, unknown>).properties
  if (!props || typeof props !== 'object') return body
  for (const [key, def] of Object.entries(props as Record<string, Record<string, unknown>>)) {
    if (body[key] === undefined && def.default !== undefined) {
      body[key] = def.default
    }
  }
  return body
}

async function readStdin(): Promise<Buffer | null> {
  if (process.stdin.isTTY) return null
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk))
  }
  if (!chunks.length) return null
  return Buffer.concat(chunks)
}

async function buildMultipartBody(
  filePaths: string[] | undefined,
  metadata?: string
): Promise<{ body?: FormData; sourceLabel?: string }> {
  if (!filePaths || filePaths.length === 0) {
    const stdinData = await readStdin()
    if (stdinData) {
      const form = new FormData()
      form.append('files[]', new Blob([new Uint8Array(stdinData)]), 'stdin')
      if (metadata) {
        form.append('metadata', metadata)
      }
      return { body: form, sourceLabel: 'stdin' }
    }
    if (metadata) {
      const form = new FormData()
      form.append('metadata', metadata)
      return { body: form, sourceLabel: 'metadata' }
    }
    return {}
  }

  const form = new FormData()
  for (const filePath of filePaths) {
    await validateFilePath(filePath)
    const buffer = await fs.readFile(filePath)
    const filename = path.basename(filePath)
    form.append('files[]', new Blob([new Uint8Array(buffer)]), filename)
  }

  if (metadata) {
    form.append('metadata', metadata)
  }

  return {
    body: form,
    sourceLabel: filePaths.length === 1 ? filePaths[0] : `${filePaths.length} files`,
  }
}

async function resolveJsonBody(input: string): Promise<string> {
  let raw = input
  if (input.startsWith('@')) {
    const source = input.slice(1)
    if (!source) {
      throw new CliError('Invalid JSON input. Use a JSON string or @file.')
    }
    if (source === '-') {
      const stdinData = await readStdin()
      if (!stdinData) {
        throw new CliError('No stdin provided for JSON input.')
      }
      raw = stdinData.toString('utf8')
    } else {
      await validateFilePath(source)
      raw = await fs.readFile(source, 'utf8')
    }
  }

  try {
    return JSON.stringify(JSON.parse(raw))
  } catch {
    throw jsonInputError('data')
  }
}

// ─── Keyed file & mount helpers ──────────────────────────────────────────────

const KEYED_FILE_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

export function isKeyedFileArg(arg: string): { key: string; filePath: string } | null {
  const eqIndex = arg.indexOf('=')
  if (eqIndex <= 0) return null
  const key = arg.slice(0, eqIndex)
  const filePath = arg.slice(eqIndex + 1)
  if (!KEYED_FILE_KEY_RE.test(key)) return null
  if (!filePath) return null
  return { key, filePath }
}

export async function readKeyedFiles(args: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const arg of args) {
    const parsed = isKeyedFileArg(arg)
    if (!parsed) continue
    const resolved = path.resolve(parsed.filePath)
    let stat: Awaited<ReturnType<typeof fs.stat>>
    try {
      stat = await fs.stat(resolved)
    } catch {
      throw new CliError(`File not found: ${parsed.filePath}`)
    }
    if (!stat.isFile()) {
      throw new CliError(`Not a file: ${parsed.filePath}`)
    }
    result[parsed.key] = await fs.readFile(resolved, 'utf-8')
  }
  return result
}

const MOUNT_SKIP_DIRS = new Set([
  'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build',
  '.next', 'target', '.cache', '.tox', 'coverage', '__snapshots__',
])
const MOUNT_MAX_DEPTH = 15
const MOUNT_MAX_FILES = 500

export async function mountDirectory(dirPath: string): Promise<Record<string, string>> {
  const resolved = path.resolve(dirPath)
  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(resolved)
  } catch {
    throw new CliError(`Directory not found: ${dirPath}`)
  }
  if (!stat.isDirectory()) {
    throw new CliError(`Not a directory: ${dirPath}`)
  }

  const result: Record<string, string> = {}
  let fileCount = 0

  async function walk(currentPath: string, relativePath: string, depth: number): Promise<void> {
    if (depth > MOUNT_MAX_DEPTH) return

    let names: string[]
    try {
      names = await fs.readdir(currentPath)
    } catch {
      return
    }

    for (const name of names) {
      if (name.startsWith('.')) continue
      if (MOUNT_SKIP_DIRS.has(name)) continue

      const fullPath = path.join(currentPath, name)
      const relPath = relativePath ? `${relativePath}/${name}` : name

      // Stat the entry (also skips symlinks)
      let entryStat: Awaited<ReturnType<typeof fs.lstat>>
      try {
        entryStat = await fs.lstat(fullPath)
        if (entryStat.isSymbolicLink()) continue
      } catch {
        continue
      }

      if (entryStat.isDirectory()) {
        await walk(fullPath, relPath, depth + 1)
      } else if (entryStat.isFile()) {
        if (fileCount >= MOUNT_MAX_FILES) {
          throw new CliError(
            `Mount exceeds ${MOUNT_MAX_FILES} files. Use a more specific path or fewer files.`
          )
        }
        try {
          const content = await fs.readFile(fullPath, 'utf-8')
          result[relPath] = content
          fileCount++
        } catch {
          // Skip binary/unreadable files silently
        }
      }
    }
  }

  await walk(resolved, '', 0)
  return result
}

const INJECT_MAX_BYTES = 4 * 1024 * 1024 // 4MB

type BuildInjectedPayloadOptions = {
  dataOption?: string
  fileArgs?: string[]
  mountArgs?: string[]
  llmCredentials?: { api_key: string; provider: string; model?: string }
}

export async function buildInjectedPayload(
  options: BuildInjectedPayloadOptions
): Promise<{ body: string; sourceLabel: string }> {
  let merged: Record<string, unknown> = {}

  // 1. Start with --data
  if (options.dataOption) {
    const resolved = await resolveJsonBody(options.dataOption)
    merged = JSON.parse(resolved)
  }

  let totalBytes = 0

  // 2. Overlay keyed --file entries
  if (options.fileArgs && options.fileArgs.length > 0) {
    const keyedFiles = await readKeyedFiles(options.fileArgs)
    for (const [key, content] of Object.entries(keyedFiles)) {
      totalBytes += Buffer.byteLength(content, 'utf-8')
      merged[key] = content
    }
  }

  // 3. Overlay --mount entries
  if (options.mountArgs && options.mountArgs.length > 0) {
    for (const mountArg of options.mountArgs) {
      const eqIndex = mountArg.indexOf('=')
      if (eqIndex <= 0) {
        throw new CliError(`Invalid --mount format: ${mountArg}. Use --mount field=dir`)
      }
      const field = mountArg.slice(0, eqIndex)
      const dirPath = mountArg.slice(eqIndex + 1)
      if (!KEYED_FILE_KEY_RE.test(field)) {
        throw new CliError(`Invalid mount field name: ${field}. Must be a valid identifier.`)
      }
      const fileMap = await mountDirectory(dirPath)
      for (const content of Object.values(fileMap)) {
        totalBytes += Buffer.byteLength(content, 'utf-8')
      }
      merged[field] = fileMap
    }
  }

  // 4. Enforce size limit
  if (totalBytes > INJECT_MAX_BYTES) {
    throw new CliError(
      `File content exceeds 4MB limit (${(totalBytes / 1024 / 1024).toFixed(1)}MB). ` +
      `Use a more specific path or fewer files.`
    )
  }

  // 5. Inject llm_credentials
  if (options.llmCredentials) {
    merged.llm_credentials = options.llmCredentials
  }

  const parts: string[] = []
  if (options.fileArgs && options.fileArgs.length > 0) {
    parts.push(`${options.fileArgs.length} file(s)`)
  }
  if (options.mountArgs && options.mountArgs.length > 0) {
    parts.push(`${options.mountArgs.length} mount(s)`)
  }
  const sourceLabel = parts.join(' + ')

  return { body: JSON.stringify(merged), sourceLabel }
}

// ─── Local execution helpers ────────────────────────────────────────────────

async function downloadAgent(
  config: ResolvedConfig,
  org: string,
  agent: string,
  version: string,
  workspaceId?: string
): Promise<AgentDownload> {
  // Try public endpoint first
  try {
    return await publicRequest<AgentDownload>(
      config,
      `/public/agents/${org}/${agent}/${version}/download`
    )
  } catch (err) {
    // Check for paid-agent or download-disabled error
    if (err instanceof ApiError && err.status === 403) {
      const payload = err.payload as any
      const errorCode = payload?.error?.code
      if (errorCode === 'PAID_AGENT_SERVER_ONLY' || errorCode === 'DOWNLOAD_DISABLED') {
        // Try owner path if authenticated
        if (config.apiKey) {
          try {
            const myAgents = await listMyAgents(config, workspaceId)
            const matchingAgent = myAgents.find(
              a => a.name === agent && a.version === version && a.org_slug === org
            )
            if (matchingAgent) {
              // Owner! Fetch from authenticated endpoint
              const agentData = await request<Agent>(config, 'GET', `/agents/${matchingAgent.id}`)
              return {
                id: agentData.id,
                type: agentData.type,
                name: agentData.name,
                version: agentData.version,
                description: agentData.description,
                prompt: agentData.prompt,
                input_schema: agentData.input_schema,
                output_schema: agentData.output_schema,
                supported_providers: agentData.supported_providers || ['any'],
                default_models: agentData.default_models,
                source_url: agentData.source_url,
                pip_package: agentData.pip_package,
                run_command: agentData.run_command,
                url: agentData.url,
                has_bundle: !!agentData.code_bundle_url,
                entrypoint: agentData.entrypoint,
              }
            }
          } catch {
            // Not owner or other error, fall through
          }
        }

        // Non-owner - block with helpful message
        if (errorCode === 'PAID_AGENT_SERVER_ONLY') {
          const price = payload.error.price_per_call_cents || 0
          const priceStr = price ? `$${(price / 100).toFixed(2)}/call` : 'PAID'
          throw new CliError(
            `This agent is paid (${priceStr}) and runs on server only.\n\n` +
            `Run without --local: orch run ${org}/${agent}@${version} --data '{...}'`
          )
        } else {
          throw new CliError(
            `This agent is server-only and cannot be downloaded.\n\n` +
            `Run without --local: orch run ${org}/${agent}@${version} --data '{...}'`
          )
        }
      }
    }
    if (!(err instanceof ApiError) || err.status !== 404) throw err
  }

  // Fallback to authenticated endpoint for private agents
  if (!config.apiKey) {
    throw new ApiError(`Agent '${org}/${agent}@${version}' not found`, 404)
  }

  const userOrg = await getOrg(config, workspaceId)
  if (userOrg.slug !== org) {
    throw new ApiError(`Agent '${org}/${agent}@${version}' not found`, 404)
  }

  // Find agent in user's list
  const agents = await listMyAgents(config, workspaceId)
  const matching = agents.filter(a => a.name === agent)
  if (matching.length === 0) {
    throw new ApiError(`Agent '${org}/${agent}@${version}' not found`, 404)
  }

  let targetAgent = matching[0]
  if (version !== 'latest') {
    const found = matching.find(a => a.version === version)
    if (!found) {
      throw new ApiError(`Agent '${org}/${agent}@${version}' not found`, 404)
    }
    targetAgent = found
  } else {
    targetAgent = matching.sort((a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )[0]
  }

  return {
    id: targetAgent.id,
    type: targetAgent.type,
    run_mode: targetAgent.run_mode ?? null,
    execution_engine: targetAgent.execution_engine ?? null,
    callable: targetAgent.callable,
    name: targetAgent.name,
    version: targetAgent.version,
    description: targetAgent.description,
    prompt: targetAgent.prompt,
    input_schema: targetAgent.input_schema,
    output_schema: targetAgent.output_schema,
    supported_providers: targetAgent.supported_providers || ['any'],
    default_models: targetAgent.default_models,
    source_url: targetAgent.source_url,
    pip_package: targetAgent.pip_package,
    run_command: targetAgent.run_command,
    url: targetAgent.url,
    has_bundle: !!targetAgent.code_bundle_url,
    entrypoint: targetAgent.entrypoint,
  }
}

async function downloadBundleWithFallback(
  config: ResolvedConfig,
  org: string,
  agentName: string,
  version: string,
  agentId?: string
): Promise<Buffer> {
  try {
    return await downloadCodeBundle(config, org, agentName, version)
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 404) throw err
  }

  if (!config.apiKey || !agentId) {
    throw new ApiError(`Bundle for '${org}/${agentName}@${version}' not found`, 404)
  }

  return await downloadCodeBundleAuthenticated(config, agentId)
}

type DepStatus = {
  dep: AgentDependency
  downloadable: boolean
  agentData?: AgentDownload
}

async function checkDependencies(
  config: ResolvedConfig,
  dependencies: AgentDependency[]
): Promise<DepStatus[]> {
  const results: DepStatus[] = []

  for (const dep of dependencies) {
    const [org, agent] = dep.id.split('/')
    try {
      const agentData = await downloadAgent(config, org, agent, dep.version)
      const canonicalType = canonicalAgentType(agentData.type)
      const engine = resolveExecutionEngine(agentData)
      const downloadable = Boolean(
        canonicalType === 'skill' ||
        engine !== 'code_runtime' ||
        agentData.source_url ||
        agentData.pip_package ||
        agentData.has_bundle
      )
      results.push({ dep, downloadable, agentData })
    } catch {
      results.push({ dep, downloadable: false })
    }
  }

  return results
}

async function promptUserForDeps(depStatuses: DepStatus[]): Promise<'server' | 'local' | 'cancel'> {
  if (!process.stdin.isTTY) {
    process.stderr.write('Non-interactive mode: skipping dependencies (use --with-deps to include them).\n')
    return 'local'
  }

  const readline = await import('readline')
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  })

  const downloadableCount = depStatuses.filter(d => d.downloadable).length
  const cloudOnlyCount = depStatuses.length - downloadableCount

  process.stderr.write('\n⚠️  This agent has dependencies:\n')
  for (const status of depStatuses) {
    const icon = status.downloadable ? '✓' : '☁️'
    const note = status.downloadable ? '(downloadable)' : '(cloud-only)'
    process.stderr.write(`  ${icon} ${status.dep.id}@${status.dep.version} ${note}\n`)
  }
  process.stderr.write('\n')

  if (cloudOnlyCount > 0) {
    process.stderr.write(`Note: ${cloudOnlyCount} dependency(s) are cloud-only and cannot run locally.\n\n`)
  }

  process.stderr.write('Options:\n')
  process.stderr.write('  [1] Run on server (orch run) - recommended\n')
  if (downloadableCount > 0) {
    process.stderr.write(`  [2] Download ${downloadableCount} available deps, run locally\n`)
  }
  process.stderr.write('  [3] Cancel\n\n')
  process.stderr.write('Tip: Use --with-deps to skip this prompt in scripts.\n\n')

  return new Promise((resolve) => {
    rl.question('Choose [1/2/3]: ', (answer) => {
      rl.close()
      const choice = answer.trim()
      if (choice === '1') resolve('server')
      else if (choice === '2' && downloadableCount > 0) resolve('local')
      else resolve('cancel')
    })
  })
}

async function downloadSkillDependency(
  config: ResolvedConfig,
  ref: string,
  defaultOrg: string
): Promise<void> {
  const parsed = parseSkillRef(ref)
  const org = parsed.org ?? defaultOrg
  const skillData = await publicRequest<AgentDownload>(
    config,
    `/public/agents/${org}/${parsed.skill}/${parsed.version}/download`
  )
  await saveAgentLocally(org, parsed.skill, skillData)
}

async function downloadDependenciesRecursively(
  config: ResolvedConfig,
  depStatuses: DepStatus[],
  visited: Set<string> = new Set()
): Promise<void> {
  for (const status of depStatuses) {
    if (!status.downloadable || !status.agentData) continue

    const depRef = `${status.dep.id}@${status.dep.version}`
    if (visited.has(depRef)) continue
    visited.add(depRef)

    const [org, agent] = status.dep.id.split('/')

    await withSpinner(
      `Downloading dependency: ${depRef}...`,
      async () => {
        await saveAgentLocally(org, agent, status.agentData!)

        if (status.agentData!.has_bundle) {
          await saveBundleLocally(config, org, agent, status.dep.version, status.agentData!.id)
        }

        if (resolveExecutionEngine(status.agentData!) === 'code_runtime' && (status.agentData!.source_url || status.agentData!.pip_package)) {
          await installTool(status.agentData!)
        }
      },
      { successText: `Downloaded ${depRef}` }
    )

    const defaultSkills = (status.agentData as AgentDownload & { default_skills?: string[] }).default_skills || []
    for (const skillRef of defaultSkills) {
      try {
        await downloadSkillDependency(config, skillRef, org)
      } catch {
        process.stderr.write(`  Warning: Failed to download skill ${skillRef}\n`)
      }
    }

    if (status.agentData.dependencies && status.agentData.dependencies.length > 0) {
      const nestedStatuses = await checkDependencies(config, status.agentData.dependencies)
      await downloadDependenciesRecursively(config, nestedStatuses, visited)
    }
  }
}

async function detectAllLlmKeys(
  supportedProviders: LlmProvider[],
  config?: ResolvedConfig
): Promise<ProviderConfig[]> {
  const providers: ProviderConfig[] = []
  const seen = new Set<string>()

  for (const provider of supportedProviders) {
    if (provider === 'any') {
      for (const [p, envVar] of Object.entries(PROVIDER_ENV_VARS)) {
        const key = process.env[envVar]
        if (key && !seen.has(p)) {
          seen.add(p)
          providers.push({ provider: p, apiKey: key, model: getDefaultModel(p) })
        }
      }
    } else {
      const envVar = PROVIDER_ENV_VARS[provider]
      if (envVar) {
        const key = process.env[envVar]
        if (key && !seen.has(provider)) {
          seen.add(provider)
          providers.push({ provider, apiKey: key, model: getDefaultModel(provider) })
        }
      }
    }
  }

  if (config?.apiKey) {
    try {
      const { fetchLlmKeys } = await import('../lib/api')
      const serverKeys = await fetchLlmKeys(config)
      for (const serverKey of serverKeys) {
        if (!seen.has(serverKey.provider)) {
          seen.add(serverKey.provider)
          providers.push({
            provider: serverKey.provider,
            apiKey: serverKey.api_key,
            model: serverKey.model || getDefaultModel(serverKey.provider),
          })
        }
      }
    } catch {
      // Server fetch failed, continue with what we have
    }
  }

  return providers
}

async function executePromptLocally(
  agentData: AgentDownload,
  inputData: Record<string, unknown>,
  skillPrompts: string[] = [],
  config?: ResolvedConfig,
  providerOverride?: string,
  modelOverride?: string
): Promise<object> {
  if (providerOverride) {
    validateProvider(providerOverride)
  }

  const providersToCheck = providerOverride
    ? [providerOverride as LlmProvider]
    : (agentData.supported_providers as LlmProvider[])

  let basePrompt = agentData.prompt || ''
  if (skillPrompts.length > 0) {
    basePrompt = [...skillPrompts, basePrompt].join('\n\n---\n\n')
  }

  const prompt = buildPrompt(basePrompt, inputData)

  if (!providerOverride) {
    const allProviders = await detectAllLlmKeys(providersToCheck, config)

    if (allProviders.length === 0) {
      const providers = providersToCheck.join(', ')
      throw new CliError(
        `No LLM key found for: ${providers}\n` +
        `Set an environment variable (e.g., OPENAI_API_KEY), run 'orchagent keys add <provider>', or configure in web dashboard`
      )
    }

    if (modelOverride && !providerOverride && allProviders.length > 1) {
      process.stderr.write(
        `Warning: --model specified without --provider. The model '${modelOverride}' will be used for all ${allProviders.length} fallback providers, which may cause errors if the model is incompatible.\n` +
        `Consider specifying --provider to ensure correct model/provider pairing.\n\n`
      )
    }

    const providersWithModels = allProviders.map((p) => ({
      ...p,
      model: modelOverride || p.model || agentData.default_models?.[p.provider] || getDefaultModel(p.provider),
    }))

    const primary = providersWithModels[0]
    const spinnerText = providersWithModels.length > 1
      ? `Running with ${primary.provider} (${primary.model}), ${providersWithModels.length - 1} fallback(s) available...`
      : `Running with ${primary.provider} (${primary.model})...`

    return await withSpinner(
      spinnerText,
      async () => {
        if (providersWithModels.length > 1) {
          return await callLlmWithFallback(providersWithModels, prompt, agentData.output_schema)
        } else {
          return await callLlm(primary.provider, primary.apiKey, primary.model, prompt, agentData.output_schema)
        }
      },
      { successText: `Completed with ${primary.provider}` }
    )
  }

  const detected = await detectLlmKey(providersToCheck, config)

  if (!detected) {
    const providers = providersToCheck.join(', ')
    throw new CliError(
      `No LLM key found for: ${providers}\n` +
      `Set an environment variable (e.g., OPENAI_API_KEY), run 'orchagent keys add <provider>', or configure in web dashboard`
    )
  }

  const { provider, key, model: serverModel } = detected
  const model = modelOverride || serverModel || agentData.default_models?.[provider] || getDefaultModel(provider)

  return await withSpinner(
    `Running with ${provider} (${model})...`,
    async () => {
      return await callLlm(provider, key, model, prompt, agentData.output_schema)
    },
    { successText: `Completed with ${provider}` }
  )
}

// ─── Local agent-type execution ──────────────────────────────────────────────

const AGENT_RUNNER_SDK_PACKAGES: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  gemini: 'google-genai',
}

async function executeAgentLocally(
  agentDir: string,
  prompt: string,
  inputData: Record<string, unknown>,
  outputSchema?: object,
  customTools?: object[],
  manifest?: Record<string, unknown>,
  config?: ResolvedConfig,
  providerOverride?: string,
  modelOverride?: string
): Promise<void> {
  // 1. Check Python 3 available
  try {
    const { code } = await runCommand('python3', ['--version'])
    if (code !== 0) throw new Error()
  } catch {
    throw new CliError(
      'Python 3 is required for local agent execution.\n' +
      'Install Python 3: https://python.org/downloads'
    )
  }

  // 2. Detect LLM provider + key
  const supportedProviders = (manifest?.supported_providers as string[]) || ['any']
  const providersToCheck = providerOverride
    ? [providerOverride as LlmProvider]
    : supportedProviders as LlmProvider[]

  const allProviders = await detectAllLlmKeys(providersToCheck, config)
  if (allProviders.length === 0) {
    const providers = providersToCheck.join(', ')
    throw new CliError(
      `No LLM key found for: ${providers}\n` +
      `Set an environment variable (e.g., ANTHROPIC_API_KEY), run 'orchagent keys add <provider>', or configure in web dashboard`
    )
  }

  const primary = allProviders[0]
  const model = modelOverride || primary.model || getDefaultModel(primary.provider)
  const providerName = primary.provider
  const apiKeyEnvVar = PROVIDER_ENV_VARS[providerName]

  // 3. Check LLM SDK installed
  const sdkPackage = AGENT_RUNNER_SDK_PACKAGES[providerName] || 'anthropic'
  const sdkImportName = providerName === 'gemini' ? 'google.genai' : sdkPackage
  try {
    const { code } = await runCommand('python3', ['-c', `import ${sdkImportName}`])
    if (code !== 0) {
      process.stderr.write(`Installing ${sdkPackage} Python SDK...\n`)
      const install = await runCommand('python3', ['-m', 'pip', 'install', '-q', sdkPackage])
      if (install.code !== 0) {
        throw new CliError(
          `Failed to install ${sdkPackage} SDK.\n` +
          `Install manually: pip install ${sdkPackage}`
        )
      }
    }
  } catch (err) {
    if (err instanceof CliError) throw err
    throw new CliError(`Failed to check Python SDK: ${err}`)
  }

  // 4. Create temp directory with agent files
  const tempDir = path.join(os.tmpdir(), `orchagent-agent-local-${Date.now()}`)
  await fs.mkdir(tempDir, { recursive: true })

  try {
    // Copy agent_runner.py from resources
    const runnerSource = path.join(__dirname, '..', 'resources', 'agent_runner.py')
    // Also check alternate path for dev mode (running from src/)
    let runnerContent: string
    try {
      runnerContent = await fs.readFile(runnerSource, 'utf-8')
    } catch {
      // Fallback for dev: try src/resources relative to the project
      const altSource = path.join(__dirname, '..', '..', 'src', 'resources', 'agent_runner.py')
      try {
        runnerContent = await fs.readFile(altSource, 'utf-8')
      } catch {
        throw new CliError(
          'Agent runner script not found. This is a packaging error.\n' +
          'Please reinstall the CLI: npm install -g @orchagent/cli'
        )
      }
    }

    await fs.writeFile(path.join(tempDir, 'agent_runner.py'), runnerContent)
    await fs.writeFile(path.join(tempDir, 'prompt.md'), prompt)
    await fs.writeFile(path.join(tempDir, 'input.json'), JSON.stringify(inputData, null, 2))

    if (outputSchema) {
      await fs.writeFile(path.join(tempDir, 'output_schema.json'), JSON.stringify(outputSchema))
    }

    if (customTools && customTools.length > 0) {
      await fs.writeFile(path.join(tempDir, 'custom_tools.json'), JSON.stringify(customTools))
    }

    // 5. Set env vars
    const subprocessEnv: Record<string, string | undefined> = { ...process.env }
    subprocessEnv.LOCAL_MODE = '1'
    subprocessEnv.LLM_PROVIDER = providerName
    subprocessEnv.LLM_MODEL = model
    if (apiKeyEnvVar && primary.apiKey) {
      subprocessEnv[apiKeyEnvVar] = primary.apiKey
    }

    // 6. Print warning and run
    process.stderr.write(
      chalk.yellow('\nWarning: Local mode. Bash commands execute on your machine (no sandbox).\n\n')
    )
    process.stderr.write(`Running with ${providerName} (${model})...\n`)

    const maxTurns = 25
    const proc = spawn('python3', ['agent_runner.py', '--max-turns', String(maxTurns), '--verbose'], {
      cwd: tempDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: subprocessEnv,
    })

    proc.stdin.end()

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    let lastUsage: { input_tokens?: number; output_tokens?: number } | null = null

    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      stderr += text
      // Filter out heartbeat dots and orchagent events, show human-readable lines
      for (const line of text.split('\n')) {
        if (line.startsWith('@@ORCHAGENT_EVENT:')) {
          try {
            const evt = JSON.parse(line.slice('@@ORCHAGENT_EVENT:'.length))
            if (evt.usage) lastUsage = evt.usage
          } catch { /* ignore parse errors */ }
          continue
        }
        if (line.trim() === '.' || line.trim() === '') continue
        process.stderr.write(line + '\n')
      }
    })

    const exitCode = await new Promise<number>((resolve) => {
      proc.on('close', (code) => resolve(code ?? 1))
      proc.on('error', (err) => {
        process.stderr.write(`Error running agent: ${err.message}\n`)
        resolve(1)
      })
    })

    // Display token usage if available
    const usage = lastUsage as { input_tokens?: number; output_tokens?: number } | null
    if (usage && (usage.input_tokens || usage.output_tokens)) {
      const total = (usage.input_tokens || 0) + (usage.output_tokens || 0)
      process.stderr.write(
        chalk.gray(`${total.toLocaleString()} tokens (${(usage.input_tokens || 0).toLocaleString()} in, ${(usage.output_tokens || 0).toLocaleString()} out)\n`)
      )
    }

    // 7. Parse and print result
    if (stdout.trim()) {
      try {
        const result = JSON.parse(stdout.trim())

        if (exitCode !== 0 && typeof result === 'object' && result !== null && 'error' in result) {
          throw new CliError(`Agent error: ${(result as { error: string }).error}`)
        }

        if (exitCode !== 0) {
          printJson(result)
          throw new CliError(`Agent exited with code ${exitCode}`)
        }

        printJson(result)
      } catch (err) {
        if (err instanceof CliError) throw err
        process.stdout.write(stdout)
        if (exitCode !== 0) {
          throw new CliError(`Agent exited with code ${exitCode}`)
        }
      }
    } else if (exitCode !== 0) {
      throw new CliError(
        `Agent exited with code ${exitCode} (no output)\n\n` +
        `Common causes:\n` +
        `  - Missing LLM API key (check ${apiKeyEnvVar || 'API key env var'})\n` +
        `  - Python SDK not installed (pip install ${sdkPackage})\n` +
        `  - Syntax error in prompt.md\n`
      )
    }
  } finally {
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  }
}

type SkillRef = {
  org?: string
  skill: string
  version: string
}

function parseSkillRef(value: string): SkillRef {
  const [ref, versionPart] = value.split('@')
  const version = versionPart?.trim() || 'v1'
  const segments = ref.split('/')
  if (segments.length === 1) {
    return { skill: segments[0], version }
  }
  if (segments.length === 2) {
    return { org: segments[0], skill: segments[1], version }
  }
  throw new CliError('Invalid skill reference. Use org/skill or skill format.')
}

async function loadSkillPrompts(
  config: ResolvedConfig,
  skillRefs: string[],
  defaultOrg?: string
): Promise<string[]> {
  const prompts: string[] = []

  for (const ref of skillRefs) {
    const parsed = parseSkillRef(ref.trim())
    const org = parsed.org ?? defaultOrg
    if (!org) {
      throw new CliError(`Missing org for skill: ${ref}. Use org/skill format.`)
    }

    const skillMeta = await publicRequest<PublicAgent>(
      config,
      `/public/agents/${org}/${parsed.skill}/${parsed.version}`
    )

    const skillType = skillMeta.type as string | undefined
    if (skillType !== 'skill') {
      throw new CliError(`${org}/${parsed.skill} is not a skill (type: ${skillType || 'prompt'})`)
    }

    const skillData = await publicRequest<AgentDownload>(
      config,
      `/public/agents/${org}/${parsed.skill}/${parsed.version}/download`
    )

    if (!skillData.prompt) {
      throw new CliError(`Skill has no content: ${ref}`)
    }

    prompts.push(skillData.prompt)
  }

  return prompts
}

function runCommand(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: true,
    })

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (data) => {
      const text = data.toString()
      stdout += text
      process.stdout.write(text)
    })

    proc.stderr?.on('data', (data) => {
      const text = data.toString()
      stderr += text
      process.stderr.write(text)
    })

    proc.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

async function checkPackageInstalled(packageName: string): Promise<boolean> {
  try {
    const { code } = await runCommand('pip', ['show', packageName, '--quiet'])
    return code === 0
  } catch {
    return false
  }
}

async function installTool(agentData: AgentDownload): Promise<void> {
  const installSource = agentData.pip_package || agentData.source_url

  if (!installSource) {
    throw new CliError(
      'This tool does not support local execution.\n' +
      'Remove the --local flag to run it on the server.'
    )
  }

  if (agentData.pip_package) {
    const installed = await checkPackageInstalled(agentData.pip_package)
    if (installed) {
      const spinner = createSpinner(`Package ${agentData.pip_package}`)
      spinner.succeed(`Package ${agentData.pip_package} already installed`)
      return
    }
  }

  await withSpinner(
    `Installing ${installSource}...`,
    async () => {
      const { code } = await runCommand('python3', ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', installSource])

      if (code !== 0) {
        throw new CliError(
          `Failed to install agent (exit code ${code}).\n\n` +
          'Troubleshooting:\n' +
          '  - Check Python is installed: python3 --version\n' +
          '  - Check pip is available: pip --version\n' +
          '  - Check network connectivity\n' +
          '  - Try installing manually: pip install <package>'
        )
      }
    },
    { successText: 'Installation complete' }
  )
}

async function executeTool(
  agentData: AgentDownload,
  args: string[]
): Promise<void> {
  if (!agentData.run_command) {
    throw new CliError(
      'This tool does not have a run command defined.\n' +
      'Remove the --local flag to run it on the server.'
    )
  }

  await installTool(agentData)

  const [cmd, ...cmdArgs] = agentData.run_command.split(' ')
  const fullArgs = [...cmdArgs, ...args]

  process.stderr.write(`\nRunning: ${cmd} ${fullArgs.join(' ')}\n\n`)
  const { code } = await runCommand(cmd, fullArgs)

  if (code !== 0) {
    process.exit(code)
  }
}

async function unzipBundle(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('unzip', ['-q', zipPath, '-d', destDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stderr = ''
    proc.stderr?.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (code !== 0) {
        const detail = stderr.trim() || `exit code ${code}`
        reject(new CliError(
          `Failed to extract bundle: ${detail}\n` +
          `Ensure the bundle is valid. Try re-publishing the agent.`
        ))
      } else {
        resolve()
      }
    })

    proc.on('error', (err) => {
      reject(new CliError(`Failed to run unzip: ${err.message}. Make sure unzip is installed.`))
    })
  })
}

async function executeBundleAgent(
  config: ResolvedConfig,
  org: string,
  agentName: string,
  version: string,
  agentData: AgentDownload,
  args: string[],
  inputOption?: string
): Promise<void> {
  const userCwd = process.cwd()
  const tempDir = path.join(os.tmpdir(), `orchagent-${agentName}-${Date.now()}`)
  await fs.mkdir(tempDir, { recursive: true })

  const bundleZip = path.join(tempDir, 'bundle.zip')
  const extractDir = path.join(tempDir, 'agent')

  try {
    const bundleBuffer = await withSpinner(
      `Downloading ${org}/${agentName}@${version} bundle...`,
      async () => {
        const buffer = await downloadBundleWithFallback(config, org, agentName, version, agentData.id)
        await fs.writeFile(bundleZip, buffer)
        return buffer
      },
      { successText: (buf) => `Downloaded bundle (${buf.length} bytes)` }
    )

    await fs.mkdir(extractDir, { recursive: true })
    await withSpinner(
      'Extracting bundle...',
      async () => {
        await unzipBundle(bundleZip, extractDir)
      },
      { successText: 'Bundle extracted' }
    )

    const requirementsPath = path.join(extractDir, 'requirements.txt')
    try {
      await fs.access(requirementsPath)
      await withSpinner(
        'Installing dependencies...',
        async () => {
          const { code } = await runCommand('python3', ['-m', 'pip', 'install', '-q', '--disable-pip-version-check', '-r', requirementsPath])
          if (code !== 0) {
            throw new CliError('Failed to install dependencies from requirements.txt')
          }
        },
        { successText: 'Dependencies installed' }
      )
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err
      }
    }

    const entrypoint = agentData.entrypoint || 'sandbox_main.py'
    const entrypointPath = path.join(extractDir, entrypoint)

    try {
      await fs.access(entrypointPath)
    } catch {
      throw new CliError(`Entrypoint not found: ${entrypoint}`)
    }

    let inputJson = '{}'
    if (inputOption) {
      try {
        const parsed = JSON.parse(inputOption)
        if (typeof parsed === 'object' && parsed !== null) {
          for (const key of ['path', 'directory', 'file_path']) {
            if (typeof parsed[key] === 'string' && !path.isAbsolute(parsed[key])) {
              parsed[key] = path.resolve(userCwd, parsed[key])
            }
          }
        }
        inputJson = JSON.stringify(parsed)
      } catch {
        throw jsonInputError('input')
      }
    } else if (args.length > 0) {
      const firstArg = args[0]
      const resolvedArg = path.isAbsolute(firstArg) ? firstArg : path.resolve(userCwd, firstArg)
      try {
        const stat = await fs.stat(resolvedArg)
        if (stat.isFile()) {
          const fileContent = await fs.readFile(resolvedArg, 'utf-8')
          try {
            JSON.parse(fileContent)
            inputJson = fileContent
          } catch {
            inputJson = JSON.stringify({ file_path: resolvedArg })
          }
        } else if (stat.isDirectory()) {
          inputJson = JSON.stringify({ directory: resolvedArg })
        }
      } catch {
        try {
          JSON.parse(firstArg)
          inputJson = firstArg
        } catch {
          inputJson = JSON.stringify({ input: firstArg })
        }
      }
    }

    process.stderr.write(`\nRunning: python3 ${entrypoint}\n\n`)

    const subprocessEnv: Record<string, string | undefined> = { ...process.env }
    if (config.apiKey) {
      subprocessEnv.ORCHAGENT_SERVICE_KEY = config.apiKey
      subprocessEnv.ORCHAGENT_API_URL = config.apiUrl
    }

    if (agentData.dependencies && agentData.dependencies.length > 0) {
      subprocessEnv[LOCAL_EXECUTION_ENV] = 'true'
      subprocessEnv[AGENTS_DIR_ENV] = AGENTS_DIR

      const agentRef = `${org}/${agentName}@${version}`
      subprocessEnv[CALL_CHAIN_ENV] = agentRef

      const manifest = agentData as AgentDownload & { manifest?: { timeout_ms?: number; max_hops?: number; per_call_downstream_cap?: number } }
      const timeoutMs = manifest.manifest?.timeout_ms || 120000
      subprocessEnv[DEADLINE_MS_ENV] = String(Date.now() + timeoutMs)

      subprocessEnv[MAX_HOPS_ENV] = String(manifest.manifest?.max_hops || 10)
      subprocessEnv[DOWNSTREAM_REMAINING_ENV] = String(manifest.manifest?.per_call_downstream_cap || 100)
    }

    const proc = spawn('python3', [entrypointPath], {
      cwd: extractDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: subprocessEnv,
    })

    proc.stdin.write(inputJson)
    proc.stdin.end()

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (data) => {
      const text = data.toString()
      stdout += text
    })

    proc.stderr?.on('data', (data) => {
      const text = data.toString()
      stderr += text
      process.stderr.write(text)
    })

    const exitCode = await new Promise<number>((resolve) => {
      proc.on('close', (code) => {
        resolve(code ?? 1)
      })
      proc.on('error', (err) => {
        process.stderr.write(`Error running agent: ${err.message}\n`)
        resolve(1)
      })
    })

    if (stdout.trim()) {
      try {
        const result = JSON.parse(stdout.trim())

        if (exitCode !== 0 && typeof result === 'object' && result !== null && 'error' in result) {
          throw new CliError(`Agent error: ${(result as { error: string }).error}`)
        }

        if (exitCode !== 0) {
          printJson(result)
          throw new CliError(`Agent exited with code ${exitCode}`)
        }

        printJson(result)
      } catch (err) {
        if (err instanceof CliError) throw err
        process.stdout.write(stdout)
        if (exitCode !== 0) {
          throw new CliError(`Agent exited with code ${exitCode}`)
        }
      }
    } else if (exitCode !== 0) {
      if (stderr.trim()) {
        throw new CliError(`Agent exited with code ${exitCode}\n\nError output:\n${stderr.trim()}`)
      }
      throw new CliError(
        `Agent exited with code ${exitCode} (no output)\n\n` +
        `Common causes:\n` +
        `  - Missing dependency (check requirements.txt)\n` +
        `  - Syntax error in entrypoint\n` +
        `  - Agent crashed before writing output\n\n` +
        `Run with --verbose or check logs in dashboard.`
      )
    }
  } finally {
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  }
}

async function saveAgentLocally(org: string, agent: string, agentData: AgentDownload): Promise<string> {
  const agentDir = path.join(AGENTS_DIR, org, agent)
  await fs.mkdir(agentDir, { recursive: true })

  await fs.writeFile(
    path.join(agentDir, 'agent.json'),
    JSON.stringify(agentData, null, 2)
  )

  if (resolveExecutionEngine(agentData) !== 'code_runtime' && agentData.prompt) {
    await fs.writeFile(path.join(agentDir, 'prompt.md'), agentData.prompt)
  }

  if (agentData.files) {
    for (const file of agentData.files) {
      const filePath = path.join(agentDir, file.path)
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, file.content)
    }
  }

  return agentDir
}

async function saveBundleLocally(
  config: ResolvedConfig,
  org: string,
  agent: string,
  version: string,
  agentId?: string
): Promise<string> {
  const agentDir = path.join(AGENTS_DIR, org, agent)
  const bundleDir = path.join(agentDir, 'bundle')

  const metaPath = path.join(agentDir, 'agent.json')
  try {
    const existingMeta = await fs.readFile(metaPath, 'utf-8')
    const existing = JSON.parse(existingMeta)
    if (existing.version === version) {
      try {
        await fs.access(bundleDir)
        return bundleDir
      } catch {
        // Bundle dir doesn't exist, need to extract
      }
    }
  } catch {
    // Metadata doesn't exist, need to download
  }

  const bundleBuffer = await withSpinner(
    `Downloading bundle for ${org}/${agent}@${version}...`,
    async () => downloadBundleWithFallback(config, org, agent, version, agentId),
    { successText: `Downloaded bundle for ${org}/${agent}@${version}` }
  )

  const tempZip = path.join(os.tmpdir(), `bundle-${Date.now()}.zip`)
  await fs.writeFile(tempZip, bundleBuffer)

  try {
    await fs.rm(bundleDir, { recursive: true, force: true })
  } catch {
    // Directory might not exist
  }
  await fs.mkdir(bundleDir, { recursive: true })
  await unzipBundle(tempZip, bundleDir)

  try {
    await fs.rm(tempZip)
  } catch {
    // Ignore cleanup errors
  }

  return bundleDir
}

// ─── Local directory execution ───────────────────────────────────────────────

function isLocalPath(ref: string): boolean {
  return ref.startsWith('.') || ref.startsWith('/') || ref.startsWith('~')
}

async function executeLocalFromDir(
  dirPath: string,
  args: string[],
  options: RunOptions
): Promise<void> {
  // Merge --data alias into --input
  if (options.data && !options.input) {
    options.input = options.data
  }
  if (options.here) {
    options.input = JSON.stringify({ path: process.cwd() })
  } else if (options.path) {
    options.input = JSON.stringify({ path: options.path })
  }

  const resolved = path.resolve(dirPath)

  // Verify directory exists
  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(resolved)
  } catch {
    throw new CliError(`Directory not found: ${resolved}`)
  }
  if (!stat.isDirectory()) {
    throw new CliError(`Not a directory: ${resolved}`)
  }

  // Read orchagent.json manifest
  const manifestPath = path.join(resolved, 'orchagent.json')
  let manifest: Record<string, unknown>
  try {
    const raw = await fs.readFile(manifestPath, 'utf-8')
    manifest = JSON.parse(raw)
  } catch {
    throw new CliError(
      `No orchagent.json found in ${resolved}\n\n` +
      `To run a local agent, the directory must contain orchagent.json.\n` +
      `Create one with: orch init`
    )
  }

  const manifestType = (manifest.type as string) || 'agent'
  const localType = canonicalAgentType(manifestType)
  const localEngine = resolveExecutionEngine({
    type: manifestType,
    execution_engine: (manifest.execution_engine as string | undefined) || null,
    runtime: (manifest.runtime as { command?: string } | undefined) || null,
    loop: (manifest.loop as Record<string, unknown> | undefined) || null,
  })

  // Load .env from agent directory (existing env vars take precedence)
  const dotEnvVars = await loadDotEnv(resolved)
  const dotEnvCount = Object.keys(dotEnvVars).length
  if (dotEnvCount > 0) {
    for (const [key, value] of Object.entries(dotEnvVars)) {
      if (!(key in process.env) || process.env[key] === undefined) {
        process.env[key] = value
      }
    }
    process.stderr.write(chalk.gray(`Loaded ${dotEnvCount} variable${dotEnvCount === 1 ? '' : 's'} from .env\n`))
  }

  if (localType === 'skill') {
    throw new CliError(
      'Skills cannot be run directly.\n\n' +
      'Skills are instructions meant to be injected into AI agent contexts.\n' +
      `Install with: orchagent skill install <org>/<skill>`
    )
  }

  if (localEngine === 'managed_loop') {
    // Read prompt.md
    const promptPath = path.join(resolved, 'prompt.md')
    let agentPrompt: string
    try {
      agentPrompt = await fs.readFile(promptPath, 'utf-8')
    } catch {
      throw new CliError(`No prompt.md found in ${resolved}`)
    }

    // Read schema.json for output schema
    let agentOutputSchema: object | undefined
    try {
      const schemaRaw = await fs.readFile(path.join(resolved, 'schema.json'), 'utf-8')
      const schemas = JSON.parse(schemaRaw)
      agentOutputSchema = schemas.output
    } catch {
      // Schema is optional
    }

    // Read custom_tools from manifest
    const customTools = (manifest.custom_tools as object[] | undefined) || undefined

    // Check for keyed file/mount injection
    const agentFileArgs = options.file ?? []
    const agentKeyedFiles = agentFileArgs.filter(a => isKeyedFileArg(a) !== null)
    const agentHasInjection = agentKeyedFiles.length > 0 || (options.mount ?? []).length > 0

    if (!options.input && !agentHasInjection) {
      process.stderr.write(`Loaded local agent: ${manifest.name || path.basename(resolved)}\n\n`)
      process.stderr.write(`Run with input:\n`)
      process.stderr.write(`  orch run ${dirPath} --local --data '{\"task\": \"...\"}'\n`)
      return
    }

    let agentInputData: Record<string, unknown>
    if (agentHasInjection) {
      const injected = await buildInjectedPayload({
        dataOption: options.input,
        fileArgs: agentKeyedFiles,
        mountArgs: options.mount,
      })
      agentInputData = JSON.parse(injected.body) as Record<string, unknown>
    } else {
      try {
        agentInputData = JSON.parse(options.input!) as Record<string, unknown>
      } catch {
        throw new CliError('Invalid JSON input')
      }
    }

    const config = await getResolvedConfig()
    await executeAgentLocally(
      resolved,
      agentPrompt,
      agentInputData,
      agentOutputSchema,
      customTools,
      manifest,
      config,
      options.provider,
      options.model
    )
    return
  }

  if (localEngine === 'direct_llm') {
    // Read prompt.md
    const promptPath = path.join(resolved, 'prompt.md')
    let prompt: string
    try {
      prompt = await fs.readFile(promptPath, 'utf-8')
    } catch {
      throw new CliError(`No prompt.md found in ${resolved}`)
    }

    // Read schema.json for schemas
    let inputSchema: object | undefined
    let outputSchema: object | undefined
    try {
      const schemaRaw = await fs.readFile(path.join(resolved, 'schema.json'), 'utf-8')
      const schemas = JSON.parse(schemaRaw)
      inputSchema = schemas.input
      outputSchema = schemas.output
    } catch {
      // Schema is optional
    }

    // Build AgentDownload from local files
    const agentData: AgentDownload = {
      type: 'agent',
      execution_engine: 'direct_llm',
      run_mode: (manifest.run_mode as 'on_demand' | 'always_on' | undefined) || 'on_demand',
      name: (manifest.name as string) || path.basename(resolved),
      version: (manifest.version as string) || 'local',
      description: manifest.description as string | undefined,
      prompt,
      input_schema: inputSchema,
      output_schema: outputSchema,
      supported_providers: (manifest.supported_providers as string[]) || ['any'],
      default_models: manifest.default_models as Record<string, string> | undefined,
    }

    // Check for keyed file/mount injection
    const localFileArgs = options.file ?? []
    const localKeyedFiles = localFileArgs.filter(a => isKeyedFileArg(a) !== null)
    const localHasInjection = localKeyedFiles.length > 0 || (options.mount ?? []).length > 0

    if (!options.input && !localHasInjection) {
      process.stderr.write(`Loaded local agent: ${agentData.name}\n\n`)
      process.stderr.write(`Run with input:\n`)
      process.stderr.write(`  orch run ${dirPath} --local --data '{...}'\n`)
      return
    }

    let inputData: Record<string, unknown>
    if (localHasInjection) {
      const injected = await buildInjectedPayload({
        dataOption: options.input,
        fileArgs: localKeyedFiles,
        mountArgs: options.mount,
      })
      inputData = JSON.parse(injected.body) as Record<string, unknown>
    } else {
      try {
        inputData = JSON.parse(options.input!) as Record<string, unknown>
      } catch {
        throw new CliError('Invalid JSON input')
      }
    }

    const config = await getResolvedConfig()
    const result = await executePromptLocally(agentData, inputData, [], config, options.provider, options.model)
    printJson(result)
    return
  }

  // Code runtime agents with bundle
  const entrypoint = (manifest.entrypoint as string) || 'sandbox_main.py'
  const entrypointPath = path.join(resolved, entrypoint)

  try {
    await fs.access(entrypointPath)
  } catch {
    // No local entrypoint — try run_command
    if (manifest.run_command) {
      const agentData: AgentDownload = {
        type: 'agent',
        execution_engine: 'code_runtime',
        run_mode: (manifest.run_mode as 'on_demand' | 'always_on' | undefined) || 'on_demand',
        name: (manifest.name as string) || path.basename(resolved),
        version: (manifest.version as string) || 'local',
        supported_providers: (manifest.supported_providers as string[]) || ['any'],
        run_command: manifest.run_command as string,
        source_url: manifest.source_url as string | undefined,
        pip_package: manifest.pip_package as string | undefined,
      }
      await executeTool(agentData, args)
      return
    }

    throw new CliError(
      `No entrypoint found in ${resolved}\n\n` +
      `Expected: ${entrypoint}\n` +
      `For code runtime agents, ensure the directory contains the entrypoint file\n` +
      `or has run_command set in orchagent.json.`
    )
  }

  // Execute bundle-style from local directory
  const config = await getResolvedConfig()
  const agentData: AgentDownload = {
    type: 'agent',
    execution_engine: 'code_runtime',
    run_mode: (manifest.run_mode as 'on_demand' | 'always_on' | undefined) || 'on_demand',
    name: (manifest.name as string) || path.basename(resolved),
    version: (manifest.version as string) || 'local',
    supported_providers: (manifest.supported_providers as string[]) || ['any'],
    entrypoint,
  }

  // Install requirements if present
  const requirementsPath = path.join(resolved, 'requirements.txt')
  try {
    await fs.access(requirementsPath)
    const { code } = await runCommand('python3', ['-m', 'pip', 'install', '-q', '--disable-pip-version-check', '-r', requirementsPath])
    if (code !== 0) {
      process.stderr.write('Warning: Failed to install requirements.txt\n')
    }
  } catch {
    // No requirements.txt
  }

  // Check for keyed file/mount injection (tool path)
  const toolFileArgs = options.file ?? []
  const toolKeyedFiles = toolFileArgs.filter(a => isKeyedFileArg(a) !== null)
  const toolHasInjection = toolKeyedFiles.length > 0 || (options.mount ?? []).length > 0

  let inputJson = '{}'
  if (toolHasInjection) {
    const injected = await buildInjectedPayload({
      dataOption: options.input,
      fileArgs: toolKeyedFiles,
      mountArgs: options.mount,
    })
    inputJson = injected.body
  } else if (options.input) {
    try {
      JSON.parse(options.input)
      inputJson = options.input
    } catch {
      throw new CliError('Invalid JSON input')
    }
  } else if (args.length > 0) {
    inputJson = JSON.stringify({ input: args[0] })
  }

  process.stderr.write(`\nRunning: python3 ${entrypoint}\n\n`)

  const subprocessEnv: Record<string, string | undefined> = { ...process.env }
  if (config.apiKey) {
    subprocessEnv.ORCHAGENT_SERVICE_KEY = config.apiKey
    subprocessEnv.ORCHAGENT_API_URL = config.apiUrl
  }

  const proc = spawn('python3', [entrypointPath], {
    cwd: resolved,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: subprocessEnv,
  })

  proc.stdin.write(inputJson)
  proc.stdin.end()

  let stdout = ''
  let stderr = ''

  proc.stdout?.on('data', (data: Buffer) => {
    stdout += data.toString()
  })
  proc.stderr?.on('data', (data: Buffer) => {
    const text = data.toString()
    stderr += text
    process.stderr.write(text)
  })

  const exitCode = await new Promise<number>((resolve) => {
    proc.on('close', (code) => resolve(code ?? 1))
    proc.on('error', (err) => {
      process.stderr.write(`Error running agent: ${err.message}\n`)
      resolve(1)
    })
  })

  if (stdout.trim()) {
    try {
      const result = JSON.parse(stdout.trim())
      if (exitCode !== 0 && typeof result === 'object' && result !== null && 'error' in result) {
        throw new CliError(`Agent error: ${(result as { error: string }).error}`)
      }
      if (exitCode !== 0) {
        printJson(result)
        throw new CliError(`Agent exited with code ${exitCode}`)
      }
      printJson(result)
    } catch (err) {
      if (err instanceof CliError) throw err
      process.stdout.write(stdout)
      if (exitCode !== 0) {
        throw new CliError(`Agent exited with code ${exitCode}`)
      }
    }
  } else if (exitCode !== 0) {
    throw new CliError(`Agent exited with code ${exitCode}`)
  }
}

// ─── Cloud execution path ───────────────────────────────────────────────────

function renderProgress(event: Record<string, unknown>): void {
  switch (event.type) {
    case 'turn_start':
      process.stderr.write(chalk.gray(`  Turn ${event.turn}/${event.max_turns}\n`))
      break
    case 'tool_call': {
      const icon =
        event.tool === 'bash'
          ? '$'
          : event.tool === 'read_file'
            ? '>'
            : event.tool === 'write_file'
              ? '<'
              : '~'
      process.stderr.write(
        chalk.cyan(`    ${icon} ${event.tool}`) +
          chalk.gray(` ${event.args_brief || ''}\n`)
      )
      break
    }
    case 'tool_result':
      if (event.status === 'error')
        process.stderr.write(chalk.yellow(`      (error)\n`))
      break
    case 'done':
      process.stderr.write(chalk.green(`  Done\n`))
      break
    case 'error':
      process.stderr.write(chalk.red(`  Error: ${event.message}\n`))
      break
  }
}

async function executeCloud(
  agentRef: string,
  file: string | undefined,
  options: RunOptions
): Promise<void> {
  // Merge --input alias into --data
  const dataValue = options.data || options.input
  options.data = dataValue

  const resolved = await getResolvedConfig()
  if (!resolved.apiKey) {
    throw new CliError('Missing API key. Run `orchagent login` first.')
  }

  const parsed = parseAgentRef(agentRef)
  const configFile = await loadConfig()
  const org = parsed.org ?? configFile.workspace ?? resolved.defaultOrg
  if (!org) {
    throw new CliError('Missing org. Use org/agent or set default org.')
  }

  // Resolve workspace context for the target org
  const workspaceId = await resolveWorkspaceIdForOrg(resolved, org)

  const agentMeta = await getAgentWithFallback(
    resolved,
    org,
    parsed.agent,
    parsed.version,
    workspaceId
  )
  const cloudType = canonicalAgentType(agentMeta.type as string | undefined)
  const cloudEngine = resolveExecutionEngine({
    type: agentMeta.type as string | undefined,
    execution_engine: (agentMeta as Agent & { execution_engine?: string | null }).execution_engine ?? null,
    runtime: (agentMeta as Agent & { runtime?: { command?: string } | null }).runtime ?? null,
    loop: (agentMeta as Agent & { loop?: Record<string, unknown> | null }).loop ?? null,
  })

  // Pre-flight: check required secrets before running (F-18)
  // Only for sandbox-backed engines where secrets are injected as env vars
  if (cloudEngine !== 'direct_llm') {
    const agentRequiredSecrets = (agentMeta as Agent).required_secrets
    if (agentRequiredSecrets?.length) {
      try {
        // Use already-resolved workspaceId (or fall back to config workspace slug)
        const wsId = workspaceId ?? (configFile.workspace ? (await resolveWorkspaceIdForOrg(resolved, configFile.workspace)) : undefined)
        if (wsId) {
          const secretsResult = await request<{ secrets: Array<{ name: string }> }>(
            resolved, 'GET', `/workspaces/${wsId}/secrets`
          )
          const existingNames = new Set(secretsResult.secrets.map((s: { name: string }) => s.name))
          const missing = agentRequiredSecrets.filter((s: string) => !existingNames.has(s))
          if (missing.length > 0) {
            throw new CliError(
              `Agent requires secrets not found in workspace '${org}':\n` +
              missing.map((s: string) => `  - ${s}`).join('\n') + '\n\n' +
              `Set them before running:\n` +
              missing.map((s: string) => `  orch secrets set ${s} <value>`).join('\n') + '\n\n' +
              `Secrets are injected as environment variables into the agent sandbox.\n` +
              `View existing secrets: orch secrets list`
            )
          }
        }
      } catch (err) {
        if (err instanceof CliError) throw err
        // Non-fatal: gateway will catch missing secrets at execution time
      }
    }
  }

  // Pre-call balance check for paid agents
  let pricingInfo: { price_cents: number | null } | undefined
  if (isPaidAgent(agentMeta)) {
    let isOwner = false
    try {
      const callerOrg = await getOrg(resolved, workspaceId)
      const agentOrgId = agentMeta.org_id
      const agentOrgSlug = agentMeta.org_slug
      if (agentOrgId && callerOrg.id === agentOrgId) {
        isOwner = true
      } else if (agentOrgSlug && callerOrg.slug === agentOrgSlug) {
        isOwner = true
      }
    } catch {
      isOwner = false
    }

    if (isOwner) {
      if (!options.json) process.stderr.write(`Cost: FREE (author)\n\n`)
    } else {
      const price = agentMeta.price_per_call_cents
      pricingInfo = { price_cents: price ?? null }

      if (!price || price <= 0) {
        if (!options.json) process.stderr.write(`Warning: Pricing data unavailable. The server will verify payment.\n\n`)
      } else {
        try {
          const balanceData = await getCreditsBalance(resolved)
          const balance = balanceData.balance_cents

          if (balance < price) {
            process.stderr.write(
              `Insufficient credits:\n` +
              `  Balance:  $${(balance / 100).toFixed(2)}\n` +
              `  Required: $${(price / 100).toFixed(2)}\n\n` +
              `Add credits:\n` +
              `  orch billing add 5\n` +
              `  orch billing balance  # check current balance\n`
            )
            process.exit(ExitCodes.PERMISSION_DENIED)
          }

          if (!options.json) process.stderr.write(`Cost: $${(price / 100).toFixed(2)}/call\n\n`)
        } catch (err) {
          if (!options.json) process.stderr.write(`Warning: Could not verify balance. The server will check payment.\n\n`)
        }
      }
    }
  }

  const endpoint =
    options.endpoint?.trim() || agentMeta.default_endpoint || 'analyze'

  const headers: Record<string, string> = {
    Authorization: `Bearer ${resolved.apiKey}`,
    'X-CLI-Version': packageJson.version,
    'X-OrchAgent-Client': 'cli',
  }
  if (workspaceId) {
    headers['X-Workspace-Id'] = workspaceId
  }
  if (options.tenant) {
    headers['X-OrchAgent-Tenant'] = options.tenant
  }

  const supportedProviders = agentMeta.supported_providers || ['any']
  let llmKey: string | undefined
  let llmProvider: string | undefined

  const configDefaultProvider = await getDefaultProvider()
  const effectiveProvider = options.provider ?? configDefaultProvider

  if (options.key) {
    if (!effectiveProvider) {
      throw new CliError(
        'When using --key, you must also specify --provider (openai, anthropic, or gemini)'
      )
    }
    validateProvider(effectiveProvider)
    if (options.model && effectiveProvider) {
      const modelLower = options.model.toLowerCase()
      const providerPatterns: Record<string, RegExp> = {
        openai: /^(gpt-|o1-|o3-|davinci|text-)/,
        anthropic: /^claude-/,
        gemini: /^gemini-/,
        ollama: /^(llama|mistral|deepseek|phi|qwen)/,
      }
      const expectedPattern = providerPatterns[effectiveProvider]
      if (expectedPattern && !expectedPattern.test(modelLower)) {
        process.stderr.write(
          `Warning: Model '${options.model}' may not be a ${effectiveProvider} model.\n\n`
        )
      }
    }
    llmKey = options.key
    llmProvider = effectiveProvider
  } else {
    let providersToCheck = supportedProviders as LlmProvider[]
    if (effectiveProvider) {
      validateProvider(effectiveProvider)
      providersToCheck = [effectiveProvider as LlmProvider]
      if (options.model) {
        const modelLower = options.model.toLowerCase()
        const providerPatterns: Record<string, RegExp> = {
          openai: /^(gpt-|o1-|o3-|davinci|text-)/,
          anthropic: /^claude-/,
          gemini: /^gemini-/,
          ollama: /^(llama|mistral|deepseek|phi|qwen)/,
        }
        const expectedPattern = providerPatterns[effectiveProvider]
        if (expectedPattern && !expectedPattern.test(modelLower)) {
          process.stderr.write(
            `Warning: Model '${options.model}' may not be a ${effectiveProvider} model.\n\n`
          )
        }
      }
    }
    const detected = await detectLlmKey(providersToCheck, resolved)
    if (detected) {
      llmKey = detected.key
      llmProvider = detected.provider
    }
  }

  let llmCredentials: { api_key: string; provider: string; model?: string } | undefined
  if (llmKey && llmProvider) {
    llmCredentials = {
      api_key: llmKey,
      provider: llmProvider,
      ...(options.model && { model: options.model }),
    }
  } else if (cloudEngine !== 'code_runtime') {
    const searchedProviders = effectiveProvider ? [effectiveProvider] : supportedProviders
    const providerList = searchedProviders.join(', ')
    process.stderr.write(
      `Warning: No LLM key found for provider(s): ${providerList}\n` +
      `Set an env var (e.g., OPENAI_API_KEY), run 'orchagent keys add <provider>', use --key, or configure in web dashboard\n\n`
    )
  }

  if (options.skills) {
    headers['X-OrchAgent-Skills'] = options.skills
  }
  if (options.skillsOnly) {
    headers['X-OrchAgent-Skills-Only'] = options.skillsOnly
  }
  if (options.noSkills) {
    headers['X-OrchAgent-No-Skills'] = 'true'
  }

  let body: BodyInit | undefined
  let sourceLabel: string | undefined
  const allFileArgs = [
    ...(options.file ?? []),
    ...(file ? [file] : []),
  ]

  // Partition --file args into keyed (key=path) vs unkeyed (plain path)
  const keyedFileArgs = allFileArgs.filter(a => isKeyedFileArg(a) !== null)
  const unkeyedFileArgs = allFileArgs.filter(a => isKeyedFileArg(a) === null)
  const hasKeyed = keyedFileArgs.length > 0
  const hasMounts = (options.mount ?? []).length > 0
  const hasInjection = hasKeyed || hasMounts

  // Cannot mix keyed and unkeyed --file args
  if (hasInjection && unkeyedFileArgs.length > 0) {
    throw new CliError(
      'Cannot mix keyed --file (key=path) with unkeyed --file (path) in the same command.\n\n' +
      'Use either:\n' +
      '  Keyed:   --file code=./main.py --file config=./config.toml\n' +
      '  Unkeyed: --file ./main.py --file ./config.toml'
    )
  }

  if (hasInjection) {
    // Route to JSON injection path
    const injected = await buildInjectedPayload({
      dataOption: options.data,
      fileArgs: keyedFileArgs,
      mountArgs: options.mount,
      llmCredentials,
    })
    body = injected.body
    sourceLabel = injected.sourceLabel
    headers['Content-Type'] = 'application/json'
  } else {
  // Existing body construction logic (unkeyed files only)
  const filePaths = unkeyedFileArgs
  if (options.data && options.metadata) {
    throw new CliError('Cannot use --data with --metadata. Use one or the other.')
  }
  if (options.data && filePaths.length > 0) {
    // Merge file content into --data
    const resolvedBody = await resolveJsonBody(options.data)
    const bodyObj = JSON.parse(resolvedBody) as Record<string, unknown>

    if (cloudEngine !== 'code_runtime') {
      const fieldName = options.fileField || inferFileField(agentMeta.input_schema as object | undefined)
      if (filePaths.length === 1) {
        await validateFilePath(filePaths[0])
        bodyObj[fieldName] = await fs.readFile(filePaths[0], 'utf-8')
        sourceLabel = filePaths[0]
      } else {
        const allContents: Record<string, string> = {}
        for (const fp of filePaths) {
          await validateFilePath(fp)
          allContents[path.basename(fp)] = await fs.readFile(fp, 'utf-8')
        }
        bodyObj[fieldName] = await fs.readFile(filePaths[0], 'utf-8')
        bodyObj.files = allContents
        sourceLabel = `${filePaths.length} files`
      }
      // Auto-populate filename if schema has it and user didn't provide it
      if (filePaths.length >= 1 && bodyObj.filename === undefined) {
        const schema = agentMeta.input_schema as Record<string, unknown> | undefined
        const schemaProps = schema?.properties as Record<string, unknown> | undefined
        if (schemaProps?.filename) {
          bodyObj.filename = path.basename(filePaths[0])
        }
      }
      applySchemaDefaults(bodyObj, agentMeta.input_schema as object | undefined)
      if (llmCredentials) bodyObj.llm_credentials = llmCredentials
      body = JSON.stringify(bodyObj)
      headers['Content-Type'] = 'application/json'
    } else {
      // Code-runtime agents: send files as multipart, --data as metadata
      let metadata = resolvedBody
      if (llmCredentials) {
        const metaObj = JSON.parse(metadata) as Record<string, unknown>
        metaObj.llm_credentials = llmCredentials
        metadata = JSON.stringify(metaObj)
      }
      const multipart = await buildMultipartBody(filePaths, metadata)
      body = multipart.body
      sourceLabel = multipart.sourceLabel
    }
  } else if (options.data) {
    const resolvedBody = await resolveJsonBody(options.data)
    warnIfLocalPathReference(resolvedBody)
    if (llmCredentials) {
      const bodyObj = JSON.parse(resolvedBody)
      bodyObj.llm_credentials = llmCredentials
      body = JSON.stringify(bodyObj)
    } else {
      body = resolvedBody
    }
    headers['Content-Type'] = 'application/json'
  } else if ((filePaths.length > 0 || options.metadata) && cloudEngine !== 'code_runtime') {
    const fieldName = options.fileField || inferFileField(agentMeta.input_schema as object | undefined)
    let bodyObj: Record<string, unknown> = {}

    if (options.metadata) {
      try {
        bodyObj = JSON.parse(options.metadata)
      } catch {
        throw new CliError('--metadata must be valid JSON.')
      }
    }

    if (filePaths.length === 1) {
      await validateFilePath(filePaths[0])
      const fileContent = await fs.readFile(filePaths[0], 'utf-8')
      bodyObj[fieldName] = fileContent
      sourceLabel = filePaths[0]
    } else if (filePaths.length > 1) {
      const allContents: Record<string, string> = {}
      for (const fp of filePaths) {
        await validateFilePath(fp)
        allContents[path.basename(fp)] = await fs.readFile(fp, 'utf-8')
      }
      const firstContent = await fs.readFile(filePaths[0], 'utf-8')
      bodyObj[fieldName] = firstContent
      bodyObj.files = allContents
      sourceLabel = `${filePaths.length} files`
    }

    // Auto-populate filename if schema has it and user didn't provide it
    if (filePaths.length >= 1 && bodyObj.filename === undefined) {
      const schema = agentMeta.input_schema as Record<string, unknown> | undefined
      const schemaProps = schema?.properties as Record<string, unknown> | undefined
      if (schemaProps?.filename) {
        bodyObj.filename = path.basename(filePaths[0])
      }
    }
    applySchemaDefaults(bodyObj, agentMeta.input_schema as object | undefined)

    if (llmCredentials) {
      bodyObj.llm_credentials = llmCredentials
    }
    body = JSON.stringify(bodyObj)
    headers['Content-Type'] = 'application/json'
  } else if (filePaths.length > 0 || options.metadata) {
    let metadata = options.metadata
    if (llmCredentials) {
      const metaObj = metadata ? JSON.parse(metadata) : {}
      metaObj.llm_credentials = llmCredentials
      metadata = JSON.stringify(metaObj)
    }
    const multipart = await buildMultipartBody(filePaths, metadata)
    body = multipart.body
    sourceLabel = multipart.sourceLabel
  } else if (llmCredentials) {
    body = JSON.stringify({ llm_credentials: llmCredentials })
    headers['Content-Type'] = 'application/json'
  } else {
    const multipart = await buildMultipartBody(undefined, options.metadata)
    body = multipart.body
    sourceLabel = multipart.sourceLabel
  }
  } // end of non-injection path

  const verboseQs = options.verbose ? '?verbose=true' : ''
  const url = `${resolved.apiUrl.replace(/\/$/, '')}/${org}/${parsed.agent}/${parsed.version}/${endpoint}${verboseQs}`

  // Enable SSE streaming for managed-loop agents (unless --json or --no-stream or --output)
  const isManagedLoopAgent = cloudType === 'agent' && cloudEngine === 'managed_loop'
  const wantStream = isManagedLoopAgent && !options.json && !options.noStream && !options.output
  if (wantStream) {
    headers['Accept'] = 'text/event-stream'
  }

  const spinner = options.json ? null : createSpinner(`Running ${org}/${parsed.agent}@${parsed.version}...`)
  spinner?.start()

  // Managed-loop runs can take longer; use 10 min timeout for streaming.
  const timeoutMs = isManagedLoopAgent ? 600000 : undefined

  let response: Response
  try {
    response = await safeFetchWithRetryForCalls(url, {
      method: 'POST',
      headers,
      body,
      ...(timeoutMs ? { timeoutMs } : {}),
    })
  } catch (err) {
    spinner?.fail(`Run failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    throw err
  }

  if (!response.ok) {
    const text = await response.text()
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      payload = text
    }

    const errorCode =
      typeof payload === 'object' && payload
        ? (payload as { error?: { code?: string } }).error?.code
        : undefined

    if (response.status === 402 || errorCode === 'INSUFFICIENT_CREDITS') {
      spinner?.fail('Insufficient credits')
      let errorMessage = 'Insufficient credits to run this agent.\n\n'

      if (pricingInfo?.price_cents) {
        errorMessage += `This agent costs $${(pricingInfo.price_cents / 100).toFixed(2)} per call.\n\n`
      }

      errorMessage +=
        'Add credits:\n' +
        '  orch billing add 5\n' +
        '  orch billing balance  # check current balance\n'

      throw new CliError(errorMessage, ExitCodes.PERMISSION_DENIED)
    }

    if (errorCode === 'CLI_VERSION_TOO_OLD') {
      spinner?.fail('CLI version too old')
      const minVersion =
        typeof payload === 'object' && payload
          ? (payload as { error?: { min_version?: string } }).error?.min_version
          : undefined
      throw new CliError(
        `Your CLI version (${packageJson.version}) is too old.\n\n` +
        (minVersion ? `Minimum required: ${minVersion}\n` : '') +
        'Update with: npm update -g @orchagent/cli'
      )
    }

    if (errorCode === 'LLM_KEY_REQUIRED') {
      spinner?.fail('LLM key required')
      throw new CliError(
        'This public agent requires you to provide an LLM key.\n' +
          'Use --key <key> --provider <provider> or set OPENAI_API_KEY/ANTHROPIC_API_KEY env var.'
      )
    }

    if (errorCode === 'LLM_RATE_LIMITED') {
      const rateLimitMsg =
        typeof payload === 'object' && payload
          ? (payload as { error?: { message?: string } }).error?.message || 'Rate limit exceeded'
          : 'Rate limit exceeded'
      spinner?.fail('Rate limited by LLM provider')
      throw new CliError(
        rateLimitMsg + '\n\n' +
          'This is the LLM provider\'s rate limit on your API key, not an OrchAgent limit.\n' +
          'To switch providers: orch run <agent> --provider <gemini|anthropic|openai>',
        ExitCodes.RATE_LIMITED
      )
    }

    const message =
      typeof payload === 'object' && payload
        ? (payload as { error?: { message?: string }; message?: string }).error
            ?.message ||
          (payload as { message?: string }).message ||
          response.statusText
        : response.statusText

    const requestId =
      typeof payload === 'object' && payload
        ? (payload as { metadata?: { request_id?: string } }).metadata?.request_id
        : undefined
    const refSuffix = requestId ? `\n\nref: ${requestId}` : ''

    if (errorCode === 'SANDBOX_ERROR') {
      spinner?.fail('Agent execution failed')
      const hint =
        typeof payload === 'object' && payload
          ? (payload as { error?: { hint?: string } }).error?.hint
          : undefined
      throw new CliError(
        `${message}\n\n` +
        `This is an error in the agent's code, not the platform.\n` +
        `Check the agent code and requirements, then republish.` +
        (hint ? `\n\nHint: ${hint}` : '') +
        refSuffix
      )
    }

    if (errorCode === 'SANDBOX_TIMEOUT') {
      spinner?.fail('Agent timed out')
      throw new CliError(
        `${message}\n\n` +
        `The agent did not complete in time. Try:\n` +
        `  - Simplifying the input\n` +
        `  - Using a smaller dataset\n` +
        `  - Contacting the agent author to increase the timeout` +
        refSuffix
      )
    }

    if (errorCode === 'MISSING_SECRETS') {
      spinner?.fail('Missing workspace secrets')

      // Extract secret names from gateway message:
      // "Agent requires secret(s) not found in workspace: NAME1, NAME2. Add them in Settings > Secrets."
      const secretNames: string[] = []
      if (message) {
        const match = message.match(/not found in workspace:\s*(.+?)\./)
        if (match) {
          secretNames.push(...match[1].split(',').map((s: string) => s.trim()).filter(Boolean))
        }
      }

      let hint = ''
      if (secretNames.length > 0) {
        hint += `Missing secrets:\n`
        for (const name of secretNames) {
          hint += `  - ${name}\n`
        }
        hint += `\nSet them with:\n`
        for (const name of secretNames) {
          hint += `  orch secrets set ${name} <value>\n`
        }
      } else {
        hint += `${message}\n\n`
        hint += `Set missing secrets:\n`
        hint += `  orch secrets set <NAME> <value>\n`
      }
      hint += `\nView existing secrets:\n`
      hint += `  orch secrets list`

      throw new CliError(hint + refSuffix)
    }

    if (response.status >= 500) {
      spinner?.fail(`Server error (${response.status})`)
      throw new CliError(
        `${message}\n\n` +
        `This is a platform error — try again in a moment.\n` +
        `If it persists, contact support.` +
        refSuffix
      )
    }

    spinner?.fail(`Run failed: ${message}`)
    throw new CliError(message + refSuffix)
  }

  // Handle SSE streaming response
  const contentType = response.headers?.get?.('content-type') || ''
  if (contentType.includes('text/event-stream') && response.body) {
    spinner?.stop()
    const { parseSSE } = await import('../lib/sse.js')
    let finalPayload: unknown = null
    let hadError = false

    process.stderr.write(chalk.gray(`\nStreaming ${org}/${parsed.agent}@${parsed.version}:\n`))

    for await (const { event, data } of parseSSE(response.body)) {
      if (event === 'progress') {
        try {
          renderProgress(JSON.parse(data))
        } catch {
          // ignore malformed progress events
        }
      } else if (event === 'result') {
        try {
          finalPayload = JSON.parse(data)
        } catch {
          finalPayload = data
        }
      } else if (event === 'error') {
        hadError = true
        try {
          finalPayload = JSON.parse(data)
        } catch {
          finalPayload = data
        }
      }
    }

    process.stderr.write('\n')

    await track('cli_run', {
      agent: `${org}/${parsed.agent}@${parsed.version}`,
      input_type: hasInjection ? 'file_injection' : unkeyedFileArgs.length > 0 ? 'file' : options.data ? 'json' : 'empty',
      mode: 'cloud',
      streamed: true,
    })

    if (hadError) {
      const errMsg =
        typeof finalPayload === 'object' && finalPayload
          ? (finalPayload as { error?: { message?: string } }).error?.message || 'Agent execution failed'
          : 'Agent execution failed'
      throw new CliError(errMsg)
    }

    if (finalPayload !== null) {
      printJson(finalPayload)

      if (typeof finalPayload === 'object' && finalPayload !== null && 'metadata' in finalPayload) {
        const meta = (finalPayload as Record<string, unknown>).metadata as Record<string, unknown> | undefined
        if (meta) {
          const parts: string[] = []
          if (typeof meta.processing_time_ms === 'number') {
            parts.push(`${(meta.processing_time_ms / 1000).toFixed(1)}s total`)
          }
          if (typeof meta.execution_time_ms === 'number') {
            parts.push(`${(meta.execution_time_ms / 1000).toFixed(1)}s execution`)
          }
          const usage = meta.usage as { input_tokens?: number; output_tokens?: number } | undefined
          if (usage && (usage.input_tokens || usage.output_tokens)) {
            const total = (usage.input_tokens || 0) + (usage.output_tokens || 0)
            parts.push(`${total.toLocaleString()} tokens (${(usage.input_tokens || 0).toLocaleString()} in, ${(usage.output_tokens || 0).toLocaleString()} out)`)
          }
          if (typeof meta.request_id === 'string') {
            parts.push(`ref: ${meta.request_id}`)
          }
          if (parts.length > 0) {
            process.stderr.write(chalk.gray(`${parts.join(' · ')}\n`))
          }
          const runId = response.headers?.get?.('x-run-id')
          if (runId) {
            process.stderr.write(chalk.gray(`View logs: orch logs ${runId}\n`))
          }
        }
      }
    }

    return
  }

  spinner?.succeed(`Ran ${org}/${parsed.agent}@${parsed.version}`)

  if (!options.json && isPaidAgent(agentMeta) && pricingInfo?.price_cents && pricingInfo.price_cents > 0) {
    process.stderr.write(`\nCost: $${(pricingInfo.price_cents / 100).toFixed(2)} USD\n`)
  }

  const inputType =
    hasInjection
      ? 'file_injection'
      : unkeyedFileArgs.length > 0
        ? 'file'
        : options.data
          ? 'json'
          : sourceLabel === 'stdin'
            ? 'stdin'
            : sourceLabel === 'metadata'
              ? 'metadata'
              : 'empty'
  await track('cli_run', {
    agent: `${org}/${parsed.agent}@${parsed.version}`,
    input_type: inputType,
    mode: 'cloud',
  })

  if (options.output) {
    const buffer = Buffer.from(await response.arrayBuffer())
    await fs.writeFile(options.output, buffer)
    process.stdout.write(`Saved response to ${options.output}\n`)
    return
  }

  const text = await response.text()
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    payload = text
  }

  if (options.json) {
    if (typeof payload === 'string') {
      process.stdout.write(`${payload}\n`)
      return
    }
    printJson(payload)
    return
  }

  if (typeof payload === 'string') {
    process.stdout.write(`${payload}\n`)
    return
  }

  printJson(payload)

  // Display timing metadata on stderr (non-json mode only)
  if (typeof payload === 'object' && payload !== null && 'metadata' in payload) {
    const meta = (payload as Record<string, unknown>).metadata as Record<string, unknown> | undefined
    if (meta) {
      // Show sandbox output when --verbose
      if (options.verbose) {
        const stderr = meta.stderr as string | null | undefined
        const stdout = meta.stdout as string | null | undefined
        if (stderr) {
          process.stderr.write(chalk.bold.yellow('\n--- stderr ---') + '\n' + stderr + '\n')
        }
        if (stdout) {
          process.stderr.write(chalk.bold.cyan('\n--- stdout ---') + '\n' + stdout + '\n')
        }
        if (!stderr && !stdout) {
          process.stderr.write(chalk.gray('\nNo sandbox output captured.\n'))
        }
      }

      const parts: string[] = []
      if (typeof meta.processing_time_ms === 'number') {
        parts.push(`${(meta.processing_time_ms / 1000).toFixed(1)}s total`)
      }
      if (typeof meta.execution_time_ms === 'number') {
        parts.push(`${(meta.execution_time_ms / 1000).toFixed(1)}s execution`)
      }
      const usage = meta.usage as { input_tokens?: number; output_tokens?: number } | undefined
      if (usage && (usage.input_tokens || usage.output_tokens)) {
        const total = (usage.input_tokens || 0) + (usage.output_tokens || 0)
        parts.push(`${total.toLocaleString()} tokens (${(usage.input_tokens || 0).toLocaleString()} in, ${(usage.output_tokens || 0).toLocaleString()} out)`)
      }
      if (typeof meta.request_id === 'string') {
        parts.push(`ref: ${meta.request_id}`)
      }
      if (parts.length > 0) {
        process.stderr.write(chalk.gray(`\n${parts.join(' · ')}\n`))
      }
      const runId = response.headers?.get?.('x-run-id')
      if (runId) {
        process.stderr.write(chalk.gray(`View logs: orch logs ${runId}\n`))
      }
    }
  }
}

// ─── Local execution path ───────────────────────────────────────────────────

async function executeLocal(
  agentRef: string,
  args: string[],
  options: RunOptions
): Promise<void> {
  // Merge --data alias into --input
  if (options.data && !options.input) {
    options.input = options.data
  }

  // Handle --here and --path shortcuts
  if (options.here) {
    options.input = JSON.stringify({ path: process.cwd() })
  } else if (options.path) {
    options.input = JSON.stringify({ path: options.path })
  }

  if (options.model && options.provider) {
    const modelLower = options.model.toLowerCase()
    const providerPatterns: Record<string, RegExp> = {
      openai: /^(gpt-|o1-|o3-|davinci|text-)/,
      anthropic: /^claude-/,
      gemini: /^gemini-/,
      ollama: /^(llama|mistral|deepseek|phi|qwen)/,
    }
    const expectedPattern = providerPatterns[options.provider]
    if (expectedPattern && !expectedPattern.test(modelLower)) {
      process.stderr.write(
        `Warning: Model '${options.model}' may not be a ${options.provider} model.\n\n`
      )
    }
  }

  const resolved = await getResolvedConfig()

  const parsed = parseAgentRef(agentRef)
  const configFile = await loadConfig()
  const org = parsed.org ?? configFile.workspace ?? resolved.defaultOrg
  if (!org) {
    throw new CliError('Missing org. Use org/agent format.')
  }

  // Resolve workspace context for the target org
  const workspaceId = await resolveWorkspaceIdForOrg(resolved, org)

  // Download agent definition with spinner
  const agentData = await withSpinner(
    `Downloading ${org}/${parsed.agent}@${parsed.version}...`,
    async () => {
      try {
        return await downloadAgent(resolved, org, parsed.agent, parsed.version, workspaceId)
      } catch (err) {
        const agentMeta = await getPublicAgent(resolved, org, parsed.agent, parsed.version)
        return {
          type: (agentMeta.type as AgentDownload['type']) || 'agent',
          run_mode: (agentMeta as PublicAgent & { run_mode?: 'on_demand' | 'always_on' | null }).run_mode ?? null,
          execution_engine: (agentMeta as PublicAgent & { execution_engine?: 'direct_llm' | 'managed_loop' | 'code_runtime' | null }).execution_engine ?? null,
          callable: (agentMeta as PublicAgent & { callable?: boolean }).callable,
          name: agentMeta.name,
          version: agentMeta.version,
          description: agentMeta.description || undefined,
          supported_providers: agentMeta.supported_providers || ['any'],
        } as AgentDownload
      }
    },
    { successText: `Downloaded ${org}/${parsed.agent}@${parsed.version}` }
  )
  const localType = canonicalAgentType(agentData.type)
  const localEngine = resolveExecutionEngine(agentData)

  // Skills cannot be run directly
  if (localType === 'skill') {
    throw new CliError(
      'Skills cannot be run directly.\n\n' +
      'Skills are instructions meant to be injected into AI agent contexts.\n\n' +
      'Options:\n' +
      `  Install for AI tools:  orchagent skill install ${org}/${parsed.agent}\n` +
      `  Use with an agent:     orchagent run <agent> --skills ${org}/${parsed.agent}`
    )
  }

  // Managed-loop agents execute locally with the agent runner.
  if (localEngine === 'managed_loop') {
    if (!agentData.prompt) {
      throw new CliError(
        'Agent prompt not available for local execution.\n\n' +
        'This agent may have local download disabled.\n' +
        'Remove the --local flag to run in the cloud:\n' +
        `  orch run ${org}/${parsed.agent}@${parsed.version} --data '{"task": "..."}'`
      )
    }

    if (!options.input) {
      process.stderr.write(`\nAgent downloaded. Run with:\n`)
      process.stderr.write(`  orch run ${org}/${parsed.agent}@${parsed.version} --local --data '{\"task\": \"...\"}'\n`)
      return
    }

    let agentInputData: Record<string, unknown>
    try {
      agentInputData = JSON.parse(options.input) as Record<string, unknown>
    } catch {
      throw new CliError('Invalid JSON input')
    }

    // Write prompt to temp dir and run
    const tempAgentDir = path.join(os.tmpdir(), `orchagent-agent-${parsed.agent}-${Date.now()}`)
    await fs.mkdir(tempAgentDir, { recursive: true })
    try {
      await fs.writeFile(path.join(tempAgentDir, 'prompt.md'), agentData.prompt)
      await executeAgentLocally(
        tempAgentDir,
        agentData.prompt,
        agentInputData,
        agentData.output_schema,
        undefined,
        {},
        resolved,
        options.provider,
        options.model
      )
    } finally {
      try { await fs.rm(tempAgentDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
    return
  }

  // Check for dependencies (orchestrator agents)
  if (agentData.dependencies && agentData.dependencies.length > 0) {
    const depStatuses = await withSpinner(
      'Checking dependencies...',
      async () => checkDependencies(resolved, agentData.dependencies!),
      { successText: `Found ${agentData.dependencies.length} dependencies` }
    )

    let choice: 'server' | 'local' | 'cancel'

    if (options.withDeps) {
      choice = 'local'
    } else {
      choice = await promptUserForDeps(depStatuses)
    }

    if (choice === 'cancel') {
      process.stderr.write('\nCancelled.\n')
      process.exit(0)
    }

    if (choice === 'server') {
      process.stderr.write(`\nRun without --local for server execution:\n`)
      process.stderr.write(`  orch run ${org}/${parsed.agent}@${parsed.version} --data '{...}'\n\n`)
      process.exit(0)
    }

    await downloadDependenciesRecursively(resolved, depStatuses)
  }

  // Check if user is overriding locked skills
  const agentSkillsLocked = (agentData as AgentDownload & { skills_locked?: boolean }).skills_locked
  if (agentSkillsLocked && (options.noSkills || options.skillsOnly)) {
    const readline = await import('readline')
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
    const answer = await new Promise<string>(resolve => {
      rl.question(
        `\nWarning: Author locked skills for this agent.\n` +
        `Default skills: ${(agentData as any).default_skills?.join(', ') || '(none)'}\n` +
        `Override anyway? [y/N] `,
        resolve
      )
    })
    rl.close()
    if (answer.toLowerCase() !== 'y') {
      process.stderr.write('Aborted. Running with author\'s locked skills.\n')
      options.noSkills = false
      options.skillsOnly = undefined
    }
  }

  // Save locally
  const agentDir = await saveAgentLocally(org, parsed.agent, agentData)
  process.stderr.write(`\nAgent saved to: ${agentDir}\n`)

  if (localEngine === 'code_runtime') {
    if (agentData.has_bundle) {
      if (options.downloadOnly) {
        process.stdout.write(`\nCode runtime bundle is available for local execution.\n`)
        process.stdout.write(`Run with: orch run ${org}/${parsed.agent} --local [args...]\n`)
        return
      }

      // Pre-build injected payload for bundle agent if keyed files/mounts present
      const bundleFileArgs = options.file ?? []
      const bundleKeyedFiles = bundleFileArgs.filter(a => isKeyedFileArg(a) !== null)
      const bundleHasInjection = bundleKeyedFiles.length > 0 || (options.mount ?? []).length > 0
      let bundleInput = options.input
      if (bundleHasInjection) {
        const injected = await buildInjectedPayload({
          dataOption: options.input,
          fileArgs: bundleKeyedFiles,
          mountArgs: options.mount,
        })
        bundleInput = injected.body
      }
      await executeBundleAgent(resolved, org, parsed.agent, parsed.version, agentData, args, bundleInput)
      return
    }

    if (agentData.run_command && (agentData.source_url || agentData.pip_package)) {
      if (options.downloadOnly) {
        process.stdout.write(`\nTool ready for local execution.\n`)
        process.stdout.write(`Run with: orch run ${org}/${parsed.agent} --local [args...]\n`)
        return
      }

      await executeTool(agentData, args)
      return
    }

    // Fallback: code runtime agent doesn't support local execution.
    process.stdout.write(`\nThis code runtime agent is configured for server execution.\n`)
    process.stdout.write(`\nRun without --local: orch run ${org}/${parsed.agent}@${parsed.version} --data '{...}'\n`)
    return
  }

  if (options.downloadOnly) {
    process.stdout.write(`\nAgent downloaded. Run with:\n`)
    process.stdout.write(`  orch run ${org}/${parsed.agent}@${parsed.version} --local --input '{...}'\n`)
    return
  }

  // Check for keyed file/mount injection
  const execLocalFileArgs = options.file ?? []
  const execLocalKeyedFiles = execLocalFileArgs.filter(a => isKeyedFileArg(a) !== null)
  const execLocalHasInjection = execLocalKeyedFiles.length > 0 || (options.mount ?? []).length > 0

  // Direct LLM agents execute locally via prompt composition.
  if (!options.input && !execLocalHasInjection) {
    process.stdout.write(`\nAgent ready.\n`)
    process.stdout.write(`Run with: orch run ${org}/${parsed.agent}@${parsed.version} --local --input '{...}'\n`)
    return
  }

  let inputData: Record<string, unknown>
  if (execLocalHasInjection) {
    const injected = await buildInjectedPayload({
      dataOption: options.input,
      fileArgs: execLocalKeyedFiles,
      mountArgs: options.mount,
    })
    inputData = JSON.parse(injected.body) as Record<string, unknown>
  } else {
    try {
      inputData = JSON.parse(options.input!) as Record<string, unknown>
    } catch {
      throw new CliError('Invalid JSON input')
    }
  }

  // Handle skill composition
  let skillPrompts: string[] = []
  if (!options.noSkills) {
    const skillRefs: string[] = []

    if (options.skillsOnly) {
      skillRefs.push(...options.skillsOnly.split(',').map((s) => s.trim()))
    } else {
      const defaultSkills = (agentData as AgentDownload & { default_skills?: string[] }).default_skills || []
      skillRefs.push(...defaultSkills)

      if (options.skills) {
        skillRefs.push(...options.skills.split(',').map((s) => s.trim()))
      }
    }

    if (skillRefs.length > 0) {
      skillPrompts = await withSpinner(
        `Loading ${skillRefs.length} skill(s)...`,
        async () => loadSkillPrompts(resolved, skillRefs, org),
        { successText: `Loaded ${skillRefs.length} skill(s)` }
      )
    }
  }

  const result = await executePromptLocally(agentData, inputData, skillPrompts, resolved, options.provider, options.model)
  printJson(result)
}

// ─── Command registration ───────────────────────────────────────────────────

type RunOptions = {
  local?: boolean
  input?: string
  data?: string
  downloadOnly?: boolean
  withDeps?: boolean
  json?: boolean
  verbose?: boolean
  skills?: string
  skillsOnly?: string
  noSkills?: boolean
  noStream?: boolean
  here?: boolean
  path?: string
  provider?: string
  model?: string
  endpoint?: string
  tenant?: string
  key?: string
  output?: string
  file?: string[]
  fileField?: string
  metadata?: string
  mount?: string[]
}

export function registerRunCommand(program: Command): void {
  program
    .command('run <agent> [file]')
    .description('Run an agent (cloud by default, --local for local execution)')
    .option('--local', 'Run locally instead of on the server')
    .option('--data <json>', 'JSON payload (string or @file, @- for stdin)')
    .option('--input <json>', 'Alias for --data')
    .option('--json', 'Output raw JSON')
    .option('--verbose', 'Show sandbox stdout/stderr output (cloud only)')
    .option('--provider <provider>', 'LLM provider (openai, anthropic, gemini, ollama)')
    .option('--model <model>', 'LLM model to use (overrides agent default)')
    .option('--key <key>', 'LLM API key (overrides env vars)')
    .option('--skills <skills>', 'Add skills (comma-separated)')
    .option('--skills-only <skills>', 'Use only these skills')
    .option('--no-skills', 'Ignore default skills')
    .option('--no-stream', 'Disable real-time streaming for agent-type agents')
    // Cloud-only options
    .option('--endpoint <endpoint>', 'Override agent endpoint (cloud only)')
    .option('--tenant <tenant>', 'Tenant identifier for multi-tenant callers (cloud only)')
    .option('--output <file>', 'Save response body to a file (cloud only)')
    .option('--file <path...>', 'File(s) to upload or inject as keyed fields (key=path)')
    .option('--file-field <field>', 'Schema field name for file content (cloud only)')
    .option('--mount <field=dir...>', 'Mount a directory as a JSON field map (field=dir, can specify multiple)')
    .option('--metadata <json>', 'JSON metadata to send with files (cloud only)')
    // Local-only options
    .option('--download-only', 'Just download the agent, do not execute (local only)')
    .option('--with-deps', 'Automatically download all dependencies (local only)')
    .option('--here', 'Scan current directory (local only)')
    .option('--path <dir>', 'Shorthand for --data \'{"path": "<dir>"}\' (local only)')
    .addHelpText('after', `
Examples:
  Cloud execution (default):
    orch run orchagent/leak-finder --data '{"repo_url": "https://github.com/org/repo"}'
    orch run orchagent/invoice-scanner invoice.pdf
    orch run orchagent/useeffect-checker --file src/App.tsx
    cat input.json | orch run acme/agent --data @-
    orch run acme/image-processor photo.jpg --output result.png

  Keyed file injection (--file key=path):
    orch run agent --file code=./src/lib.cairo
    orch run agent --data '{"filter": "test_add"}' --file code=./src/lib.cairo
    orch run agent --file config=./Scarb.toml --file code=./src/lib.cairo

  Directory mount (--mount field=dir):
    orch run agent --mount source_files=./src/ --mount test_files=./tests/
    orch run agent --data '{"filter": "test_add"}' --mount src=./src/ --file config=./Scarb.toml

  Local execution (--local):
    orch run orchagent/leak-finder --local --data '{"path": "."}'
    orch run joe/summarizer --local --data '{"text": "Hello world"}'
    orch run orchagent/leak-finder --local --download-only

Paid Agents:
  Paid agents charge per call and deduct from your prepaid credits.
  Check your balance: orch billing balance
  Add credits: orch billing add 5

  Same-author calls are FREE - you won't be charged for calling your own agents.

File handling (cloud):
  For prompt agents, file content is read and sent as JSON mapped to the agent's
  input schema. Use --file-field to specify the field name (auto-detected by default).
  For tools, files are uploaded as multipart form data.

  Use --file key=path to inject a file's content at a specific JSON field.
  Use --mount field=dir to inject a directory tree as a {path: content} map.
  These produce standard JSON payloads - no server changes needed.

Important: Remote agents cannot access your local filesystem. If your --data payload
contains keys like 'path', 'directory', 'file', etc., those values will be interpreted
by the server, not your local machine. To use local files, use --local or --file.
`)
    .action(
      async (
        agentRef: string,
        file: string | undefined,
        options: RunOptions
      ) => {
        if (options.local && isLocalPath(agentRef)) {
          // Local directory execution (e.g., orch run . --local)
          const args = file ? [file] : []
          await executeLocalFromDir(agentRef, args, options)
        } else if (options.local) {
          // Local execution: file arg becomes first positional arg
          const args = file ? [file] : []
          await executeLocal(agentRef, args, options)
        } else {
          await executeCloud(agentRef, file, options)
        }
      }
    )
}
