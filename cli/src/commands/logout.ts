import { Command } from 'commander'

import { getResolvedConfig, loadConfig, saveConfig } from '../lib/config'
import { safeFetch } from '../lib/api'
import { track } from '../lib/analytics'

export function registerLogoutCommand(program: Command): void {
  program
    .command('logout')
    .description('Log out of orchagent (revokes API key and clears local credentials)')
    .action(async () => {
      const config = await loadConfig()

      // Check if already logged out
      if (!config.api_key && !process.env.ORCHAGENT_API_KEY) {
        process.stdout.write('Not logged in.\n')
        return
      }

      const resolved = await getResolvedConfig()

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

      // Clear auth fields but preserve user preferences
      delete config.api_key
      delete config.default_org
      delete config.workspace
      await saveConfig(config)

      await track('cli_logout', {})

      process.stdout.write('Logged out.\n')

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
