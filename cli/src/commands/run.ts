import { Command } from 'commander'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { spawn } from 'child_process'

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
  type: 'prompt' | 'tool' | 'skill' | 'agent'
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
        `Tip: Use 'orch run <agent> --local' to execute locally with filesystem access.\n\n`
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

// ─── Local execution helpers ────────────────────────────────────────────────

async function downloadAgent(
  config: ResolvedConfig,
  org: string,
  agent: string,
  version: string
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
            const myAgents = await listMyAgents(config)
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

  const userOrg = await getOrg(config)
  if (userOrg.slug !== org) {
    throw new ApiError(`Agent '${org}/${agent}@${version}' not found`, 404)
  }

  // Find agent in user's list
  const agents = await listMyAgents(config)
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
      const downloadable = !!(agentData.source_url || agentData.pip_package || agentData.has_bundle || agentData.type === 'prompt')
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

        if (status.agentData!.type === 'tool' && (status.agentData!.source_url || status.agentData!.pip_package)) {
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

  if (agentData.type === 'prompt' && agentData.prompt) {
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

  const agentType = (manifest.type as string) || 'tool'

  if (agentType === 'skill') {
    throw new CliError(
      'Skills cannot be run directly.\n\n' +
      'Skills are instructions meant to be injected into AI agent contexts.\n' +
      `Install with: orchagent skill install <org>/<skill>`
    )
  }

  if (agentType === 'agent') {
    throw new CliError(
      'Agent type cannot be run locally.\n\n' +
      'Agent type requires a sandbox environment with tool use capabilities.\n' +
      'Publish first, then run in the cloud:\n' +
      '  orch publish && orch run <org>/<agent> --data \'{"task": "..."}\''
    )
  }

  if (agentType === 'prompt') {
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
      type: 'prompt',
      name: (manifest.name as string) || path.basename(resolved),
      version: (manifest.version as string) || 'local',
      description: manifest.description as string | undefined,
      prompt,
      input_schema: inputSchema,
      output_schema: outputSchema,
      supported_providers: (manifest.supported_providers as string[]) || ['any'],
      default_models: manifest.default_models as Record<string, string> | undefined,
    }

    if (!options.input) {
      process.stderr.write(`Loaded local agent: ${agentData.name}\n\n`)
      process.stderr.write(`Run with input:\n`)
      process.stderr.write(`  orch run ${dirPath} --local --data '{...}'\n`)
      return
    }

    let inputData: Record<string, unknown>
    try {
      inputData = JSON.parse(options.input) as Record<string, unknown>
    } catch {
      throw new CliError('Invalid JSON input')
    }

    const config = await getResolvedConfig()
    const result = await executePromptLocally(agentData, inputData, [], config, options.provider, options.model)
    printJson(result)
    return
  }

  // Tool agents with bundle
  const entrypoint = (manifest.entrypoint as string) || 'sandbox_main.py'
  const entrypointPath = path.join(resolved, entrypoint)

  try {
    await fs.access(entrypointPath)
  } catch {
    // No local entrypoint — try run_command
    if (manifest.run_command) {
      const agentData: AgentDownload = {
        type: 'tool',
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
      `For tool agents, ensure the directory contains the entrypoint file\n` +
      `or has run_command set in orchagent.json.`
    )
  }

  // Execute bundle-style from local directory
  const config = await getResolvedConfig()
  const agentData: AgentDownload = {
    type: 'tool',
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

  let inputJson = '{}'
  if (options.input) {
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

  const agentMeta = await getAgentWithFallback(
    resolved,
    org,
    parsed.agent,
    parsed.version
  )

  // Pre-call balance check for paid agents
  let pricingInfo: { price_cents: number | null } | undefined
  if (isPaidAgent(agentMeta)) {
    let isOwner = false
    try {
      const callerOrg = await getOrg(resolved)
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
  } else if (agentMeta.type === 'prompt') {
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
  const filePaths = [
    ...(options.file ?? []),
    ...(file ? [file] : []),
  ]
  if (options.data && options.metadata) {
    throw new CliError('Cannot use --data with --metadata. Use one or the other.')
  }
  if (options.data && filePaths.length > 0) {
    // Merge file content into --data
    const resolvedBody = await resolveJsonBody(options.data)
    const bodyObj = JSON.parse(resolvedBody) as Record<string, unknown>

    if (agentMeta.type === 'prompt') {
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
      // Tool agents: send files as multipart, --data as metadata
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
  } else if ((filePaths.length > 0 || options.metadata) && agentMeta.type === 'prompt') {
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

  const url = `${resolved.apiUrl.replace(/\/$/, '')}/${org}/${parsed.agent}/${parsed.version}/${endpoint}`

  const spinner = options.json ? null : createSpinner(`Running ${org}/${parsed.agent}@${parsed.version}...`)
  spinner?.start()

  let response: Response
  try {
    response = await safeFetchWithRetryForCalls(url, {
      method: 'POST',
      headers,
      body,
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

    if (response.status >= 500) {
      spinner?.fail(`Server error (${response.status})`)
      throw new CliError(
        `${message}\n\n` +
        `This is a server-side error. Try again in a moment.\n` +
        `If it persists, check the dashboard for run logs or try a different provider.`
      )
    }

    spinner?.fail(`Run failed: ${message}`)
    throw new CliError(message)
  }

  spinner?.succeed(`Ran ${org}/${parsed.agent}@${parsed.version}`)

  if (!options.json && isPaidAgent(agentMeta) && pricingInfo?.price_cents && pricingInfo.price_cents > 0) {
    process.stderr.write(`\nCost: $${(pricingInfo.price_cents / 100).toFixed(2)} USD\n`)
  }

  const inputType =
    filePaths.length > 0
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

  // Download agent definition with spinner
  const agentData = await withSpinner(
    `Downloading ${org}/${parsed.agent}@${parsed.version}...`,
    async () => {
      try {
        return await downloadAgent(resolved, org, parsed.agent, parsed.version)
      } catch (err) {
        const agentMeta = await getPublicAgent(resolved, org, parsed.agent, parsed.version)
        return {
          type: agentMeta.type || 'tool',
          name: agentMeta.name,
          version: agentMeta.version,
          description: agentMeta.description || undefined,
          supported_providers: agentMeta.supported_providers || ['any'],
        } as AgentDownload
      }
    },
    { successText: `Downloaded ${org}/${parsed.agent}@${parsed.version}` }
  )

  // Skills cannot be run directly
  if (agentData.type === 'skill') {
    throw new CliError(
      'Skills cannot be run directly.\n\n' +
      'Skills are instructions meant to be injected into AI agent contexts.\n\n' +
      'Options:\n' +
      `  Install for AI tools:  orchagent skill install ${org}/${parsed.agent}\n` +
      `  Use with an agent:     orchagent run <agent> --skills ${org}/${parsed.agent}`
    )
  }

  // Agent type requires a sandbox — cannot run locally
  if (agentData.type === 'agent') {
    throw new CliError(
      'Agent type cannot be run locally.\n\n' +
      'Agent type requires a sandbox environment with tool use capabilities.\n\n' +
      'Remove the --local flag to run in the cloud:\n' +
      `  orch run ${org}/${parsed.agent}@${parsed.version} --data '{"task": "..."}'`
    )
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

  if (agentData.type === 'tool') {
    if (agentData.has_bundle) {
      if (options.downloadOnly) {
        process.stdout.write(`\nTool has bundle available for local execution.\n`)
        process.stdout.write(`Run with: orch run ${org}/${parsed.agent} --local [args...]\n`)
        return
      }

      await executeBundleAgent(resolved, org, parsed.agent, parsed.version, agentData, args, options.input)
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

    // Fallback: agent doesn't support local execution
    process.stdout.write(`\nThis is a tool-based agent that runs on the server.\n`)
    process.stdout.write(`\nRun without --local: orch run ${org}/${parsed.agent}@${parsed.version} --data '{...}'\n`)
    return
  }

  if (options.downloadOnly) {
    process.stdout.write(`\nAgent downloaded. Run with:\n`)
    process.stdout.write(`  orch run ${org}/${parsed.agent}@${parsed.version} --local --input '{...}'\n`)
    return
  }

  // For prompt-based agents, execute locally
  if (!options.input) {
    process.stdout.write(`\nPrompt-based agent ready.\n`)
    process.stdout.write(`Run with: orch run ${org}/${parsed.agent}@${parsed.version} --local --input '{...}'\n`)
    return
  }

  let inputData: Record<string, unknown>
  try {
    inputData = JSON.parse(options.input) as Record<string, unknown>
  } catch {
    throw new CliError('Invalid JSON input')
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
  skills?: string
  skillsOnly?: string
  noSkills?: boolean
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
}

export function registerRunCommand(program: Command): void {
  program
    .command('run <agent> [file]')
    .description('Run an agent (cloud by default, --local for local execution)')
    .option('--local', 'Run locally instead of on the server')
    .option('--data <json>', 'JSON payload (string or @file, @- for stdin)')
    .option('--input <json>', 'Alias for --data')
    .option('--json', 'Output raw JSON')
    .option('--provider <provider>', 'LLM provider (openai, anthropic, gemini, ollama)')
    .option('--model <model>', 'LLM model to use (overrides agent default)')
    .option('--key <key>', 'LLM API key (overrides env vars)')
    .option('--skills <skills>', 'Add skills (comma-separated)')
    .option('--skills-only <skills>', 'Use only these skills')
    .option('--no-skills', 'Ignore default skills')
    // Cloud-only options
    .option('--endpoint <endpoint>', 'Override agent endpoint (cloud only)')
    .option('--tenant <tenant>', 'Tenant identifier for multi-tenant callers (cloud only)')
    .option('--output <file>', 'Save response body to a file (cloud only)')
    .option('--file <path...>', 'File(s) to upload (cloud only, can specify multiple)')
    .option('--file-field <field>', 'Schema field name for file content (cloud only)')
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
