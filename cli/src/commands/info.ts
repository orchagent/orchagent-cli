import { Command } from 'commander'
import chalk from 'chalk'

import { getResolvedConfig, loadConfig } from '../lib/config'
import { ApiError, getOrg, listMyAgents, getPublicAgent, resolveWorkspaceIdForOrg } from '../lib/api'
import { parseAgentRef } from '../lib/agent-ref'
import { CliError } from '../lib/errors'
import { parseFields, filterFields } from '../lib/list-options'
import type { AgentTypeValue } from '../types'

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

type EnvironmentPinning = {
  python_version?: string
  node_version?: string
  pip_flags?: string
  npm_flags?: string
}

export type AgentDownload = {
  type: AgentTypeValue
  name: string
  version: string
  description?: string
  supported_providers: string[]
  callable?: boolean
  source_url?: string
  run_command?: string
  url?: string
  input_schema?: Schema
  output_schema?: Schema
  sdk_compatible?: boolean
  prompt?: string
  // Dependency-related fields
  dependencies?: ManifestDependency[]
  default_skills?: string[]
  custom_tools?: CustomTool[]
  environment?: EnvironmentPinning
  // Secrets
  required_secrets?: string[]
  optional_secrets?: string[]
}

function formatSchema(schema: Schema, indent: string = '  '): string {
  const lines: string[] = []
  const props = schema.properties || {}
  const required = schema.required || []

  for (const [key, value] of Object.entries(props)) {
    let typeStr = value.type || 'any'
    if (typeStr === 'array' && value.items?.type) {
      typeStr = `${value.items.type}[]`
    }
    const reqMark = required.includes(key) ? '' : '?'
    let line = `${indent}${key}${reqMark}: ${typeStr}`
    if (value.description) {
      line += ` - ${value.description}`
    }
    lines.push(line)
  }

  return lines.join('\n')
}

function deriveReadmeUrl(sourceUrl: string): string | null {
  // Parse GitHub URLs like:
  // git+https://github.com/user/repo.git#subdirectory=path
  // https://github.com/user/repo

  const githubMatch = sourceUrl.match(
    /github\.com[/:]([^/]+)\/([^/.#]+)(?:\.git)?(?:#subdirectory=(.+))?/
  )

  if (!githubMatch) return null

  const [, user, repo, subdirectory] = githubMatch
  const path = subdirectory ? `${subdirectory}/README.md` : 'README.md'

  return `https://raw.githubusercontent.com/${user}/${repo}/main/${path}`
}

async function fetchReadme(url: string): Promise<string | null> {
  try {
    const response = await fetch(url)
    if (!response.ok) return null
    return await response.text()
  } catch {
    return null
  }
}

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

export async function getAgentInfo(
  config: { apiKey?: string; apiUrl: string; defaultOrg?: string },
  org: string,
  agent: string,
  version: string,
  workspaceId?: string
): Promise<AgentDownload> {
  // Use public metadata endpoint as primary source — never blocked by download restrictions
  try {
    const publicMeta = await getPublicAgent(config, org, agent, version)
    const meta = publicMeta as Record<string, unknown>
    const manifest = meta.manifest as Record<string, unknown> | undefined
    return {
      type: (publicMeta.type || 'tool') as AgentDownload['type'],
      name: publicMeta.name,
      version: publicMeta.version,
      description: (publicMeta.description ?? undefined) as string | undefined,
      supported_providers: publicMeta.supported_providers || ['any'],
      callable: publicMeta.callable ?? false,
      input_schema: publicMeta.input_schema as AgentDownload['input_schema'],
      output_schema: publicMeta.output_schema as AgentDownload['output_schema'],
      source_url: meta.source_url as string | undefined,
      run_command: meta.run_command as string | undefined,
      url: meta.url as string | undefined,
      dependencies: extractDependencies(manifest),
      default_skills: (meta.default_skills as string[] | undefined) || [],
      custom_tools: extractCustomTools(manifest),
      environment: manifest?.environment as EnvironmentPinning | undefined,
      required_secrets: (meta.required_secrets as string[] | undefined) || [],
      optional_secrets: (meta.optional_secrets as string[] | undefined) || [],
    }
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 404) throw err
  }

  // Fallback to authenticated endpoint for private agents
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

  const agentManifest = targetAgent.manifest as Record<string, unknown> | undefined
  return {
    type: targetAgent.type,
    name: targetAgent.name,
    version: targetAgent.version,
    description: targetAgent.description,
    prompt: targetAgent.prompt,
    callable: targetAgent.callable ?? false,
    input_schema: targetAgent.input_schema as AgentDownload['input_schema'],
    output_schema: targetAgent.output_schema as AgentDownload['output_schema'],
    supported_providers: targetAgent.supported_providers || ['any'],
    source_url: targetAgent.source_url,
    run_command: targetAgent.run_command,
    url: targetAgent.url,
    dependencies: extractDependencies(agentManifest),
    default_skills: targetAgent.default_skills || [],
    custom_tools: extractCustomTools(agentManifest),
    environment: agentManifest?.environment as EnvironmentPinning | undefined,
    required_secrets: targetAgent.required_secrets || [],
    optional_secrets: targetAgent.optional_secrets || [],
  }
}

export function registerInfoCommand(program: Command): void {
  program
    .command('info <agent>')
    .description('Show agent details including inputs and outputs')
    .option('--json', 'Output as JSON')
    .option('--fields <fields>', 'Comma-separated fields to include in JSON output (implies --json)')
    .action(async (agentArg: string, options: { json?: boolean; fields?: string }) => {
      const config = await getResolvedConfig()
      const parsed = parseAgentRef(agentArg)
      const configFile = await loadConfig()
      const org = parsed.org ?? configFile.workspace ?? config.defaultOrg
      if (!org) {
        throw new CliError('Missing org. Use org/agent format or set default org.')
      }
      const { agent, version } = parsed

      // Resolve workspace context for the target org
      const workspaceId = await resolveWorkspaceIdForOrg(config, org)

      // Fetch agent metadata
      const agentData = await getAgentInfo(config, org, agent, version, workspaceId)

      // --fields implies --json
      if (options.json || options.fields) {
        // Don't expose internal routing URLs in JSON output
        const output = { ...agentData }
        if (output.url?.includes('.internal')) {
          delete output.url
        }
        const fields = options.fields ? parseFields(options.fields) : undefined
        const data = fields ? filterFields(output, fields) : output
        process.stdout.write(JSON.stringify(data, null, 2) + '\n')
        return
      }

      // Display agent info
      process.stdout.write('\n')
      process.stdout.write(`${org}/${agent}@${version}\n`)
      process.stdout.write('='.repeat(40) + '\n\n')

      if (agentData.description) {
        process.stdout.write(`${agentData.description}\n\n`)
      }

      process.stdout.write(`Type: ${agentData.type}\n`)
      if (agentData.callable) {
        process.stdout.write(`Callable: ${chalk.green('yes')} — other agents can invoke this via the orchagent SDK\n`)
      }
      process.stdout.write(`Providers: ${agentData.supported_providers.join(', ')}\n`)

      // Display secrets
      const hasRequired = agentData.required_secrets && agentData.required_secrets.length > 0
      const hasOptional = agentData.optional_secrets && agentData.optional_secrets.length > 0
      if (hasRequired) {
        process.stdout.write(`Secrets (required): ${agentData.required_secrets!.join(', ')}\n`)
      }
      if (hasOptional) {
        process.stdout.write(`Secrets (optional): ${agentData.optional_secrets!.join(', ')}\n`)
      }

      if (agentData.type === 'tool') {
        // Don't show internal routing URLs - they confuse users
        if (agentData.url && !agentData.url.includes('.internal')) {
          process.stdout.write(`Server: ${agentData.url}\n`)
        }
        if (agentData.source_url) {
          process.stdout.write(`Source: ${agentData.source_url}\n`)
        }
        if (agentData.run_command) {
          process.stdout.write(`Run: ${agentData.run_command}\n`)
        }
        // Display SDK/Local Ready status
        if (agentData.sdk_compatible) {
          process.stdout.write(`Local Ready: yes (uses orchagent-sdk)\n`)
        }
      }

      // Display input schema if available
      if (agentData.input_schema?.properties && Object.keys(agentData.input_schema.properties).length > 0) {
        process.stdout.write('\nInput Schema:\n')
        process.stdout.write(formatSchema(agentData.input_schema) + '\n')
      }

      // Display output schema if available
      if (agentData.output_schema?.properties && Object.keys(agentData.output_schema.properties).length > 0) {
        process.stdout.write('\nOutput Schema:\n')
        process.stdout.write(formatSchema(agentData.output_schema) + '\n')
      }

      // Display dependencies
      const hasDeps = agentData.dependencies && agentData.dependencies.length > 0
      const hasSkills = agentData.default_skills && agentData.default_skills.length > 0
      const hasTools = agentData.custom_tools && agentData.custom_tools.length > 0

      if (hasDeps) {
        process.stdout.write('\nDependencies:\n')
        for (const dep of agentData.dependencies!) {
          process.stdout.write(`  ${chalk.cyan(dep.id)}@${dep.version}\n`)
        }
      }

      if (hasSkills) {
        process.stdout.write('\nSkills:\n')
        for (const skill of agentData.default_skills!) {
          process.stdout.write(`  ${chalk.yellow(skill)}\n`)
        }
      }

      if (hasTools) {
        process.stdout.write('\nCustom Tools:\n')
        for (const tool of agentData.custom_tools!) {
          let line = `  ${chalk.magenta(tool.name)}`
          if (tool.description) {
            line += ` — ${tool.description}`
          }
          process.stdout.write(line + '\n')
        }
      }

      // Display environment pinning
      if (agentData.environment) {
        const env = agentData.environment
        const parts: string[] = []
        if (env.python_version) parts.push(`Python ${env.python_version}`)
        if (env.node_version) parts.push(`Node ${env.node_version}`)
        if (env.pip_flags) parts.push(`pip flags: ${env.pip_flags}`)
        if (env.npm_flags) parts.push(`npm flags: ${env.npm_flags}`)
        if (parts.length) {
          process.stdout.write('\nEnvironment:\n')
          for (const part of parts) {
            process.stdout.write(`  ${part}\n`)
          }
        }
      }

      // Fetch and display README if available
      if (agentData.source_url) {
        const readmeUrl = deriveReadmeUrl(agentData.source_url)
        if (readmeUrl) {
          const readme = await fetchReadme(readmeUrl)
          if (readme) {
            process.stdout.write('\n' + '-'.repeat(40) + '\n')
            process.stdout.write('README\n')
            process.stdout.write('-'.repeat(40) + '\n\n')
            process.stdout.write(readme)
            process.stdout.write('\n')
          }
        }
      }
    })
}
