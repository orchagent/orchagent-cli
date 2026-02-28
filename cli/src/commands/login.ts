import { Command } from 'commander'
import readline from 'readline/promises'

import { getResolvedConfig, loadConfig, saveConfig } from '../lib/config'
import { getOrg } from '../lib/api'
import { startBrowserAuth } from '../lib/browser-auth'
import { CliError } from '../lib/errors'
import { track } from '../lib/analytics'

const DEFAULT_AUTH_PORT = 8374

async function promptForKey(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  const answer = await rl.question('API key: ')
  rl.close()
  return answer.trim()
}

export function registerLoginCommand(program: Command): void {
  program
    .command('login')
    .description('Authenticate with orchagent via browser or API key')
    .option('--key <key>', 'API key (for CI/CD, non-interactive)')
    .option('--port <port>', `Localhost port for browser callback (default: ${DEFAULT_AUTH_PORT})`, String(DEFAULT_AUTH_PORT))
    .action(async (options: { key?: string; port?: string }) => {
      const providedKey = options.key || process.env.ORCHAGENT_API_KEY

      // If key provided via flag or env var, use existing key-based flow
      if (providedKey) {
        await keyBasedLogin(providedKey)
        return
      }

      // Check if running in non-interactive mode (no TTY)
      if (!process.stdin.isTTY) {
        throw new CliError(
          'Non-interactive mode requires --key flag or ORCHAGENT_API_KEY environment variable.\n' +
          'For CI/CD, set ORCHAGENT_API_KEY or use: orchagent login --key <your-api-key>'
        )
      }

      // Interactive mode: use browser auth
      const port = parseInt(options.port || String(DEFAULT_AUTH_PORT), 10)
      if (isNaN(port) || port < 1024 || port > 65535) {
        throw new CliError('Port must be a number between 1024 and 65535')
      }

      await browserBasedLogin(port)
    })
}

/**
 * Login using an API key (for CI/CD and non-interactive environments).
 */
async function keyBasedLogin(apiKey: string): Promise<void> {
  if (!apiKey) {
    throw new CliError('API key is required.')
  }

  const resolved = await getResolvedConfig({ api_key: apiKey })
  const org = await getOrg(resolved)
  const existing = await loadConfig()
  const isFirstLogin = !existing.api_key

  const nextConfig = {
    ...existing,
    api_key: apiKey,
    api_url: resolved.apiUrl,
    default_org: existing.default_org ?? org.slug,
  }
  // Clear workspace from previous account — workspaces are account-specific
  delete nextConfig.workspace

  await saveConfig(nextConfig)
  await track('cli_login', { method: 'key' })
  process.stdout.write(`✓ Logged in to ${org.slug}\n`)

  if (isFirstLogin) {
    process.stdout.write('\n  Tip: Run `orch doctor` to verify your setup.\n\n')
  }
}

/**
 * Login via browser OAuth flow.
 */
async function browserBasedLogin(port: number): Promise<void> {
  const existing = await loadConfig()
  const isFirstLogin = !existing.api_key
  const resolved = await getResolvedConfig()

  process.stdout.write('Opening browser for authentication...\n\n')

  try {
    const result = await startBrowserAuth(resolved.apiUrl, port)

    const nextConfig = {
      ...existing,
      api_key: result.apiKey,
      api_url: resolved.apiUrl,
      default_org: existing.default_org ?? result.orgSlug,
    }
    // Clear workspace from previous account — workspaces are account-specific
    delete nextConfig.workspace

    await saveConfig(nextConfig)
    await track('cli_login', { method: 'browser' })
    process.stdout.write(`\n✓ Logged in to ${result.orgSlug}\n`)

    if (isFirstLogin) {
      process.stdout.write('\n  Tip: Run `orch doctor` to verify your setup.\n\n')
    }
  } catch (err) {
    if (err instanceof CliError) {
      throw err
    }
    throw new CliError(
      err instanceof Error ? err.message : 'Authentication failed'
    )
  }
}
