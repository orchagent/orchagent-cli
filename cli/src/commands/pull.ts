import { Command } from 'commander'
import chalk from 'chalk'
import path from 'path'
import fs from 'fs/promises'
import os from 'os'
import { spawn } from 'child_process'

import { getResolvedConfig, loadConfig } from '../lib/config'
import {
  publicRequest,
  request,
  listMyAgents,
  getOrg,
  downloadCodeBundle,
  downloadCodeBundleAuthenticated,
  ApiError,
  resolveWorkspaceIdForOrg,
} from '../lib/api'
import { CliError } from '../lib/errors'
import { track } from '../lib/analytics'
import { printJson } from '../lib/output'

import type { ResolvedConfig, Agent } from '../types'

// ─── Types ──────────────────────────────────────────────────────────────────

type PullAgentRef = {
  org?: string
  agent: string
  version: string
}

type PullData = {
  name: string
  version: string
  description?: string
  type: string
  run_mode?: string | null
  execution_engine?: string | null
  runtime?: Record<string, unknown> | null
  loop?: Record<string, unknown> | null
  callable?: boolean
  prompt?: string
  input_schema?: object
  output_schema?: object
  dependencies?: Array<{ id: string; version: string }>
  supported_providers?: string[]
  default_models?: Record<string, string>
  tags?: string[]
  default_skills?: string[]
  skills_locked?: boolean
  source_url?: string
  pip_package?: string
  run_command?: string
  entrypoint?: string
  has_bundle?: boolean
  manifest?: Record<string, unknown>
  agentId?: string
  source: 'public_download' | 'owner_authenticated' | 'private_authenticated'
}

type PullResult = {
  success: boolean
  requested_ref: string
  resolved_ref: string
  output_dir: string
  engine: string
  source: string
  files_written: string[]
  bundle_extracted: boolean
  warnings: string[]
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parsePullRef(value: string): PullAgentRef {
  const [ref, versionPart] = value.split('@')
  const version = versionPart?.trim() || 'latest'
  const segments = ref.split('/')
  if (segments.length === 1) {
    return { agent: segments[0], version }
  }
  if (segments.length === 2) {
    return { org: segments[0], agent: segments[1], version }
  }
  throw new CliError('Invalid agent reference. Use org/agent[@version] or agent[@version] format.')
}

function canonicalType(typeValue: string | undefined): 'agent' | 'skill' {
  const normalized = (typeValue || 'agent').toLowerCase()
  return normalized === 'skill' ? 'skill' : 'agent'
}

function resolveEngine(data: PullData): 'direct_llm' | 'managed_loop' | 'code_runtime' {
  const ee = data.execution_engine
  if (ee === 'direct_llm' || ee === 'managed_loop' || ee === 'code_runtime') {
    return ee
  }
  const runtimeCommand = data.runtime?.command
  if (typeof runtimeCommand === 'string' && runtimeCommand.trim()) return 'code_runtime'
  if (data.loop && Object.keys(data.loop).length > 0) return 'managed_loop'
  const normalized = (data.type || '').toLowerCase()
  if (normalized === 'tool' || normalized === 'code') return 'code_runtime'
  if (normalized === 'agentic') return 'managed_loop'
  return 'direct_llm'
}

function commandForEntrypoint(entrypoint: string): string {
  if (
    entrypoint.endsWith('.js')
    || entrypoint.endsWith('.mjs')
    || entrypoint.endsWith('.cjs')
    || entrypoint.endsWith('.ts')
  ) {
    return `node ${entrypoint}`
  }
  return `python ${entrypoint}`
}

// ─── Agent Resolution ───────────────────────────────────────────────────────

async function resolveAgent(
  config: ResolvedConfig,
  org: string,
  agent: string,
  version: string,
  workspaceId?: string
): Promise<PullData> {
  // 1. Try public download endpoint
  try {
    const data = await publicRequest<Record<string, unknown>>(
      config,
      `/public/agents/${org}/${agent}/${version}/download`
    )
    return {
      name: data.name as string,
      version: data.version as string,
      description: data.description as string | undefined,
      type: (data.type as string) || 'agent',
      run_mode: data.run_mode as string | null | undefined,
      execution_engine: data.execution_engine as string | null | undefined,
      runtime: data.runtime as Record<string, unknown> | null | undefined,
      loop: data.loop as Record<string, unknown> | null | undefined,
      callable: data.callable as boolean | undefined,
      prompt: data.prompt as string | undefined,
      input_schema: data.input_schema as object | undefined,
      output_schema: data.output_schema as object | undefined,
      dependencies: data.dependencies as Array<{ id: string; version: string }> | undefined,
      supported_providers: data.supported_providers as string[] | undefined,
      default_models: data.default_models as Record<string, string> | undefined,
      default_skills: data.default_skills as string[] | undefined,
      skills_locked: data.skills_locked as boolean | undefined,
      source_url: data.source_url as string | undefined,
      pip_package: data.pip_package as string | undefined,
      run_command: data.run_command as string | undefined,
      entrypoint: data.entrypoint as string | undefined,
      has_bundle: data.has_bundle as boolean | undefined,
      source: 'public_download',
    }
  } catch (err) {
    // 2. Handle 403 (server-only / download-disabled)
    if (err instanceof ApiError && err.status === 403) {
      const payload = err.payload as any
      const errorCode = payload?.error?.code

      if (errorCode === 'PAID_AGENT_SERVER_ONLY' || errorCode === 'DOWNLOAD_DISABLED') {
        // Try authenticated owner path
        if (config.apiKey) {
          const ownerData = await tryOwnerFallback(config, org, agent, version, workspaceId)
          if (ownerData) return { ...ownerData, source: 'owner_authenticated' }
        }

        // Not owner - block with message
        if (errorCode === 'PAID_AGENT_SERVER_ONLY') {
          throw new CliError(
            `This agent is paid and runs on server only.\n\n` +
            `Use cloud execution: orch run ${org}/${agent}@${version} --data '{...}'`
          )
        }
        throw new CliError(
          `This agent is server-only and cannot be downloaded.\n\n` +
          `Use cloud execution: orch run ${org}/${agent}@${version} --data '{...}'`
        )
      }
    }

    // 3. Handle 404 - try private authenticated fallback
    if (!(err instanceof ApiError) || err.status !== 404) throw err
  }

  // 4. Private agent fallback (authenticated)
  if (!config.apiKey) {
    throw new ApiError(`Agent '${org}/${agent}@${version}' not found`, 404)
  }

  const userOrg = await getOrg(config, workspaceId)
  if (userOrg.slug !== org) {
    throw new ApiError(`Agent '${org}/${agent}@${version}' not found`, 404)
  }

  const data = await resolveFromMyAgents(config, agent, version, org, workspaceId)
  if (!data) {
    throw new ApiError(`Agent '${org}/${agent}@${version}' not found`, 404)
  }
  return { ...data, source: 'private_authenticated' }
}

async function tryOwnerFallback(
  config: ResolvedConfig,
  org: string,
  agent: string,
  version: string,
  workspaceId?: string
): Promise<Omit<PullData, 'source'> | null> {
  try {
    const myAgents = await listMyAgents(config, workspaceId)
    let match: Agent | undefined
    if (version === 'latest') {
      match = myAgents
        .filter(a => a.name === agent && a.org_slug === org)
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]
    } else {
      match = myAgents.find(a => a.name === agent && a.version === version && a.org_slug === org)
    }
    if (!match) return null

    const agentData = await request<Agent>(config, 'GET', `/agents/${match.id}`)
    return mapAgentToPullData(agentData)
  } catch {
    return null
  }
}

async function resolveFromMyAgents(
  config: ResolvedConfig,
  agent: string,
  version: string,
  org: string,
  workspaceId?: string
): Promise<Omit<PullData, 'source'> | null> {
  const agents = await listMyAgents(config, workspaceId)
  const matching = agents.filter(a => a.name === agent && a.org_slug === org)
  if (matching.length === 0) return null

  let target: Agent
  if (version === 'latest') {
    target = matching.sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )[0]
  } else {
    const found = matching.find(a => a.version === version)
    if (!found) return null
    target = found
  }

  const agentData = await request<Agent>(config, 'GET', `/agents/${target.id}`)
  return mapAgentToPullData(agentData)
}

function mapAgentToPullData(agent: Agent): Omit<PullData, 'source'> {
  return {
    name: agent.name,
    version: agent.version,
    description: agent.description,
    type: agent.type,
    run_mode: agent.run_mode ?? null,
    execution_engine: agent.execution_engine ?? null,
    runtime: (agent as Agent & { runtime?: Record<string, unknown> | null }).runtime ?? null,
    loop: (agent as Agent & { loop?: Record<string, unknown> | null }).loop ?? null,
    callable: agent.callable,
    prompt: agent.prompt,
    input_schema: agent.input_schema,
    output_schema: agent.output_schema,
    dependencies:
      ((agent.manifest as Record<string, unknown> | undefined)?.dependencies as Array<{ id: string; version: string }> | undefined),
    supported_providers: agent.supported_providers,
    default_models: agent.default_models,
    tags: agent.tags,
    default_skills: agent.default_skills,
    skills_locked: agent.skills_locked,
    source_url: agent.source_url,
    pip_package: agent.pip_package,
    run_command: agent.run_command,
    entrypoint: agent.entrypoint,
    has_bundle: !!agent.code_bundle_url,
    manifest: agent.manifest as Record<string, unknown> | undefined,
    agentId: agent.id,
  }
}

// ─── Manifest Reconstruction ────────────────────────────────────────────────

function buildManifest(data: PullData): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    name: data.name,
    description: data.description || '',
    type: canonicalType(data.type) === 'skill' ? 'skill' : 'agent',
  }

  if (data.run_mode) manifest.run_mode = data.run_mode
  if (data.callable !== undefined) manifest.callable = data.callable
  if (data.tags && data.tags.length > 0) manifest.tags = data.tags
  if (data.supported_providers && data.supported_providers.length > 0) {
    // Don't include if it's just ['any'] (the default)
    if (!(data.supported_providers.length === 1 && data.supported_providers[0] === 'any')) {
      manifest.supported_providers = data.supported_providers
    }
  }
  if (data.default_models && Object.keys(data.default_models).length > 0) {
    manifest.default_models = data.default_models
  }

  // Skills
  if (data.default_skills && data.default_skills.length > 0) {
    manifest.default_skills = data.default_skills
  }
  if (data.skills_locked !== undefined && data.skills_locked) {
    manifest.skills_locked = true
  }

  // Engine-specific fields
  const engine = resolveEngine(data)

  if (engine === 'code_runtime') {
    const runtime =
      (data.runtime && typeof data.runtime === 'object' && Object.keys(data.runtime).length > 0)
        ? { ...data.runtime }
        : undefined
    const runtimeCommand =
      (typeof runtime?.command === 'string' && runtime.command.trim())
        ? runtime.command
        : (data.run_command?.trim()
          || (data.entrypoint ? commandForEntrypoint(data.entrypoint) : undefined))
    if (runtimeCommand) {
      manifest.runtime = { ...(runtime || {}), command: runtimeCommand }
    }
    if (data.entrypoint && data.entrypoint !== 'sandbox_main.py') {
      manifest.entrypoint = data.entrypoint
    }
    if (data.source_url) manifest.source_url = data.source_url
    if (data.pip_package) manifest.pip_package = data.pip_package
    if (data.run_command) manifest.run_command = data.run_command
  }

  if (engine === 'managed_loop') {
    const loop =
      (data.loop && typeof data.loop === 'object' && Object.keys(data.loop).length > 0)
        ? { ...data.loop }
        : undefined
    if (loop) {
      manifest.loop = loop
      const loopCustomTools = loop.custom_tools
      if (Array.isArray(loopCustomTools) && loopCustomTools.length > 0) {
        manifest.custom_tools = loopCustomTools
      }
      const loopMaxTurns = loop.max_turns
      if (typeof loopMaxTurns === 'number') {
        manifest.max_turns = loopMaxTurns
      }
    }
  }

  // Include orchestration manifest if present (for dependencies, etc.)
  if (data.manifest && typeof data.manifest === 'object') {
    const m = { ...data.manifest }
    if (
      data.dependencies
      && data.dependencies.length > 0
      && (!Array.isArray((m as { dependencies?: unknown }).dependencies)
      || (m as { dependencies?: unknown[] }).dependencies?.length === 0)
    ) {
      ;(m as { dependencies: Array<{ id: string; version: string }> }).dependencies = data.dependencies
    }
    // Clean up fields that are already top-level
    delete m.runtime
    delete m.loop
    if (Object.keys(m).length > 0) {
      manifest.manifest = m
    }
  } else if (data.dependencies && data.dependencies.length > 0) {
    manifest.manifest = { dependencies: data.dependencies }
  }

  return manifest
}

// ─── Bundle Download + Extraction ───────────────────────────────────────────

async function downloadBundle(
  config: ResolvedConfig,
  org: string,
  agent: string,
  version: string,
  agentId?: string
): Promise<Buffer | null> {
  try {
    return await downloadCodeBundle(config, org, agent, version)
  } catch (err) {
    if (!(err instanceof ApiError)) throw err
    if (err.status !== 404 && !(err.status === 403 && config.apiKey && agentId)) {
      throw err
    }
  }

  if (config.apiKey && agentId) {
    try {
      return await downloadCodeBundleAuthenticated(config, agentId)
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 404) throw err
    }
  }

  return null
}

async function unzipBundle(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('unzip', ['-q', zipPath, '-d', destDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stderr = ''
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    proc.on('close', (code) => {
      if (code !== 0) {
        const detail = stderr.trim() || `exit code ${code}`
        reject(new CliError(`Failed to extract bundle: ${detail}`))
      } else {
        resolve()
      }
    })

    proc.on('error', (err) => {
      reject(new CliError(`Failed to run unzip: ${err.message}. Make sure unzip is installed.`))
    })
  })
}

// ─── Command ────────────────────────────────────────────────────────────────

export function registerPullCommand(program: Command): void {
  program
    .command('pull <agent>')
    .description('Pull a published agent into a local project directory')
    .option('-o, --output <path>', 'Output directory (default: ./<agent-name>/)')
    .option('--overwrite', 'Replace existing output directory contents')
    .option('--json', 'Print machine-readable result summary')
    .addHelpText('after', `
Examples:
  orch pull acme/my-agent
  orch pull acme/my-agent@v2
  orch pull my-agent --output ./custom-dir
  orch pull acme/my-agent --overwrite
  orch pull acme/my-agent --json
`)
    .action(async (agentRef: string, options: { output?: string; overwrite?: boolean; json?: boolean }) => {
      const write = (message: string) => {
        if (!options.json) process.stdout.write(message)
      }

      const config = await getResolvedConfig()
      const parsed = parsePullRef(agentRef)

      // Resolve org from workspace / defaultOrg fallback
      const configFile = await loadConfig()
      const org = parsed.org ?? configFile.workspace ?? config.defaultOrg
      if (!org) {
        throw new CliError(
          'Missing org. Use org/agent[@version] format, or set a default org with:\n' +
          '  orch config set default-org <org>'
        )
      }

      // Resolve workspace context for the target org
      const workspaceId = await resolveWorkspaceIdForOrg(config, org)

      write(`Resolving ${org}/${parsed.agent}@${parsed.version}...\n`)

      // Resolve agent data
      const data = await resolveAgent(config, org, parsed.agent, parsed.version, workspaceId)

      // Reject skills
      if (canonicalType(data.type) === 'skill') {
        throw new CliError("This is a skill. Use 'orch skill install <ref>' instead.")
      }

      // Resolve output path
      const outputDir = path.resolve(options.output || `./${data.name}`)

      // Check if output path already exists
      try {
        const stat = await fs.stat(outputDir)
        if (stat.isFile()) {
          throw new CliError(`Output path '${outputDir}' is a file. Please specify a directory.`)
        }
        if (!options.overwrite) {
          throw new CliError(
            `Output directory '${outputDir}' already exists.\n` +
            `Use --overwrite to replace its contents.`
          )
        }
        // Overwrite: clear and recreate
        await fs.rm(outputDir, { recursive: true })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          if (err instanceof CliError) throw err
          throw err
        }
      }

      await fs.mkdir(outputDir, { recursive: true })

      const engine = resolveEngine(data)
      const filesWritten: string[] = []
      const warnings: string[] = []
      let bundleExtracted = false

      // Write orchagent.json
      const manifest = buildManifest(data)
      await fs.writeFile(
        path.join(outputDir, 'orchagent.json'),
        JSON.stringify(manifest, null, 2) + '\n'
      )
      filesWritten.push('orchagent.json')

      // Write prompt.md (for prompt-driven engines)
      if (data.prompt && (engine === 'direct_llm' || engine === 'managed_loop')) {
        await fs.writeFile(path.join(outputDir, 'prompt.md'), data.prompt)
        filesWritten.push('prompt.md')
      }

      // Write schema.json (if schemas exist)
      if (data.input_schema || data.output_schema) {
        const schema: Record<string, object> = {}
        if (data.input_schema) schema.input = data.input_schema
        if (data.output_schema) schema.output = data.output_schema
        await fs.writeFile(
          path.join(outputDir, 'schema.json'),
          JSON.stringify(schema, null, 2) + '\n'
        )
        filesWritten.push('schema.json')
      }

      // Bundle download for code_runtime agents
      if (engine === 'code_runtime' && data.has_bundle) {
        write('Downloading code bundle...\n')
        const bundle = await downloadBundle(config, org, data.name, data.version, data.agentId)
        if (bundle) {
          const tempDir = path.join(os.tmpdir(), `orchagent-pull-${Date.now()}`)
          const zipPath = path.join(tempDir, 'bundle.zip')
          try {
            await fs.mkdir(tempDir, { recursive: true })
            await fs.writeFile(zipPath, bundle)
            await unzipBundle(zipPath, outputDir)
            bundleExtracted = true
            write('Bundle extracted.\n')
          } finally {
            await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
          }
        } else {
          warnings.push('No downloadable bundle available for this version.')
        }
      } else if (engine === 'code_runtime' && !data.has_bundle) {
        warnings.push('No downloadable bundle available for this version.')
      }

      // Track analytics
      await track('cli_pull', {
        org,
        agent: parsed.agent,
        version: data.version,
        engine,
        source: data.source,
      })

      // Output
      const resolvedRef = `${org}/${data.name}@${data.version}`

      if (options.json) {
        const result: PullResult = {
          success: true,
          requested_ref: `${org}/${parsed.agent}@${parsed.version}`,
          resolved_ref: resolvedRef,
          output_dir: outputDir,
          engine,
          source: data.source,
          files_written: filesWritten,
          bundle_extracted: bundleExtracted,
          warnings,
        }
        printJson(result)
        return
      }

      write(`\n${chalk.green('\u2713')} Pulled ${resolvedRef}\n`)
      write(`  Output: ${outputDir}\n`)
      write(`  Engine: ${engine}\n`)
      write(`  Files:  ${filesWritten.join(', ')}\n`)
      if (bundleExtracted) {
        write(`  Bundle: extracted\n`)
      }
      for (const w of warnings) {
        write(`  ${chalk.yellow('Warning:')} ${w}\n`)
      }
    })
}
