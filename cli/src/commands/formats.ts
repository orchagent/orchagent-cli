import { Command } from 'commander'
import chalk from 'chalk'

import { adapterRegistry } from '../adapters'

export function registerFormatsCommand(program: Command): void {
  program
    .command('formats')
    .description('List available export formats for agents')
    .option('--json', 'Output raw JSON')
    .action(async (options: { json?: boolean }) => {
      const adapters = adapterRegistry.list()

      if (options.json) {
        const data = adapters.map(a => ({
          id: a.id,
          name: a.name,
          version: a.version,
          formatVersion: a.formatVersion,
          supportedTypes: a.supportedTypes,
          installPaths: a.installPaths,
        }))
        process.stdout.write(JSON.stringify(data, null, 2) + '\n')
        return
      }

      process.stdout.write('\nAvailable export formats:\n\n')

      for (const adapter of adapters) {
        process.stdout.write(`  ${chalk.cyan(adapter.id)}    ${adapter.name}\n`)
        const typeLabels = adapter.supportedTypes.map(t =>
          t === 'skill' ? 'skills' : `${t} agents`
        )
        process.stdout.write(`               Supports: ${typeLabels.join(', ')}\n`)
        process.stdout.write(`               Format version: ${adapter.formatVersion}\n`)

        for (const installPath of adapter.installPaths) {
          process.stdout.write(`               ${installPath.scope}: ${installPath.path}\n`)
        }
        process.stdout.write('\n')
      }

      process.stdout.write('Use with: orch install <agent> --format <id>\n')
      process.stdout.write('Set default: orch config set default-format <ids>\n\n')
    })
}
