import { Command } from 'commander'

import { getResolvedConfig } from '../lib/config'
import { searchAgents, listPublicAgents, searchMyAgents } from '../lib/api'
import { printAgentsTable, printJson } from '../lib/output'
import { track } from '../lib/analytics'
import { isPaidAgent } from '../lib/pricing'

const DEFAULT_LIMIT = 20

export function registerSearchCommand(program: Command): void {
  program
    .command('search')
    .description('Search for agents and skills')
    .argument('[query]', 'Search query (required unless using --popular or --recent)')
    .option('--popular', 'Show top agents/skills by stars')
    .option('--recent', 'Show most recently published')
    .option('--mine', 'Show only your own agents (including private)')
    .option('--type <type>', 'Filter by type: agents, skills, code, prompt, skill, all (default: all)', 'all')
    .option('--tags <tags>', 'Filter by tags (comma-separated, e.g., security,devops)')
    .option('--limit <n>', `Max results (default: ${DEFAULT_LIMIT})`, String(DEFAULT_LIMIT))
    .option('--free', 'Show only free agents')
    .option('--paid', 'Show only paid agents')
    .option('--json', 'Output raw JSON')
    .addHelpText('after', `
Pricing Filters:
  --free    Show only free agents
  --paid    Show only paid agents

Tag Filters:
  --tags security,devops    Show agents matching any of these tags

Ownership Filters:
  --mine    Show your own agents (public and private). Requires login.
`)
    .action(async (query: string | undefined, options: {
      popular?: boolean
      recent?: boolean
      mine?: boolean
      type: string
      tags?: string
      limit: string
      free?: boolean
      paid?: boolean
      json?: boolean
    }) => {
      const config = await getResolvedConfig()
      const limit = parseInt(options.limit, 10) || DEFAULT_LIMIT

      // Map type filter for API (null means no filter)
      const typeFilter = options.type === 'all' ? undefined : options.type
      const sort = options.popular ? 'stars' as const : options.recent ? 'recent' as const : undefined
      const tags = options.tags ? options.tags.split(',').map(t => t.trim()).filter(Boolean) : undefined

      let agents

      if (options.mine) {
        // --mine: search within user's own agents (public + private)
        if (!config.apiKey) {
          process.stderr.write('Error: --mine requires authentication. Run `orchagent login` first.\n')
          process.exitCode = 1
          return
        }
        agents = await searchMyAgents(config, query, { sort, type: typeFilter })
        await track('cli_search', { query, type: options.type, mine: true })
      } else {
        // Default to popular when no args
        if (!query && !options.popular && !options.recent) {
          options.popular = true
        }

        if (query) {
          agents = await searchAgents(config, query, { sort, tags, type: typeFilter })
          await track('cli_search', { query, type: options.type, tags: options.tags })
        } else {
          agents = await listPublicAgents(config, { sort, tags, type: typeFilter })
          await track('cli_search', { mode: options.popular ? 'popular' : 'recent', type: options.type, tags: options.tags })
        }
      }

      // Filter by pricing if requested
      if (options.free) {
        agents = agents.filter(a => !isPaidAgent(a))
      }
      if (options.paid) {
        agents = agents.filter(a => isPaidAgent(a))
      }

      // Sort results
      if (options.popular || (!query && !options.recent && !options.mine)) {
        agents.sort((a, b) => (b.stars_count ?? 0) - (a.stars_count ?? 0))
      } else if (options.recent) {
        agents.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
      }

      // Apply limit
      agents = agents.slice(0, limit)

      if (options.json) {
        printJson(agents)
        return
      }

      if (agents.length === 0) {
        if (options.mine) {
          process.stdout.write(query
            ? `No agents found matching "${query}" in your account.\n`
            : 'You have no published agents yet.\n')
          process.stdout.write('\nTip: Run "orchagent init" to create your first agent.\n')
        } else {
          process.stdout.write(query ? 'No results found matching your search.\n' : 'No public agents found.\n')
          process.stdout.write('\nBrowse all agents at: https://orchagent.io/explore\n')
        }
        return
      }

      printAgentsTable(agents, { showVisibility: options.mine })

      if (agents.length === limit) {
        process.stdout.write(`\nShowing top ${limit} results. Use --limit <n> for more.\n`)
      }
      if (options.mine) {
        process.stdout.write('\nTip: Run "orchagent info <agent>" to see details, or "orchagent delete <agent>" to remove.\n')
      } else {
        process.stdout.write('\nTip: Run "orchagent info <agent>" to see input schema and details.\n')
      }
    })
}
