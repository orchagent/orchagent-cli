import { Command } from 'commander'

import { getResolvedConfig, loadConfig, saveConfig } from '../lib/config'
import { safeFetch } from '../lib/api'
import { track } from '../lib/analytics'
import { CliError } from '../lib/errors'

export function registerLogoutCommand(program: Command): void {
  program
    .command('logout')
    .description('Log out of orchagent (revokes API key and clears local credentials)')
    .option('--profile <name>', 'Log out of a named profile')
    .action(async (options: { profile?: string }) => {
      const profile = normalizeProfileName(options.profile)
      const config = await loadConfig()

      // Check if already logged out
      if (profile && !config.profiles?.[profile]?.api_key) {
        process.stdout.write(`Not logged into profile ${profile}.\n`)
        return
      }
      if (!profile && !config.api_key && !process.env.ORCHAGENT_API_KEY) {
        process.stdout.write('Not logged in.\n')
        return
      }

      const resolved = await getResolvedConfig({}, profile)

      // Best-effort server-side key revocation (Vercel/Fly pattern)
      if (resolved.apiKey) {
        try {
          await safeFetch(`${resolved.apiUrl}/auth/cli-logout`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${resolved.apiKey}`,
            },
          })
        } catch {
          // Network errors, server down, etc. — proceed with local cleanup
        }
      }

      if (profile) {
        delete config.profiles?.[profile]
        if (config.profiles && Object.keys(config.profiles).length === 0) {
          delete config.profiles
        }
      } else {
        // Clear auth fields but preserve user preferences
        delete config.api_key
        delete config.default_org
        delete config.workspace
      }
      await saveConfig(config)

      await track('cli_logout', profile ? { profile } : {})

      process.stdout.write(profile ? `Logged out of profile ${profile}.\n` : 'Logged out.\n')

      // Warn if env var is still set (GitHub CLI / Fly.io pattern)
      if (process.env.ORCHAGENT_API_KEY) {
        process.stderr.write(
          '\nWarning: ORCHAGENT_API_KEY is set in your environment.\n' +
          'The env var will still authenticate requests. Unset it with:\n' +
          '  unset ORCHAGENT_API_KEY\n'
        )
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
