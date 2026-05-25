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
    .option('--profile <name>', 'Save credentials to a named profile')
    .option('--port <port>', `Localhost port for browser callback (default: ${DEFAULT_AUTH_PORT})`, String(DEFAULT_AUTH_PORT))
    .action(async (options: { key?: string; profile?: string; port?: string }) => {
      const profile = normalizeProfileName(options.profile)

      // If key provided via --key flag, use key-based flow (for CI/CD)
      // Note: ORCHAGENT_API_KEY env var is intentionally NOT checked here —
      // it's for runtime API auth, not for login. Otherwise `orch login`
      // can never reach the browser flow when the env var is set.
      if (options.key) {
        await keyBasedLogin(options.key, profile)
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

      await browserBasedLogin(port, profile)
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

/**
 * Login using an API key (for CI/CD and non-interactive environments).
 */
async function keyBasedLogin(apiKey: string, profile?: string): Promise<void> {
  if (!apiKey) {
    throw new CliError('API key is required.')
  }

  const resolved = await getResolvedConfig({ api_key: apiKey })
  const org = await getOrg(resolved)
  const existing = await loadConfig()
  const isFirstLogin = profile ? !existing.profiles?.[profile]?.api_key : !existing.api_key

  const nextConfig = { ...existing }
  if (profile) {
    nextConfig.profiles = {
      ...existing.profiles,
      [profile]: {
        ...existing.profiles?.[profile],
        api_key: apiKey,
        api_url: resolved.apiUrl,
        default_org: org.slug,
      },
    }
    delete nextConfig.profiles[profile].workspace
  } else {
    nextConfig.api_key = apiKey
    nextConfig.api_url = resolved.apiUrl
    nextConfig.default_org = org.slug
    // Clear workspace from previous account — workspaces are account-specific
    delete nextConfig.workspace
  }

  await saveConfig(nextConfig)
  await track('cli_login', { method: 'key' })
  process.stdout.write(profile ? `✓ Logged in to ${org.slug} as profile ${profile}\n` : `✓ Logged in to ${org.slug}\n`)

  if (process.env.ORCHAGENT_API_KEY) {
    process.stderr.write(
      '\nWarning: ORCHAGENT_API_KEY is set in your environment.\n' +
      'The env var overrides your login credentials. Unset it with:\n' +
      '  unset ORCHAGENT_API_KEY\n'
    )
  }

  if (isFirstLogin) {
    process.stdout.write(
      '\n  Quick start: Tell Claude Code:\n' +
      '  "Read docs.orchagent.io and build me an agent"\n\n' +
      '  Or manually: orch init my-agent\n' +
      '  Verify setup: orch doctor\n\n'
    )
  }
}

/**
 * Login via browser OAuth flow.
 */
async function browserBasedLogin(port: number, profile?: string): Promise<void> {
  const existing = await loadConfig()
  const isFirstLogin = profile ? !existing.profiles?.[profile]?.api_key : !existing.api_key
  const resolved = await getResolvedConfig({}, profile)

  process.stdout.write('Opening browser for authentication...\n\n')

  try {
    const result = await startBrowserAuth(resolved.apiUrl, port)

    const nextConfig = { ...existing }
    if (profile) {
      nextConfig.profiles = {
        ...existing.profiles,
        [profile]: {
          ...existing.profiles?.[profile],
          api_key: result.apiKey,
          api_url: resolved.apiUrl,
          default_org: result.orgSlug,
        },
      }
      delete nextConfig.profiles[profile].workspace
    } else {
      nextConfig.api_key = result.apiKey
      nextConfig.api_url = resolved.apiUrl
      nextConfig.default_org = result.orgSlug
      // Clear workspace from previous account — workspaces are account-specific
      delete nextConfig.workspace
    }

    await saveConfig(nextConfig)
    await track('cli_login', { method: 'browser' })
    process.stdout.write(profile ? `\n✓ Logged in to ${result.orgSlug} as profile ${profile}\n` : `\n✓ Logged in to ${result.orgSlug}\n`)

    if (process.env.ORCHAGENT_API_KEY) {
      process.stderr.write(
        '\nWarning: ORCHAGENT_API_KEY is set in your environment.\n' +
        'The env var overrides your login credentials. Unset it with:\n' +
        '  unset ORCHAGENT_API_KEY\n'
      )
    }

    if (isFirstLogin) {
      process.stdout.write(
        '\n  Quick start: Tell Claude Code:\n' +
        '  "Read docs.orchagent.io and build me an agent"\n\n' +
        '  Or manually: orch init my-agent\n' +
        '  Verify setup: orch doctor\n\n'
      )
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
