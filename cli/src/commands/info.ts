import { Command } from 'commander'
import chalk from 'chalk'

import { getResolvedConfig } from '../lib/config'
import { publicRequest, ApiError, getOrg, listMyAgents, getPublicAgent } from '../lib/api'
import { parseAgentRef } from '../lib/agent-ref'
import { isPaidAgent, formatPrice } from '../lib/pricing'

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

type AgentDownload = {
  type: 'prompt' | 'tool' | 'skill' | 'agent'
  name: string
  version: string
  description?: string
  supported_providers: string[]
  source_url?: string
  run_command?: string
  url?: string
  input_schema?: Schema
  output_schema?: Schema
  sdk_compatible?: boolean
  prompt?: string
  pricing_mode?: 'free' | 'per_call' | null
  price_per_call_cents?: number | null
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

async function downloadAgentWithFallback(
  config: { apiKey?: string; apiUrl: string; defaultOrg?: string },
  org: string,
  agent: string,
  version: string
): Promise<AgentDownload> {
  // First fetch public metadata to get pricing fields
  let publicMeta: any = null
  try {
    publicMeta = await getPublicAgent(config, org, agent, version)
  } catch (err) {
    // If public metadata not found, continue to try download
    if (!(err instanceof ApiError) || err.status !== 404) {
      // Some other error, rethrow
      throw err
    }
  }

  // Try public download endpoint
  try {
    const downloadData = await publicRequest<AgentDownload>(
      config,
      `/public/agents/${org}/${agent}/${version}/download`
    )
    // Merge pricing fields from publicMeta if not present
    if (publicMeta && !downloadData.pricing_mode) {
      downloadData.pricing_mode = publicMeta.pricing_mode
      downloadData.price_per_call_cents = publicMeta.price_per_call_cents
    }
    return downloadData
  } catch (err) {
    // Handle 403 PAID_AGENT_SERVER_ONLY error
    if (err instanceof ApiError && err.status === 403) {
      const payload = err.payload as any
      if (payload?.error?.code === 'PAID_AGENT_SERVER_ONLY') {
        // For non-owners, use public metadata
        if (publicMeta) {
          return {
            type: publicMeta.type,
            name: publicMeta.name,
            version: publicMeta.version,
            description: publicMeta.description,
            supported_providers: publicMeta.supported_providers || ['any'],
            source_url: publicMeta.source_url,
            pricing_mode: publicMeta.pricing_mode,
            price_per_call_cents: publicMeta.price_per_call_cents,
          }
        }
      }
    }

    if (!(err instanceof ApiError) || err.status !== 404) throw err
  }

  // Fallback to authenticated endpoint for private agents
  if (!config.apiKey) {
    throw new ApiError(`Agent '${org}/${agent}@${version}' not found`, 404)
  }

  const userOrg = await getOrg(config as { apiKey: string; apiUrl: string })
  if (userOrg.slug !== org) {
    throw new ApiError(`Agent '${org}/${agent}@${version}' not found`, 404)
  }

  // Find agent in user's list and construct download data
  const agents = await listMyAgents(config as { apiKey: string; apiUrl: string })
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
    // Get most recent
    targetAgent = matching.sort((a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )[0]
  }

  // Convert Agent to AgentDownload format
  return {
    type: targetAgent.type,
    name: targetAgent.name,
    version: targetAgent.version,
    description: targetAgent.description,
    prompt: targetAgent.prompt,
    input_schema: targetAgent.input_schema as AgentDownload['input_schema'],
    output_schema: targetAgent.output_schema as AgentDownload['output_schema'],
    supported_providers: targetAgent.supported_providers || ['any'],
    source_url: targetAgent.source_url,
    run_command: targetAgent.run_command,
    url: targetAgent.url,
    sdk_compatible: false,
    pricing_mode: targetAgent.pricing_mode,
    price_per_call_cents: targetAgent.price_per_call_cents,
  }
}

export function registerInfoCommand(program: Command): void {
  program
    .command('info <agent>')
    .description('Show agent details including pricing, inputs, and outputs')
    .option('--json', 'Output as JSON')
    .action(async (agentArg: string, options: { json?: boolean }) => {
      const config = await getResolvedConfig()
      const { org, agent, version } = parseAgentRef(agentArg)

      // Fetch agent metadata
      const agentData = await downloadAgentWithFallback(config, org, agent, version)

      if (options.json) {
        // Don't expose internal routing URLs in JSON output
        const output = { ...agentData }
        if (output.url?.includes('.internal')) {
          delete output.url
        }
        process.stdout.write(JSON.stringify(output, null, 2) + '\n')
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
      process.stdout.write(`Providers: ${agentData.supported_providers.join(', ')}\n`)

      // Display pricing information
      const priceStr = formatPrice(agentData)
      const color = isPaidAgent(agentData) ? chalk.yellow : chalk.green
      process.stdout.write(`Price: ${color(priceStr)}\n`)

      // If paid, show server-only message for non-owners
      if (isPaidAgent(agentData)) {
        process.stdout.write(chalk.gray('Note: Paid agents run on server only (use orch call)\n'))
        process.stdout.write(chalk.gray('      Owners can still download for development/testing\n'))
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
