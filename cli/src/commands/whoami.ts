import { Command } from 'commander'

import { getResolvedConfig } from '../lib/config'
import { getOrg, getCreditsBalance } from '../lib/api'

export function registerWhoamiCommand(program: Command): void {
  program
    .command('whoami')
    .description('Show current user/org info')
    .action(async () => {
      const config = await getResolvedConfig()
      const org = await getOrg(config)

      process.stdout.write(`Logged in as: ${org.name}\n`)
      process.stdout.write(`Org slug: ${org.slug}\n`)
      process.stdout.write(`API URL: ${config.apiUrl}\n`)

      // Show balance after org info
      try {
        const balance = await getCreditsBalance(config)
        process.stdout.write(`Credits: $${(balance.balance_cents / 100).toFixed(2)} USD\n`)
      } catch {
        // Ignore errors - don't let balance check break whoami
      }
    })
}
