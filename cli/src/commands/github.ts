import { Command } from 'commander'
import http from 'http'
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

const DEFAULT_AUTH_PORT = 8375
const AUTH_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

// Types for GitHub integration

interface GitHubInitResponse {
  state: string
  auth_url: string
}

interface GitHubCallbackResponse {
  connected: boolean
  username: string
}

interface GitHubConnection {
  connected: boolean
  username?: string
  connected_at?: string
  scopes?: string[]
}

interface GitHubRepo {
  full_name: string
  name: string
  owner: string
  private: boolean
  description?: string
  default_branch: string
  pushed_at?: string
  html_url: string
}

interface ScanResult {
  type: 'agent' | 'skill'
  path: string
  name: string
  description?: string
}

interface ImportResult {
  agent_id: string
  name: string
  org_slug: string
  version: string
  type: 'prompt' | 'code' | 'skill'
}

// Helper functions

function successHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>orchagent CLI - GitHub Connected</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: #0a0a0a;
      color: #fafafa;
    }
    .container {
      text-align: center;
      padding: 2rem;
    }
    .icon {
      width: 64px;
      height: 64px;
      background: rgba(34, 197, 94, 0.1);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 1.5rem;
    }
    .icon svg {
      width: 32px;
      height: 32px;
      color: #22c55e;
    }
    h1 {
      font-size: 1.5rem;
      margin: 0 0 0.5rem;
    }
    p {
      color: #a1a1aa;
      margin: 0;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
      </svg>
    </div>
    <h1>GitHub Connected</h1>
    <p>You can close this tab and return to your terminal.</p>
  </div>
</body>
</html>`
}

function errorHtml(message: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>orchagent CLI - GitHub Connection Error</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: #0a0a0a;
      color: #fafafa;
    }
    .container {
      text-align: center;
      padding: 2rem;
    }
    .icon {
      width: 64px;
      height: 64px;
      background: rgba(239, 68, 68, 0.1);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 1.5rem;
    }
    .icon svg {
      width: 32px;
      height: 32px;
      color: #ef4444;
    }
    h1 {
      font-size: 1.5rem;
      margin: 0 0 0.5rem;
    }
    p {
      color: #a1a1aa;
      margin: 0;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
      </svg>
    </div>
    <h1>Connection Error</h1>
    <p>${message}</p>
  </div>
</body>
</html>`
}

async function waitForGitHubCallback(
  port: number,
  timeoutMs: number
): Promise<{ code: string; state: string }> {
  return new Promise((resolve, reject) => {
    let resolved = false
    let server: http.Server | null = null

    const cleanup = () => {
      if (server) {
        server.close()
        server = null
      }
    }

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        cleanup()
        reject(new CliError('GitHub authentication timed out. Please try again.'))
      }
    }, timeoutMs)

    server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`)

      if (url.pathname !== '/callback') {
        res.writeHead(404)
        res.end('Not Found')
        return
      }

      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const error = url.searchParams.get('error')

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(errorHtml(url.searchParams.get('error_description') || error))
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          cleanup()
          reject(new CliError(`GitHub authorization failed: ${error}`))
        }
        return
      }

      if (!code || !state) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(errorHtml('Missing code or state parameter'))
        return
      }

      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(successHtml())

      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        cleanup()
        resolve({ code, state })
      }
    })

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        cleanup()
        if (err.code === 'EADDRINUSE') {
          reject(new CliError(`Port ${port} is already in use. Try a different port with --port.`))
        } else {
          reject(new CliError(`Failed to start auth server: ${err.message}`))
        }
      }
    })

    server.listen(port, '127.0.0.1')
  })
}

async function promptForSelection(items: ScanResult[]): Promise<ScanResult | null> {
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

// Command implementations

async function connectGitHub(config: ResolvedConfig, port: number): Promise<void> {
  const redirectUri = `http://127.0.0.1:${port}/callback`

  // Step 1: Initialize the GitHub OAuth flow
  const initResponse = await request<GitHubInitResponse>(
    config,
    'POST',
    '/github/connect/init',
    {
      body: JSON.stringify({ redirect_uri: redirectUri }),
      headers: { 'Content-Type': 'application/json' },
    }
  )

  // Step 2: Start local server to receive callback
  const callbackPromise = waitForGitHubCallback(port, AUTH_TIMEOUT_MS)

  // Step 3: Open browser
  process.stdout.write('Opening browser for GitHub authentication...\n')
  try {
    await open(initResponse.auth_url)
  } catch {
    process.stdout.write(`\nPlease open this URL in your browser:\n${initResponse.auth_url}\n\n`)
  }

  // Step 4: Wait for callback
  const { code, state } = await callbackPromise

  // Step 5: Exchange code for connection
  const callbackResponse = await request<GitHubCallbackResponse>(
    config,
    'POST',
    '/github/connect/callback',
    {
      body: JSON.stringify({ code, state }),
      headers: { 'Content-Type': 'application/json' },
    }
  )

  await track('cli_github_connect', { success: true })
  process.stdout.write(`\nConnected to GitHub as ${chalk.bold(callbackResponse.username)}\n`)
}

async function disconnectGitHub(config: ResolvedConfig): Promise<void> {
  await request(config, 'DELETE', '/github/disconnect')
  await track('cli_github_disconnect')
  process.stdout.write('Disconnected from GitHub.\n')
}

async function getGitHubStatus(config: ResolvedConfig, json: boolean): Promise<void> {
  const connection = await request<GitHubConnection>(config, 'GET', '/github/connection')

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
  process.stdout.write(`  Username:  ${chalk.bold(connection.username)}\n`)
  if (connection.connected_at) {
    const date = new Date(connection.connected_at).toLocaleDateString()
    process.stdout.write(`  Since:     ${date}\n`)
  }
  if (connection.scopes?.length) {
    process.stdout.write(`  Scopes:    ${connection.scopes.join(', ')}\n`)
  }
  process.stdout.write('\n')
}

async function listGitHubRepos(
  config: ResolvedConfig,
  search: string | undefined,
  json: boolean
): Promise<void> {
  const params = new URLSearchParams()
  if (search) {
    params.append('search', search)
  }
  const queryStr = params.toString()
  const repos = await request<GitHubRepo[]>(
    config,
    'GET',
    `/github/repos${queryStr ? `?${queryStr}` : ''}`
  )

  await track('cli_github_list', { search: !!search, count: repos.length })

  if (json) {
    printJson(repos)
    return
  }

  if (repos.length === 0) {
    process.stdout.write('No repositories found.\n')
    if (search) {
      process.stdout.write(`\nTry a different search term or run without --search to see all repos.\n`)
    }
    return
  }

  const table = new Table({
    head: [
      chalk.bold('Repository'),
      chalk.bold('Private'),
      chalk.bold('Last Pushed'),
    ],
  })

  repos.forEach((repo) => {
    const visibility = repo.private ? chalk.yellow('Yes') : chalk.green('No')
    const pushed = repo.pushed_at
      ? new Date(repo.pushed_at).toLocaleDateString()
      : '-'
    table.push([repo.full_name, visibility, pushed])
  })

  process.stdout.write(`${table.toString()}\n`)
  process.stdout.write(`\nFound ${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'}.\n`)
}

async function scanGitHubRepo(
  config: ResolvedConfig,
  repo: string,
  json: boolean
): Promise<ScanResult[]> {
  // Parse owner/repo format
  const parts = repo.split('/')
  if (parts.length !== 2) {
    throw new CliError(
      `Invalid repository format: ${repo}\n\n` +
      `Use owner/repo format, e.g.: orchagent github scan myorg/myrepo`
    )
  }
  const [owner, repoName] = parts

  const results = await request<ScanResult[]>(
    config,
    'GET',
    `/github/repos/${owner}/${repoName}/scan`
  )

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
    const typeLabel = item.type === 'skill' ? chalk.cyan('skill') : chalk.magenta('agent')
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
  // Parse owner/repo format
  const parts = repo.split('/')
  if (parts.length !== 2) {
    throw new CliError(
      `Invalid repository format: ${repo}\n\n` +
      `Use owner/repo format, e.g.: orchagent github import myorg/myrepo`
    )
  }
  const [owner, repoName] = parts

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

  const importResult = await request<ImportResult>(
    config,
    'POST',
    '/github/import',
    {
      body: JSON.stringify({
        owner,
        repo: repoName,
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
    type: importResult.type,
  })

  if (options.json) {
    printJson(importResult)
    return
  }

  process.stdout.write('\n')
  process.stdout.write(`Imported ${chalk.bold(importResult.name)} from ${repo}\n`)
  process.stdout.write('\n')
  process.stdout.write(`  Agent:   ${importResult.org_slug}/${importResult.name}\n`)
  process.stdout.write(`  Version: ${importResult.version}\n`)
  process.stdout.write(`  Type:    ${importResult.type}\n`)
  process.stdout.write(`  Public:  ${isPublic ? chalk.green('Yes') : chalk.yellow('No')}\n`)
  process.stdout.write('\n')
  process.stdout.write(`View at: https://orchagent.io/${importResult.org_slug}/${importResult.name}\n`)
}

// Command registration

export function registerGitHubCommand(program: Command): void {
  const github = program
    .command('github')
    .description('Connect to GitHub and import agents')

  github
    .command('connect')
    .description('Connect your GitHub account via browser OAuth')
    .option('--port <port>', `Localhost port for callback (default: ${DEFAULT_AUTH_PORT})`, String(DEFAULT_AUTH_PORT))
    .action(async (options: { port?: string }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orchagent login` first.')
      }

      const port = parseInt(options.port || String(DEFAULT_AUTH_PORT), 10)
      if (isNaN(port) || port < 1024 || port > 65535) {
        throw new CliError('Port must be a number between 1024 and 65535')
      }

      await connectGitHub(config, port)
    })

  github
    .command('disconnect')
    .description('Remove GitHub connection')
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
    .command('list')
    .description('List accessible GitHub repositories')
    .option('--search <query>', 'Filter repositories by name')
    .option('--json', 'Output raw JSON')
    .action(async (options: { search?: string; json?: boolean }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orchagent login` first.')
      }

      await listGitHubRepos(config, options.search, options.json || false)
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
}
