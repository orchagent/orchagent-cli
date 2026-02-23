import { Command } from 'commander'
import fs from 'fs/promises'
import path from 'path'

import { getResolvedConfig } from '../lib/config'
import { ApiError, getAgentWithFallback, resolveWorkspaceIdForOrg } from '../lib/api'
import { parseAgentRef } from '../lib/agent-ref'
import { CliError } from '../lib/errors'
import { track } from '../lib/analytics'
import { printJson } from '../lib/output'
import type { Agent, PublicAgent, ResolvedConfig } from '../types'
import {
  type OrchestrationDependency,
  buildOrchestrationCustomTools,
  buildOrchestrationManifest,
  buildOrchestrationPrompt,
  buildOrchestrationSchema,
  dedupeOrchestrationDependencies,
  dependencyRef,
  validateScaffoldAgentName,
} from '../lib/scaffold-orchestration'

type ScaffoldOptions = {
  profile?: string
  name?: string
  output?: string
  force?: boolean
  json?: boolean
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

function asCanonicalType(value: unknown): string {
  const normalized = String(value || 'agent').trim().toLowerCase()
  if (normalized === 'agentic') return 'agent'
  if (normalized === 'code') return 'tool'
  return normalized
}

function asObject(value: unknown): object | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as object
}

function formatDependencyNotFound(org: string, agent: string, version: string): string {
  return `Dependency agent not found: ${org}/${agent}@${version}`
}

function throwDependencyResolutionError(
  err: unknown,
  org: string,
  agent: string,
  version: string
): never {
  if (err instanceof ApiError) {
    if (err.status === 404) {
      throw new CliError(formatDependencyNotFound(org, agent, version))
    }
    if (err.status === 401) {
      throw new CliError(
        `Authentication required to resolve ${org}/${agent}@${version}. Run \`orch login\` first.`
      )
    }
    throw new CliError(
      `Failed to resolve ${org}/${agent}@${version}: ${err.message} (HTTP ${err.status})`
    )
  }
  throw err
}

function assertDependencyIsCallable(
  agent: PublicAgent | Agent,
  org: string,
  name: string,
  version: string
): void {
  const canonicalType = asCanonicalType(agent.type)
  if (canonicalType === 'skill') {
    throw new CliError(
      `Dependency ${org}/${name}@${version} is a skill. Skills are not callable agents.`
    )
  }
  if (agent.callable === false) {
    throw new CliError(
      `Dependency ${org}/${name}@${version} has callable: false and cannot be used for orchestration.`
    )
  }
}

async function resolveDependencies(
  config: ResolvedConfig,
  rawRefs: string[]
): Promise<{
  dependencies: OrchestrationDependency[]
  duplicates: string[]
}> {
  const workspaceByOrg = new Map<string, Promise<string | undefined>>()

  const workspaceForOrg = async (org: string): Promise<string | undefined> => {
    if (!workspaceByOrg.has(org)) {
      workspaceByOrg.set(
        org,
        resolveWorkspaceIdForOrg(config, org).catch(() => undefined)
      )
    }
    return workspaceByOrg.get(org)!
  }

  const resolved = await Promise.all(
    rawRefs.map(async (rawRef) => {
      const parsed = parseAgentRef(rawRef)
      const org = parsed.org || config.defaultOrg
      if (!org) {
        throw new CliError(
          `Missing org in '${rawRef}'. Use org/agent[@version] format or set default org with \`orch config set default_org <org>\`.`
        )
      }

      const workspaceId = await workspaceForOrg(org)
      let depAgent: PublicAgent | Agent
      try {
        depAgent = await getAgentWithFallback(
          config,
          org,
          parsed.agent,
          parsed.version,
          workspaceId
        )
      } catch (err) {
        throwDependencyResolutionError(err, org, parsed.agent, parsed.version)
      }

      const pinnedVersion = depAgent.version || parsed.version
      assertDependencyIsCallable(depAgent, org, parsed.agent, pinnedVersion)

      return {
        org,
        name: parsed.agent,
        version: pinnedVersion,
        description:
          typeof depAgent.description === 'string' ? depAgent.description : undefined,
        inputSchema: asObject(depAgent.input_schema),
      } satisfies OrchestrationDependency
    })
  )

  const deduped = dedupeOrchestrationDependencies(resolved)
  if (deduped.conflicts.length > 0) {
    const details = deduped.conflicts
      .map((conflict) => `- ${conflict.id}: ${conflict.versions.join(', ')}`)
      .join('\n')
    throw new CliError(
      `Conflicting dependency versions provided:\n${details}\nUse a single version per dependency.`
    )
  }

  return {
    dependencies: deduped.dependencies,
    duplicates: deduped.duplicates,
  }
}

async function ensureOutputDirectory(outputDir: string): Promise<void> {
  const exists = await fileExists(outputDir)
  if (!exists) {
    await fs.mkdir(outputDir, { recursive: true })
    return
  }

  const stat = await fs.stat(outputDir)
  if (!stat.isDirectory()) {
    throw new CliError(`Output path exists but is not a directory: ${outputDir}`)
  }
}

export function registerScaffoldCommand(program: Command): void {
  const scaffold = program
    .command('scaffold')
    .description('Scaffold projects from existing agents')
    .action(() => { scaffold.help() })

  scaffold
    .command('orchestration <agents...>')
    .description(
      'Generate a managed-loop orchestrator scaffold from published dependency agents'
    )
    .option('--profile <name>', 'Use API key from named profile')
    .option('--name <name>', 'Orchestrator name (default: output directory name)')
    .option('--output <dir>', 'Output directory (default: current directory)')
    .option('--force', 'Overwrite existing scaffold files')
    .option('--json', 'Print scaffold summary as JSON')
    .action(async (agents: string[], options: ScaffoldOptions) => {
      const config = await getResolvedConfig({}, options.profile)

      const outputDir = path.resolve(options.output || process.cwd())
      await ensureOutputDirectory(outputDir)

      const manifestName = (options.name || path.basename(outputDir)).trim()
      const nameErrors = validateScaffoldAgentName(manifestName)
      if (nameErrors.length > 0) {
        throw new CliError(nameErrors.join('\n'))
      }

      const manifestPath = path.join(outputDir, 'orchagent.json')
      const promptPath = path.join(outputDir, 'prompt.md')
      const schemaPath = path.join(outputDir, 'schema.json')
      const targetFiles = [manifestPath, promptPath, schemaPath]

      if (!options.force) {
        const existing = (
          await Promise.all(
            targetFiles.map(async (filePath) => (await fileExists(filePath) ? filePath : null))
          )
        ).filter((filePath): filePath is string => Boolean(filePath))

        if (existing.length > 0) {
          const rel = existing.map((f) => path.relative(outputDir, f))
          throw new CliError(
            `Refusing to overwrite existing files in ${outputDir}: ${rel.join(', ')}. Re-run with --force to overwrite.`
          )
        }
      }

      const { dependencies, duplicates } = await resolveDependencies(config, agents)
      if (dependencies.length === 0) {
        throw new CliError('No dependency agents were resolved.')
      }

      const customTools = buildOrchestrationCustomTools(dependencies)
      const manifest = buildOrchestrationManifest({
        name: manifestName,
        dependencies,
        customTools,
      })
      const prompt = buildOrchestrationPrompt({
        name: manifestName,
        dependencies,
        customTools,
      })
      const schema = buildOrchestrationSchema()

      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
      await fs.writeFile(promptPath, prompt)
      await fs.writeFile(schemaPath, JSON.stringify(schema, null, 2) + '\n')

      await track('cli_scaffold_orchestration', {
        dependency_count: dependencies.length,
        duplicates_removed: duplicates.length,
        output_custom: Boolean(options.output),
        force: Boolean(options.force),
        json: Boolean(options.json),
      })

      if (options.json) {
        printJson({
          name: manifestName,
          output_dir: outputDir,
          dependencies: dependencies.map((dep) => dependencyRef(dep)),
          custom_tools: customTools.map((tool) => tool.name),
          files: ['orchagent.json', 'prompt.md', 'schema.json'],
          duplicates_removed: duplicates,
        })
        return
      }

      process.stdout.write(`Scaffolded orchestrator "${manifestName}" in ${outputDir}\n`)
      process.stdout.write('\nDependencies:\n')
      for (const dep of dependencies) {
        process.stdout.write(`  - ${dependencyRef(dep)}\n`)
      }

      if (duplicates.length > 0) {
        process.stdout.write('\nRemoved duplicate dependency refs:\n')
        for (const dup of duplicates) {
          process.stdout.write(`  - ${dup}\n`)
        }
      }

      process.stdout.write('\nFiles written:\n')
      process.stdout.write('  - orchagent.json\n')
      process.stdout.write('  - prompt.md\n')
      process.stdout.write('  - schema.json\n')

      process.stdout.write('\nNext steps:\n')
      if (path.resolve(outputDir) !== path.resolve(process.cwd())) {
        process.stdout.write(`  1. cd ${outputDir}\n`)
        process.stdout.write('  2. Review prompt.md and schema.json\n')
        process.stdout.write('  3. Publish: orch publish\n')
      } else {
        process.stdout.write('  1. Review prompt.md and schema.json\n')
        process.stdout.write('  2. Publish: orch publish\n')
      }
    })
}
