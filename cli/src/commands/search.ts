import { Command } from 'commander'

import { getResolvedConfig } from '../lib/config'
import { searchAgents, listPublicAgents } from '../lib/api'
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
    .option('--type <type>', 'Filter by type: agents, skills, all (default: all)', 'all')
    .option('--limit <n>', `Max results (default: ${DEFAULT_LIMIT})`, String(DEFAULT_LIMIT))
    .option('--free', 'Show only free agents')
    .option('--paid', 'Show only paid agents')
    .option('--json', 'Output raw JSON')
    .addHelpText('after', `
Pricing Filters:
  --free    Show only free agents
  --paid    Show only paid agents
`)
    .action(async (query: string | undefined, options: {
      popular?: boolean
      recent?: boolean
      type: string
      limit: string
      free?: boolean
      paid?: boolean
      json?: boolean
    }) => {
      const config = await getResolvedConfig()
      const limit = parseInt(options.limit, 10) || DEFAULT_LIMIT

      // Default to popular when no args
      if (!query && !options.popular && !options.recent) {
        options.popular = true
      }

      let agents
      if (query) {
        agents = await searchAgents(config, query)
        await track('cli_search', { query, type: options.type })
      } else {
        agents = await listPublicAgents(config)
        await track('cli_search', { mode: options.popular ? 'popular' : 'recent', type: options.type })
      }

      // Filter by type
      if (options.type === 'agents') {
        agents = agents.filter(a => a.type !== 'skill')
      } else if (options.type === 'skills') {
        agents = agents.filter(a => a.type === 'skill')
      }

      // Filter by pricing if requested
      if (options.free) {
        agents = agents.filter(a => !isPaidAgent(a))
      }
      if (options.paid) {
        agents = agents.filter(a => isPaidAgent(a))
      }

      // Sort results
      if (options.popular || (!query && !options.recent)) {
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
        process.stdout.write(query ? 'No results found matching your search.\n' : 'No public agents found.\n')
        process.stdout.write('\nBrowse all agents at: https://orchagent.io/explore\n')
        return
      }

      printAgentsTable(agents)

      if (agents.length === limit) {
        process.stdout.write(`\nShowing top ${limit} results. Use --limit <n> for more.\n`)
      }
      process.stdout.write('\nTip: Run "orchagent info <agent>" to see input schema and details.\n')
    })
}
