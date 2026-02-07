import { Command } from 'commander'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { spawn } from 'child_process'

import { getResolvedConfig, loadConfig } from '../lib/config'
import { getPublicAgent, publicRequest, downloadCodeBundle, ApiError, getOrg, listMyAgents, downloadCodeBundleAuthenticated, request } from '../lib/api'
import { CliError, jsonInputError } from '../lib/errors'
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
              // Convert Agent to AgentDownload format
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
            `Use: orch call ${org}/${agent}@${version} --input '{...}'`
          )
        } else {
          throw new CliError(
            `This agent is server-only and cannot be downloaded.\n\n` +
            `Use: orch call ${org}/${agent}@${version} --input '{...}'`
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

  // Convert Agent to AgentDownload format
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
  // Try public endpoint first
  try {
    return await downloadCodeBundle(config, org, agentName, version)
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 404) throw err
  }

  // Fallback to authenticated endpoint
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
      // Agent not found or not downloadable
      results.push({ dep, downloadable: false })
    }
  }

  return results
}

async function promptUserForDeps(depStatuses: DepStatus[]): Promise<'server' | 'local' | 'cancel'> {
  // In non-interactive mode (CI, piped input), skip deps by default and let agent run
  if (!process.stdin.isTTY) {
    process.stderr.write('Non-interactive mode: skipping dependencies (use --with-deps to include them).\n')
    return 'local'  // Skip deps, let agent run
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
  process.stderr.write('  [1] Run on server (orch call) - recommended\n')
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
        // Save the dependency metadata locally
        await saveAgentLocally(org, agent, status.agentData!)

        // For bundle-based agents, also extract the bundle
        if (status.agentData!.has_bundle) {
          await saveBundleLocally(config, org, agent, status.dep.version, status.agentData!.id)
        }

        // Install if it's a pip/source tool agent
        if (status.agentData!.type === 'tool' && (status.agentData!.source_url || status.agentData!.pip_package)) {
          await installTool(status.agentData!)
        }
      },
      { successText: `Downloaded ${depRef}` }
    )

    // Download default skills
    const defaultSkills = (status.agentData as AgentDownload & { default_skills?: string[] }).default_skills || []
    for (const skillRef of defaultSkills) {
      try {
        await downloadSkillDependency(config, skillRef, org)
      } catch {
        // Skill download failed - not critical, continue
        process.stderr.write(`  Warning: Failed to download skill ${skillRef}\n`)
      }
    }

    // Recursively download its dependencies
    if (status.agentData.dependencies && status.agentData.dependencies.length > 0) {
      const nestedStatuses = await checkDependencies(config, status.agentData.dependencies)
      await downloadDependenciesRecursively(config, nestedStatuses, visited)
    }
  }
}

/**
 * Detect all available LLM providers from environment and server.
 * Returns array of provider configs for fallback support.
 */
async function detectAllLlmKeys(
  supportedProviders: LlmProvider[],
  config?: ResolvedConfig
): Promise<ProviderConfig[]> {
  const providers: ProviderConfig[] = []
  const seen = new Set<string>()

  // Check environment variables for all providers
  for (const provider of supportedProviders) {
    if (provider === 'any') {
      // Check all known providers
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

  // Also check server keys if available
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
  // If provider override specified, validate and use only that provider
  if (providerOverride) {
    validateProvider(providerOverride)
  }

  // Determine which providers to check for keys
  const providersToCheck = providerOverride
    ? [providerOverride as LlmProvider]
    : (agentData.supported_providers as LlmProvider[])

  // Combine skill prompts with agent prompt (skills first, then agent)
  let basePrompt = agentData.prompt || ''
  if (skillPrompts.length > 0) {
    basePrompt = [...skillPrompts, basePrompt].join('\n\n---\n\n')
  }

  // Build the prompt with input data (matches server behavior)
  const prompt = buildPrompt(basePrompt, inputData)

  // When no provider override, detect all available providers for fallback support
  if (!providerOverride) {
    const allProviders = await detectAllLlmKeys(providersToCheck, config)

    if (allProviders.length === 0) {
      const providers = providersToCheck.join(', ')
      throw new CliError(
        `No LLM key found for: ${providers}\n` +
        `Set an environment variable (e.g., OPENAI_API_KEY), run 'orchagent keys add <provider>', or configure in web dashboard`
      )
    }

    // Warn if --model specified without --provider and multiple providers available
    if (modelOverride && !providerOverride && allProviders.length > 1) {
      process.stderr.write(
        `Warning: --model specified without --provider. The model '${modelOverride}' will be used for all ${allProviders.length} fallback providers, which may cause errors if the model is incompatible.\n` +
        `Consider specifying --provider to ensure correct model/provider pairing.\n\n`
      )
    }

    // Apply agent default models to each provider config
    const providersWithModels = allProviders.map((p) => ({
      ...p,
      model: modelOverride || p.model || agentData.default_models?.[p.provider] || getDefaultModel(p.provider),
    }))

    // Show which provider is being used (primary)
    const primary = providersWithModels[0]
    const spinnerText = providersWithModels.length > 1
      ? `Running with ${primary.provider} (${primary.model}), ${providersWithModels.length - 1} fallback(s) available...`
      : `Running with ${primary.provider} (${primary.model})...`

    // Use fallback if multiple providers, otherwise single call
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

  // Provider override: use single provider (existing behavior)
  const detected = await detectLlmKey(providersToCheck, config)

  if (!detected) {
    const providers = providersToCheck.join(', ')
    throw new CliError(
      `No LLM key found for: ${providers}\n` +
      `Set an environment variable (e.g., OPENAI_API_KEY), run 'orchagent keys add <provider>', or configure in web dashboard`
    )
  }

  const { provider, key, model: serverModel } = detected
  // Priority: CLI override > server config model > agent default model > hardcoded default
  const model = modelOverride || serverModel || agentData.default_models?.[provider] || getDefaultModel(provider)

  // Call the LLM with spinner
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

    // Fetch skill metadata
    const skillMeta = await publicRequest<PublicAgent>(
      config,
      `/public/agents/${org}/${parsed.skill}/${parsed.version}`
    )

    // Verify it's a skill
    const skillType = skillMeta.type as string | undefined
    if (skillType !== 'skill') {
      throw new CliError(`${org}/${parsed.skill} is not a skill (type: ${skillType || 'prompt'})`)
    }

    // Get the skill prompt (need to download for full content)
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
      'Use `orch call` to run it on the server instead.'
    )
  }

  // Check if already installed (for pip packages)
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
      'Use `orch call` to run it on the server instead.'
    )
  }

  // Install the agent if needed
  await installTool(agentData)

  // Parse the run command and append user args
  const [cmd, ...cmdArgs] = agentData.run_command.split(' ')
  const fullArgs = [...cmdArgs, ...args]

  process.stderr.write(`\nRunning: ${cmd} ${fullArgs.join(' ')}\n\n`)
  const { code } = await runCommand(cmd, fullArgs)

  if (code !== 0) {
    process.exit(code)
  }
}

async function unzipBundle(zipPath: string, destDir: string): Promise<void> {
  // Use spawn with array arguments to avoid shell injection
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
  // Capture the user's working directory before we change anything
  const userCwd = process.cwd()
  // Create temp directory for the bundle
  const tempDir = path.join(os.tmpdir(), `orchagent-${agentName}-${Date.now()}`)
  await fs.mkdir(tempDir, { recursive: true })

  const bundleZip = path.join(tempDir, 'bundle.zip')
  const extractDir = path.join(tempDir, 'agent')

  try {
    // Download the bundle with spinner
    const bundleBuffer = await withSpinner(
      `Downloading ${org}/${agentName}@${version} bundle...`,
      async () => {
        const buffer = await downloadBundleWithFallback(config, org, agentName, version, agentData.id)
        await fs.writeFile(bundleZip, buffer)
        return buffer
      },
      { successText: (buf) => `Downloaded bundle (${buf.length} bytes)` }
    )

    // Extract the bundle with spinner
    await fs.mkdir(extractDir, { recursive: true })
    await withSpinner(
      'Extracting bundle...',
      async () => {
        await unzipBundle(bundleZip, extractDir)
      },
      { successText: 'Bundle extracted' }
    )

    // Check if requirements.txt exists and install dependencies
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
      // requirements.txt doesn't exist, skip installation
    }

    // Determine entrypoint
    const entrypoint = agentData.entrypoint || 'sandbox_main.py'
    const entrypointPath = path.join(extractDir, entrypoint)

    // Verify entrypoint exists
    try {
      await fs.access(entrypointPath)
    } catch {
      throw new CliError(`Entrypoint not found: ${entrypoint}`)
    }

    // Build input JSON from --input option or positional args
    let inputJson = '{}'
    if (inputOption) {
      // --input was provided, use it directly (should be valid JSON)
      try {
        // Parse and re-stringify to validate JSON
        const parsed = JSON.parse(inputOption)
        // Resolve any relative paths in the input to absolute paths
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
      // Resolve to absolute path relative to user's working directory
      const resolvedArg = path.isAbsolute(firstArg) ? firstArg : path.resolve(userCwd, firstArg)
      // Check if it's a file path
      try {
        const stat = await fs.stat(resolvedArg)
        if (stat.isFile()) {
          // Read file content as input
          const fileContent = await fs.readFile(resolvedArg, 'utf-8')
          // Check if it's already JSON
          try {
            JSON.parse(fileContent)
            inputJson = fileContent
          } catch {
            // Wrap as file_path in JSON (use absolute path)
            inputJson = JSON.stringify({ file_path: resolvedArg })
          }
        } else if (stat.isDirectory()) {
          // Pass directory path (use absolute path)
          inputJson = JSON.stringify({ directory: resolvedArg })
        }
      } catch {
        // Not a file, check if it's JSON
        try {
          JSON.parse(firstArg)
          inputJson = firstArg
        } catch {
          // Treat as a simple string input (could be a URL)
          inputJson = JSON.stringify({ input: firstArg })
        }
      }
    }

    // Run the entrypoint with input via stdin
    process.stderr.write(`\nRunning: python3 ${entrypoint}\n\n`)

    // Pass auth credentials to subprocess for orchestrator agents calling sub-agents
    const subprocessEnv: Record<string, string | undefined> = { ...process.env }
    if (config.apiKey) {
      subprocessEnv.ORCHAGENT_SERVICE_KEY = config.apiKey
      subprocessEnv.ORCHAGENT_API_URL = config.apiUrl
    }

    // For orchestrator agents with dependencies, enable local execution mode
    if (agentData.dependencies && agentData.dependencies.length > 0) {
      subprocessEnv[LOCAL_EXECUTION_ENV] = 'true'
      subprocessEnv[AGENTS_DIR_ENV] = AGENTS_DIR

      // Initialize call chain with this agent
      const agentRef = `${org}/${agentName}@${version}`
      subprocessEnv[CALL_CHAIN_ENV] = agentRef

      // Set deadline from manifest timeout (default 120s)
      const manifest = agentData as AgentDownload & { manifest?: { timeout_ms?: number; max_hops?: number; per_call_downstream_cap?: number } }
      const timeoutMs = manifest.manifest?.timeout_ms || 120000
      subprocessEnv[DEADLINE_MS_ENV] = String(Date.now() + timeoutMs)

      // Set max hops from manifest (default 10)
      subprocessEnv[MAX_HOPS_ENV] = String(manifest.manifest?.max_hops || 10)

      // Set downstream cap
      subprocessEnv[DOWNSTREAM_REMAINING_ENV] = String(manifest.manifest?.per_call_downstream_cap || 100)
    }

    const proc = spawn('python3', [entrypointPath], {
      cwd: extractDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: subprocessEnv,
    })

    // Send input JSON via stdin
    proc.stdin.write(inputJson)
    proc.stdin.end()

    // Collect output
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

    // Handle output - check for errors in stdout even on failure
    if (stdout.trim()) {
      try {
        const result = JSON.parse(stdout.trim())

        // Check if it's an error response
        if (exitCode !== 0 && typeof result === 'object' && result !== null && 'error' in result) {
          throw new CliError(`Agent error: ${(result as { error: string }).error}`)
        }

        if (exitCode !== 0) {
          // Non-zero exit but output isn't an error object - show it and fail
          printJson(result)
          throw new CliError(`Agent exited with code ${exitCode}`)
        }

        // Success - print result
        printJson(result)
      } catch (err) {
        if (err instanceof CliError) throw err
        // Not JSON, print as-is
        process.stdout.write(stdout)
        if (exitCode !== 0) {
          throw new CliError(`Agent exited with code ${exitCode}`)
        }
      }
    } else if (exitCode !== 0) {
      // No stdout, check stderr
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
    // Clean up temp directory
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

  // Save metadata
  await fs.writeFile(
    path.join(agentDir, 'agent.json'),
    JSON.stringify(agentData, null, 2)
  )

  // For prompt agents, save the prompt
  if (agentData.type === 'prompt' && agentData.prompt) {
    await fs.writeFile(path.join(agentDir, 'prompt.md'), agentData.prompt)
  }

  // For tools, save files if provided
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

  // Check if already extracted with same version
  const metaPath = path.join(agentDir, 'agent.json')
  try {
    const existingMeta = await fs.readFile(metaPath, 'utf-8')
    const existing = JSON.parse(existingMeta)
    if (existing.version === version) {
      // Check if bundle dir exists
      try {
        await fs.access(bundleDir)
        return bundleDir // Already cached
      } catch {
        // Bundle dir doesn't exist, need to extract
      }
    }
  } catch {
    // Metadata doesn't exist, need to download
  }

  // Download and extract bundle
  const bundleBuffer = await withSpinner(
    `Downloading bundle for ${org}/${agent}@${version}...`,
    async () => downloadBundleWithFallback(config, org, agent, version, agentId),
    { successText: `Downloaded bundle for ${org}/${agent}@${version}` }
  )

  const tempZip = path.join(os.tmpdir(), `bundle-${Date.now()}.zip`)
  await fs.writeFile(tempZip, bundleBuffer)

  // Clean and recreate bundle directory
  try {
    await fs.rm(bundleDir, { recursive: true, force: true })
  } catch {
    // Directory might not exist
  }
  await fs.mkdir(bundleDir, { recursive: true })
  await unzipBundle(tempZip, bundleDir)

  // Clean up temp file
  try {
    await fs.rm(tempZip)
  } catch {
    // Ignore cleanup errors
  }

  return bundleDir
}

export function registerRunCommand(program: Command): void {
  program
    .command('run <agent> [args...]')
    .description('Download and run an agent locally')
    .option('--local', 'Run locally using local LLM keys (default for run command)')
    .option('--input <json>', 'JSON input data')
    .option('--data <json>', 'Alias for --input')
    .option('--download-only', 'Just download the agent, do not execute')
    .option('--with-deps', 'Automatically download all dependencies (skip prompt)')
    .option('--json', 'Output raw JSON')
    .option('--skills <skills>', 'Add skills (comma-separated)')
    .option('--skills-only <skills>', 'Use only these skills')
    .option('--no-skills', 'Ignore default skills')
    .option('--here', 'Scan current directory (passes absolute path to agent)')
    .option('--path <dir>', 'Shorthand for --input \'{"path": "<dir>"}\'')
    .option('--provider <name>', 'LLM provider to use (openai, anthropic, gemini, ollama)')
    .option('--model <model>', 'LLM model to use (overrides agent default)')
    .addHelpText('after', `
Examples:
  orch run orchagent/leak-finder --input '{"path": "."}'
  orch run orchagent/leak-finder --input '{"repo_url": "https://github.com/org/repo"}'
  orch run joe/summarizer --input '{"text": "Hello world"}'
  orch run orchagent/leak-finder --download-only

Note: Use 'run' for local execution, 'call' for server-side execution.

Paid Agents:
  Paid agents run on server only for non-owners.
  You CAN download and run your own paid agents for development/testing.

  For other users' paid agents, use 'orch call' instead.
`)
    .action(
      async (
        agentRef: string,
        args: string[],
        options: {
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
        }
      ) => {
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
              // Fall back to getting public agent info if download endpoint not available
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

        // Skills cannot be run directly - they're instructions to inject into agents
        if (agentData.type === 'skill') {
          throw new CliError(
            'Skills cannot be run directly.\n\n' +
            'Skills are instructions meant to be injected into AI agent contexts.\n\n' +
            'Options:\n' +
            `  Install for AI tools:  orchagent skill install ${org}/${parsed.agent}\n` +
            `  Use with an agent:     orchagent run <agent> --skills ${org}/${parsed.agent}`
          )
        }

        // Agent type requires a sandbox with tool use — cannot run locally
        if (agentData.type === 'agent') {
          throw new CliError(
            'Agent type cannot be run locally.\n\n' +
            'Agent type requires a sandbox environment with tool use capabilities.\n\n' +
            'Use server execution instead:\n' +
            `  orchagent call ${org}/${parsed.agent}@${parsed.version} --data '{"task": "..."}'`
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
            // Auto-download deps without prompting
            choice = 'local'
          } else {
            choice = await promptUserForDeps(depStatuses)
          }

          if (choice === 'cancel') {
            process.stderr.write('\nCancelled.\n')
            process.exit(0)
          }

          if (choice === 'server') {
            process.stderr.write(`\nUse server execution instead:\n`)
            process.stderr.write(`  orch call ${org}/${parsed.agent}@${parsed.version} --input '{...}'\n\n`)
            process.exit(0)
          }

          // choice === 'local' - download dependencies
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
          // Check if this agent has a bundle available for local execution
          if (agentData.has_bundle) {
            if (options.downloadOnly) {
              process.stdout.write(`\nTool has bundle available for local execution.\n`)
              process.stdout.write(`Run with: orch run ${org}/${parsed.agent} [args...]\n`)
              return
            }

            // Execute the bundle-based tool locally
            await executeBundleAgent(resolved, org, parsed.agent, parsed.version, agentData, args, options.input)
            return
          }

          // Check for pip/source-based local execution (legacy)
          if (agentData.run_command && (agentData.source_url || agentData.pip_package)) {
            if (options.downloadOnly) {
              process.stdout.write(`\nTool ready for local execution.\n`)
              process.stdout.write(`Run with: orch run ${org}/${parsed.agent} [args...]\n`)
              return
            }

            // Execute the tool locally
            await executeTool(agentData, args)
            return
          }

          // Fallback: agent doesn't support local execution
          process.stdout.write(`\nThis is a tool-based agent that runs on the server.\n`)
          process.stdout.write(`\nUse: orch call ${org}/${parsed.agent}@${parsed.version} --input '{...}'\n`)
          return
        }

        if (options.downloadOnly) {
          process.stdout.write(`\nAgent downloaded. Run with:\n`)
          process.stdout.write(`  orchagent run ${org}/${parsed.agent}@${parsed.version} --input '{...}'\n`)
          return
        }

        // For prompt-based agents, execute locally
        if (!options.input) {
          process.stdout.write(`\nPrompt-based agent ready.\n`)
          process.stdout.write(`Run with: orchagent run ${org}/${parsed.agent}@${parsed.version} --input '{...}'\n`)
          return
        }

        // Parse input
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
            // Use only the specified skills (ignore defaults)
            skillRefs.push(...options.skillsOnly.split(',').map((s) => s.trim()))
          } else {
            // Start with agent's default skills (if any)
            const defaultSkills = (agentData as AgentDownload & { default_skills?: string[] }).default_skills || []
            skillRefs.push(...defaultSkills)

            // Add any additional skills specified via --skills
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

        // Execute locally (the spinner is inside executePromptLocally)
        const result = await executePromptLocally(agentData, inputData, skillPrompts, resolved, options.provider, options.model)

        if (options.json) {
          printJson(result)
        } else {
          printJson(result)
        }
      }
    )
}
