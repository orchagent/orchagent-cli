import Table from 'cli-table3'
import chalk from 'chalk'

import type { PublicAgent } from '../types'
import { formatPrice, isPaidAgent } from './pricing'

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

export function printAgentsTable(agents: PublicAgent[]): void {
  const table = new Table({
    head: [
      chalk.bold('Agent'),
      chalk.bold('Type'),
      chalk.bold('Providers'),
      chalk.bold('Stars'),
      chalk.bold('Price'),
      chalk.bold('Description'),
    ],
  })

  agents.forEach((agent) => {
    const fullName = `${agent.org_slug}/${agent.name}`
    const type = agent.type || 'code'
    const providers = formatProviders(agent.supported_providers)
    const stars = agent.stars_count ?? 0
    const price = formatPrice(agent)
    const priceColored = isPaidAgent(agent) ? chalk.yellow(price) : chalk.green(price)
    const desc = agent.description
      ? agent.description.length > 30
        ? agent.description.slice(0, 27) + '...'
        : agent.description
      : '-'

    table.push([fullName, type, providers, stars.toString(), priceColored, desc])
  })

  process.stdout.write(`${table.toString()}\n`)
}

function formatProviders(providers?: string[]): string {
  if (!providers || providers.length === 0 || providers.includes('any')) {
    return chalk.green('any')
  }
  return providers.map(p => {
    if (p === 'openai') return chalk.cyan('openai')
    if (p === 'anthropic') return chalk.magenta('anthropic')
    if (p === 'gemini') return chalk.yellow('gemini')
    return p
  }).join(', ')
}
