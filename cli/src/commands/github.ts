import { Command } from 'commander'
import open from 'open'
import Table from 'cli-table3'
import chalk from 'chalk'
import * as readline from 'readline'

import { getResolvedConfig } from '../lib/config'
import { request } from '../lib/api'
import { CliError } from '../lib/errors'
import { track } from '../lib/analytics'
import { printJson } from '../lib/output'
import type { ResolvedConfig } from '../types'

const POLL_INTERVAL_MS = 1500
const POLL_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
const SETTINGS_REDIRECT_BASE = 'https://orchagent.io/settings'

// Types for GitHub App integration

interface InstallInitResponse {
  install_url: string
  state: string
}

interface InstallStatusResponse {
  status: string // pending, completed, failed
  github_account_login?: string
  github_account_type?: string
  error_message?: string
}

interface ConnectionStatusResponse {
  connected: boolean
  github_account_login?: string
  github_account_type?: string
  installed_at?: string
  suspended_at?: string
}

interface ScanItem {
  type: 'agent' | 'skill' | 'prompt' | 'tool'
  path: string
  name: string
  description?: string
}

interface ScanResponse {
  items: ScanItem[]
}

interface ImportResponse {
  agent: {
    id: string
    name: string
    org_id: string
    version: string
    type: string
  }
  service_key: string
  service_key_prefix: string
}

interface SyncConfigResponse {
  auto_publish: boolean
  sync_status?: string
}

// Helper functions

async function promptForSelection(items: ScanItem[]): Promise<ScanItem | null> {
  if (!process.stdin.isTTY) {
    return null
  }

  process.stdout.write('\nSelect an item to import (enter number, or "q" to quit):\n\n')
  items.forEach((item, idx) => {
    process.stdout.write(`  ${idx + 1}. [${item.type}] ${item.path}`)
    if (item.name) {
      process.stdout.write(` (${item.name})`)
    }
    process.stdout.write('\n')
  })
  process.stdout.write('\n')

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise((resolve) => {
    rl.question('Choice: ', (answer) => {
      rl.close()
      const trimmed = answer.trim().toLowerCase()
      if (trimmed === 'q' || trimmed === '') {
        resolve(null)
        return
      }
      const num = parseInt(trimmed, 10)
      if (isNaN(num) || num < 1 || num > items.length) {
        process.stdout.write('Invalid selection.\n')
        resolve(null)
        return
      }
      resolve(items[num - 1])
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Command implementations

async function connectGitHub(config: ResolvedConfig): Promise<void> {
  // Step 1: Initialize the GitHub App install flow
  const initResponse = await request<InstallInitResponse>(
    config,
    'POST',
    '/github/install/init',
    {
      body: JSON.stringify({ redirect_uri: SETTINGS_REDIRECT_BASE }),
      headers: { 'Content-Type': 'application/json' },
    }
  )

  // Step 2: Open browser for GitHub App installation
  process.stdout.write('Opening browser to install the GitHub App...\n')
  try {
    await open(initResponse.install_url)
  } catch {
    // Headless or browser unavailable - print URL for manual copy/paste
    process.stdout.write(`\nCould not open browser automatically.\n`)
    process.stdout.write(`Please open this URL in your browser:\n\n`)
    process.stdout.write(`  ${initResponse.install_url}\n\n`)
  }

  // Step 3: Poll for completion
  process.stdout.write('Waiting for GitHub App installation...\n')
  const startTime = Date.now()

  while (Date.now() - startTime < POLL_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS)

    const status = await request<InstallStatusResponse>(
      config,
      'GET',
      `/github/install/status?state=${encodeURIComponent(initResponse.state)}`
    )

    if (status.status === 'completed') {
      await track('cli_github_connect', { success: true })
      process.stdout.write('\n')
      process.stdout.write(`Connected to GitHub as ${chalk.bold(status.github_account_login)}\n`)
      if (status.github_account_type) {
        process.stdout.write(`  Type: ${status.github_account_type}\n`)
      }
      return
    }

    if (status.status === 'failed') {
      await track('cli_github_connect', { success: false })
      throw new CliError(
        `GitHub App installation failed: ${status.error_message || 'Unknown error'}`
      )
    }

    // Still pending - continue polling
  }

  throw new CliError('GitHub App installation timed out after 5 minutes. Please try again.')
}

async function disconnectGitHub(config: ResolvedConfig): Promise<void> {
  await request(config, 'DELETE', '/github/uninstall')
  await track('cli_github_disconnect')
  process.stdout.write('GitHub App uninstalled.\n')
}

async function getGitHubStatus(config: ResolvedConfig, json: boolean): Promise<void> {
  const connection = await request<ConnectionStatusResponse>(config, 'GET', '/github/connection')

  if (json) {
    printJson(connection)
    return
  }

  if (!connection.connected) {
    process.stdout.write('Not connected to GitHub.\n')
    process.stdout.write('\nConnect with: orchagent github connect\n')
    return
  }

  process.stdout.write(`GitHub Status:\n\n`)
  process.stdout.write(`  Connected: ${chalk.green('Yes')}\n`)
  process.stdout.write(`  Account:   ${chalk.bold(connection.github_account_login)}\n`)
  if (connection.github_account_type) {
    process.stdout.write(`  Type:      ${connection.github_account_type === 'User' ? 'User' : 'Organization'}\n`)
  }
  if (connection.installed_at) {
    const date = new Date(connection.installed_at).toLocaleDateString()
    process.stdout.write(`  Since:     ${date}\n`)
  }
  if (connection.suspended_at) {
    process.stdout.write(`  Status:    ${chalk.yellow('Suspended')} (since ${new Date(connection.suspended_at).toLocaleDateString()})\n`)
  }
  process.stdout.write('\n')
}

async function scanGitHubRepo(
  config: ResolvedConfig,
  repo: string,
  json: boolean
): Promise<ScanItem[]> {
  // Parse owner/repo format
  const parts = repo.split('/')
  if (parts.length !== 2) {
    throw new CliError(
      `Invalid repository format: ${repo}\n\n` +
      `Use owner/repo format, e.g.: orchagent github scan myorg/myrepo`
    )
  }
  const [owner, repoName] = parts

  const response = await request<ScanResponse>(
    config,
    'GET',
    `/github/repos/${owner}/${repoName}/scan`
  )

  const results = response.items

  await track('cli_github_scan', { repo, found: results.length })

  if (json) {
    printJson(results)
    return results
  }

  if (results.length === 0) {
    process.stdout.write(`No agents or skills detected in ${repo}.\n`)
    process.stdout.write('\nMake sure your repository contains:\n')
    process.stdout.write('  - An orchagent.yaml or orchagent.json manifest file\n')
    process.stdout.write('  - Or a directory with agent/skill configuration\n')
    return results
  }

  const table = new Table({
    head: [
      chalk.bold('Type'),
      chalk.bold('Path'),
      chalk.bold('Name'),
    ],
  })

  results.forEach((item) => {
    const typeLabel = item.type === 'skill' ? chalk.cyan('skill') : chalk.magenta(item.type)
    table.push([typeLabel, item.path, item.name || '-'])
  })

  process.stdout.write(`${table.toString()}\n`)
  process.stdout.write(`\nFound ${results.length} item${results.length === 1 ? '' : 's'} in ${repo}.\n`)
  process.stdout.write(`\nImport with: orchagent github import ${repo} --path <path>\n`)

  return results
}

async function importFromGitHub(
  config: ResolvedConfig,
  repo: string,
  options: {
    path?: string
    public?: boolean
    private?: boolean
    name?: string
    json?: boolean
  }
): Promise<void> {
  // Validate owner/repo format
  const parts = repo.split('/')
  if (parts.length !== 2) {
    throw new CliError(
      `Invalid repository format: ${repo}\n\n` +
      `Use owner/repo format, e.g.: orchagent github import myorg/myrepo`
    )
  }

  let selectedPath = options.path

  // If no path specified, scan first and let user choose
  if (!selectedPath) {
    const results = await scanGitHubRepo(config, repo, false)

    if (results.length === 0) {
      throw new CliError(
        `No importable items found in ${repo}.\n\n` +
        `Make sure your repository contains an orchagent.yaml manifest.`
      )
    }

    if (results.length === 1) {
      selectedPath = results[0].path
      process.stdout.write(`\nImporting: ${results[0].path}\n`)
    } else {
      const selection = await promptForSelection(results)
      if (!selection) {
        process.stdout.write('Import cancelled.\n')
        return
      }
      selectedPath = selection.path
    }
  }

  // Determine visibility (default to public)
  const isPublic = options.private ? false : true

  const importResult = await request<ImportResponse>(
    config,
    'POST',
    '/github/import',
    {
      body: JSON.stringify({
        repo,
        path: selectedPath,
        is_public: isPublic,
        name: options.name,
      }),
      headers: { 'Content-Type': 'application/json' },
    }
  )

  await track('cli_github_import', {
    repo,
    path: selectedPath,
    is_public: isPublic,
    type: importResult.agent.type,
  })

  if (options.json) {
    printJson(importResult)
    return
  }

  process.stdout.write('\n')
  process.stdout.write(`Imported ${chalk.bold(importResult.agent.name)} from ${repo}\n`)
  process.stdout.write('\n')
  process.stdout.write(`  Agent:   ${importResult.agent.name}\n`)
  process.stdout.write(`  Version: ${importResult.agent.version}\n`)
  process.stdout.write(`  Type:    ${importResult.agent.type}\n`)
  process.stdout.write(`  Public:  ${isPublic ? chalk.green('Yes') : chalk.yellow('No')}\n`)
  process.stdout.write('\n')
}

async function getSyncConfig(
  config: ResolvedConfig,
  agentId: string,
  options: {
    setAutoPublish?: string
    json?: boolean
  }
): Promise<void> {
  // If --set-auto-publish is specified, update config first
  if (options.setAutoPublish !== undefined) {
    const autoPublish = options.setAutoPublish === 'true'
    await request(
      config,
      'PATCH',
      `/github/agents/${agentId}/sync-config`,
      {
        body: JSON.stringify({ auto_publish: autoPublish }),
        headers: { 'Content-Type': 'application/json' },
      }
    )
    process.stdout.write(`Updated auto_publish to ${chalk.bold(String(autoPublish))} for agent ${agentId}\n`)
    return
  }

  const syncConfig = await request<SyncConfigResponse>(
    config,
    'GET',
    `/github/agents/${agentId}/sync-config`
  )

  if (options.json) {
    printJson(syncConfig)
    return
  }

  process.stdout.write(`Sync Config for ${chalk.bold(agentId)}:\n\n`)
  process.stdout.write(`  Auto-publish: ${syncConfig.auto_publish ? chalk.green('enabled') : chalk.yellow('disabled')}\n`)
  if (syncConfig.sync_status) {
    process.stdout.write(`  Sync status:  ${syncConfig.sync_status}\n`)
  }
  process.stdout.write('\n')
}

async function approveSync(config: ResolvedConfig, agentId: string): Promise<void> {
  await request(
    config,
    'POST',
    `/github/agents/${agentId}/approve`
  )

  await track('cli_github_approve', { agent_id: agentId })
  process.stdout.write(`Approved pending sync for agent ${chalk.bold(agentId)}.\n`)
}

// Command registration

export function registerGitHubCommand(program: Command): void {
  const github = program
    .command('github')
    .description('Connect to GitHub and import agents')

  github
    .command('connect')
    .description('Install the GitHub App to connect your account')
    .action(async () => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orchagent login` first.')
      }

      await connectGitHub(config)
    })

  github
    .command('disconnect')
    .description('Remove GitHub App installation')
    .action(async () => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orchagent login` first.')
      }

      await disconnectGitHub(config)
    })

  github
    .command('status')
    .description('Show GitHub connection status')
    .option('--json', 'Output raw JSON')
    .action(async (options: { json?: boolean }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orchagent login` first.')
      }

      await getGitHubStatus(config, options.json || false)
    })

  github
    .command('scan <repo>')
    .description('Scan a repository for agents and skills')
    .option('--json', 'Output raw JSON')
    .action(async (repo: string, options: { json?: boolean }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orchagent login` first.')
      }

      await scanGitHubRepo(config, repo, options.json || false)
    })

  github
    .command('import <repo>')
    .description('Import an agent or skill from GitHub')
    .option('--path <path>', 'Path to manifest within repo (scans if not specified)')
    .option('--public', 'Make the agent public (default)')
    .option('--private', 'Make the agent private')
    .option('--name <name>', 'Override agent name')
    .option('--json', 'Output raw JSON')
    .action(async (repo: string, options: {
      path?: string
      public?: boolean
      private?: boolean
      name?: string
      json?: boolean
    }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orchagent login` first.')
      }

      await importFromGitHub(config, repo, options)
    })

  github
    .command('sync-config <agent>')
    .description('View or update sync configuration for a GitHub-linked agent')
    .option('--set-auto-publish <value>', 'Set auto_publish (true or false)')
    .option('--json', 'Output raw JSON')
    .action(async (agent: string, options: {
      setAutoPublish?: string
      json?: boolean
    }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orchagent login` first.')
      }

      if (options.setAutoPublish !== undefined && options.setAutoPublish !== 'true' && options.setAutoPublish !== 'false') {
        throw new CliError('--set-auto-publish must be "true" or "false"')
      }

      await getSyncConfig(config, agent, options)
    })

  github
    .command('approve <agent_id>')
    .description('Approve a pending GitHub sync for an agent')
    .action(async (agentId: string) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orchagent login` first.')
      }

      await approveSync(config, agentId)
    })
}
