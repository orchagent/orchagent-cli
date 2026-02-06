import { Command } from 'commander'
import chalk from 'chalk'

import { getResolvedConfig } from '../lib/config'
import { listMyAgents } from '../lib/api'
import { printJson } from '../lib/output'
import { formatPrice, isPaidAgent } from '../lib/pricing'

export function registerAgentsCommand(program: Command): void {
  program
    .command('agents')
    .description('List your published agents')
    .option('--filter <text>', 'Filter by name')
    .option('--json', 'Output raw JSON')
    .action(async (options: { filter?: string; json?: boolean }) => {
      const config = await getResolvedConfig()
      const agents = await listMyAgents(config)

      // Apply filter if provided
      const filteredAgents = options.filter
        ? agents.filter(a => a.name.toLowerCase().includes(options.filter!.toLowerCase()))
        : agents

      if (options.json) {
        printJson(filteredAgents)
        return
      }

      if (filteredAgents.length === 0) {
        process.stdout.write(options.filter
          ? `No agents found matching "${options.filter}"\n`
          : 'No agents published yet.\n\nPublish an agent: orch publish\n'
        )
        return
      }

      // Print table with pricing
      const Table = (await import('cli-table3')).default
      const table = new Table({
        head: [
          chalk.bold('Agent'),
          chalk.bold('Version'),
          chalk.bold('Type'),
          chalk.bold('Stars'),
          chalk.bold('Price'),
          chalk.bold('Description'),
        ],
      })

      filteredAgents.forEach((agent) => {
        const name = agent.name
        const version = agent.version
        const type = agent.type || 'code'
        const stars = agent.stars_count ?? 0
        const price = formatPrice(agent)
        const coloredPrice = isPaidAgent(agent) ? chalk.yellow(price) : chalk.green(price)
        const desc = agent.description
          ? agent.description.length > 60
            ? agent.description.slice(0, 57) + '...'
            : agent.description
          : '-'

        table.push([name, version, type, stars.toString(), coloredPrice, desc])
      })

      process.stdout.write(`${table.toString()}\n`)
      process.stdout.write(`\nTotal: ${filteredAgents.length} agent${filteredAgents.length === 1 ? '' : 's'}\n`)
    })
}
