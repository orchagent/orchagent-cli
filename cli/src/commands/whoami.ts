import { Command } from 'commander'

import { getResolvedConfig, loadConfig } from '../lib/config'
import { getOrg, request } from '../lib/api'
import { CliError } from '../lib/errors'

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
    .option('--profile <name>', 'Use credentials from a named profile')
    .action(async (options: { profile?: string }) => {
      const profile = normalizeProfileName(options.profile)
      const config = await getResolvedConfig({}, profile)
      const org = await getOrg(config)

      if (profile) {
        process.stdout.write(`Profile: ${profile}\n`)
      }
      process.stdout.write(`Logged in as: ${org.name}\n`)
      process.stdout.write(`Org slug: ${org.slug}\n`)
      process.stdout.write(`API URL: ${config.apiUrl}\n`)

      // Show active workspace if one is set
      const configFile = await loadConfig()
      const activeWorkspace = profile ? configFile.profiles?.[profile]?.workspace : configFile.workspace
      if (activeWorkspace) {
        try {
          const response = await request<{ workspaces: Workspace[] }>(config, 'GET', '/workspaces')
          const workspace = response.workspaces.find((w) => w.slug === activeWorkspace)
          if (workspace) {
            process.stdout.write(`Active workspace: ${workspace.name} (${workspace.slug})\n`)
          } else {
            process.stdout.write(`Active workspace: ${activeWorkspace} (not found)\n`)
          }
        } catch {
          // Workspace fetch failed - show slug only
          process.stdout.write(`Active workspace: ${activeWorkspace}\n`)
        }
      }

    })
}

function normalizeProfileName(profile: string | undefined): string | undefined {
  const name = profile?.trim()
  if (!name) return undefined
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new CliError('Profile names may only contain letters, numbers, dots, underscores, and hyphens.')
  }
  return name
}
