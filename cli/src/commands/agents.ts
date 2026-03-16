import { Command } from 'commander'
import chalk from 'chalk'

import { getResolvedConfig, loadConfig } from '../lib/config'
import { listMyAgents, resolveWorkspaceIdForOrg } from '../lib/api'
import { printJson } from '../lib/output'
import { parseFields, filterFields, applyLimitOffset, parseIntOption } from '../lib/list-options'
import type { Agent } from '../types'

/**
 * Given a list of agents, return only the latest version of each agent name.
 * "Latest" = highest created_at timestamp (most recently published).
 * Also returns the total version count per agent name for display.
 */
export function latestOnly(agents: Agent[]): { agents: Agent[]; versionCounts: Map<string, number> } {
  const byName = new Map<string, Agent[]>()
  for (const agent of agents) {
    const existing = byName.get(agent.name) ?? []
    existing.push(agent)
    byName.set(agent.name, existing)
  }

  const result: Agent[] = []
  const versionCounts = new Map<string, number>()

  for (const [name, versions] of byName) {
    versionCounts.set(name, versions.length)
    // Sort by created_at descending, take the first (latest)
    versions.sort((a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )
    result.push(versions[0])
  }

  // Sort final list alphabetically by name for stable output
  result.sort((a, b) => a.name.localeCompare(b.name))

  return { agents: result, versionCounts }
}

export function registerAgentsCommand(program: Command): void {
  program
    .command('agents')
    .description('List your published agents')
    .option('--filter <text>', 'Filter by name')
    .option('--all-versions', 'Show all versions (default: latest only)')
    .option('--json', 'Output raw JSON')
    .option('--fields <fields>', 'Comma-separated fields to include in JSON output (implies --json)')
    .option('--limit <n>', 'Maximum number of items to return')
    .option('--offset <n>', 'Number of items to skip')
    .action(async (options: { filter?: string; allVersions?: boolean; json?: boolean; fields?: string; limit?: string; offset?: string }) => {
      const config = await getResolvedConfig()

      // Resolve workspace context
      const configFile = await loadConfig()
      const orgSlug = configFile.workspace ?? config.defaultOrg
      const workspaceId = orgSlug ? await resolveWorkspaceIdForOrg(config, orgSlug) : undefined

      const agents = await listMyAgents(config, workspaceId)

      // Apply filter if provided
      const filteredAgents = options.filter
        ? agents.filter(a => a.name.toLowerCase().includes(options.filter!.toLowerCase()))
        : agents

      // Determine display set: latest-only (default) or all versions
      let displayAgents: Agent[]
      let versionCounts: Map<string, number> | undefined
      if (options.allVersions) {
        displayAgents = filteredAgents
      } else {
        const grouped = latestOnly(filteredAgents)
        displayAgents = grouped.agents
        versionCounts = grouped.versionCounts
      }

      // Apply client-side limit/offset
      const limit = parseIntOption(options.limit)
      const offset = parseIntOption(options.offset)
      if (limit != null || offset != null) {
        displayAgents = applyLimitOffset(displayAgents, limit, offset)
      }

      // --fields implies --json
      const useJson = options.json || !!options.fields

      if (useJson) {
        const fields = options.fields ? parseFields(options.fields) : undefined
        printJson(fields ? filterFields(displayAgents, fields) : displayAgents)
        return
      }

      if (displayAgents.length === 0) {
        process.stdout.write(options.filter
          ? `No agents found matching "${options.filter}"\n`
          : 'No agents published yet.\n\nPublish an agent: orch publish\n'
        )
        return
      }

      const Table = (await import('cli-table3')).default
      const table = new Table({
        head: [
          chalk.bold('Agent'),
          chalk.bold('Version'),
          chalk.bold('Type'),
          chalk.bold('Description'),
        ],
      })

      displayAgents.forEach((agent) => {
        const name = agent.name
        const type = agent.type || 'tool'
        const desc = agent.description
          ? agent.description.length > 60
            ? agent.description.slice(0, 57) + '...'
            : agent.description
          : '-'

        // In latest-only mode, show version count if > 1
        let version = agent.version
        if (!options.allVersions && versionCounts) {
          const count = versionCounts.get(agent.name) ?? 1
          if (count > 1) {
            version = `${agent.version} (${count} total)`
          }
        }

        table.push([name, version, type, desc])
      })

      process.stdout.write(`${table.toString()}\n`)

      if (options.allVersions) {
        process.stdout.write(`\nTotal: ${displayAgents.length} version${displayAgents.length === 1 ? '' : 's'}\n`)
      } else {
        const totalVersions = filteredAgents.length
        const agentCount = displayAgents.length
        process.stdout.write(`\n${agentCount} agent${agentCount === 1 ? '' : 's'}`)
        if (totalVersions > agentCount) {
          process.stdout.write(` (${totalVersions} versions total, use --all-versions to show all)`)
        }
        process.stdout.write('\n')
      }
    })
}
