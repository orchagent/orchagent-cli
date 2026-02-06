import { Command } from 'commander'

import { getResolvedConfig, loadConfig } from '../lib/config'
import { getOrg, getCreditsBalance, request } from '../lib/api'

interface Workspace {
  id: string
  name: string
  slug: string
  type: 'personal' | 'team'
  role: 'owner' | 'member'
  member_count: number
}

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

      // Show active workspace if one is set
      const configFile = await loadConfig()
      if (configFile.workspace) {
        try {
          const response = await request<{ workspaces: Workspace[] }>(config, 'GET', '/workspaces')
          const workspace = response.workspaces.find((w) => w.slug === configFile.workspace)
          if (workspace) {
            process.stdout.write(`Active workspace: ${workspace.name} (${workspace.slug})\n`)
          } else {
            process.stdout.write(`Active workspace: ${configFile.workspace} (not found)\n`)
          }
        } catch {
          // Workspace fetch failed - show slug only
          process.stdout.write(`Active workspace: ${configFile.workspace}\n`)
        }
      }

      // Show balance after org info
      try {
        const balance = await getCreditsBalance(config)
        process.stdout.write(`Credits: $${(balance.balance_cents / 100).toFixed(2)} USD\n`)
      } catch {
        // Ignore errors - don't let balance check break whoami
      }
    })
}
