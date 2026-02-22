/**
 * `orch dev` — local development server with hot-reload.
 *
 * Starts an HTTP server that accepts JSON input and runs the agent locally.
 * Watches for file changes and reloads agent configuration automatically.
 */

import { Command } from 'commander'
import path from 'path'
import fs from 'fs/promises'
import chalk from 'chalk'
import chokidar from 'chokidar'

import { CliError } from '../lib/errors'
import { loadDotEnv } from '../lib/dotenv'
import { formatElapsed } from '../lib/spinner'
import {
  createDevServer,
  loadAgentConfig,
  engineLabel,
  type AgentConfig,
  type RequestLog,
} from '../lib/dev-server'

// ─── Console UI ─────────────────────────────────────────────────────────────

function printBanner(config: AgentConfig, port: number): void {
  const name = config.manifest.name || 'unknown'
  const version = config.manifest.version || 'local'
  const engine = engineLabel(config.engine)

  process.stderr.write('\n')
  process.stderr.write(chalk.cyan.bold(`  orch dev`) + chalk.gray(` — local development server\n`))
  process.stderr.write('\n')
  process.stderr.write(`  ${chalk.bold('Agent:')}   ${name}@${version}\n`)
  process.stderr.write(`  ${chalk.bold('Engine:')}  ${engine}`)
  if (config.entrypoint) {
    process.stderr.write(chalk.gray(` (${config.entrypoint})`))
  }
  process.stderr.write('\n')
  process.stderr.write(`  ${chalk.bold('Server:')}  ${chalk.green(`http://localhost:${port}`)}\n`)
  process.stderr.write('\n')
  process.stderr.write(chalk.gray(`  POST http://localhost:${port}/run   Execute agent\n`))
  process.stderr.write(chalk.gray(`  GET  http://localhost:${port}/health Agent info\n`))
  process.stderr.write('\n')
  process.stderr.write(chalk.gray('  Watching for file changes... (Ctrl+C to stop)\n'))
  process.stderr.write(chalk.gray('  ─'.repeat(32)) + '\n')
}

function printRequestLog(log: RequestLog): void {
  const status = log.statusCode < 400
    ? chalk.green(`${log.statusCode}`)
    : chalk.red(`${log.statusCode}`)
  const duration = chalk.gray(`${log.durationMs}ms`)
  const id = chalk.gray(`#${log.id}`)

  if (log.error) {
    process.stderr.write(
      `  ${id} ${log.method} ${log.path} ${status} ${duration}\n` +
      chalk.red(`     ${log.error.split('\n')[0].slice(0, 120)}\n`)
    )
  } else {
    process.stderr.write(`  ${id} ${log.method} ${log.path} ${status} ${duration}\n`)
  }
}

function printReload(reason: string): void {
  const time = new Date().toLocaleTimeString()
  process.stderr.write(chalk.cyan(`\n  [${time}] ${reason}\n`))
}

function printReloadError(error: string): void {
  process.stderr.write(chalk.red(`  Reload failed: ${error}\n`))
  process.stderr.write(chalk.yellow(`  Server still running with previous configuration.\n`))
}

// ─── File watcher ───────────────────────────────────────────────────────────

type WatcherState = {
  config: AgentConfig | null
  debounceTimer: NodeJS.Timeout | null
}

function setupWatcher(
  agentDir: string,
  state: WatcherState,
  verbose: boolean
): ReturnType<typeof chokidar.watch> {
  const watcher = chokidar.watch(agentDir, {
    ignored: /(node_modules|__pycache__|\.git|dist|build|\.venv|venv|\.next|target)/,
    persistent: true,
    ignoreInitial: true,
  })

  const reloadConfig = async (filePath: string) => {
    const relPath = path.relative(agentDir, filePath)
    printReload(`Changed: ${relPath}`)

    try {
      const newConfig = await loadAgentConfig(agentDir)
      state.config = newConfig
      const engine = engineLabel(newConfig.engine)
      const ep = newConfig.entrypoint ? `, ${newConfig.entrypoint}` : ''
      process.stderr.write(chalk.green(`  Reloaded`) + chalk.gray(` (${engine}${ep})\n`))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      printReloadError(message)
    }
  }

  const onChange = (filePath: string) => {
    if (state.debounceTimer) clearTimeout(state.debounceTimer)
    state.debounceTimer = setTimeout(() => reloadConfig(filePath), 300)
  }

  watcher
    .on('change', onChange)
    .on('add', onChange)
    .on('unlink', onChange)
    .on('error', (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(chalk.red(`  Watcher error: ${message}\n`))
    })

  return watcher
}

// ─── Command registration ───────────────────────────────────────────────────

export function registerDevCommand(program: Command): void {
  program
    .command('dev [path]')
    .description('Start a local development server with hot-reload')
    .option('-p, --port <port>', 'Server port', '4900')
    .option('-v, --verbose', 'Show detailed execution output')
    .option('--no-watch', 'Disable file watching')
    .addHelpText('after', `
Examples:
  orch dev                     Start dev server in current directory
  orch dev ./my-agent          Start dev server for agent in specified directory
  orch dev --port 3001         Use custom port
  orch dev --verbose           Show detailed execution output
  orch dev --no-watch          Disable file watching (no hot-reload)

Then send requests:
  curl -X POST http://localhost:4900/run \\
    -H "Content-Type: application/json" \\
    -d '{"task": "hello world"}'
`)
    .action(async (dirPath: string | undefined, options: { port: string; verbose?: boolean; watch?: boolean }) => {
      const agentDir = path.resolve(dirPath || '.')
      const port = parseInt(options.port, 10)
      const verbose = options.verbose ?? false
      const watchEnabled = options.watch !== false

      if (isNaN(port) || port < 1 || port > 65535) {
        throw new CliError('Port must be a number between 1 and 65535')
      }

      // Verify directory exists
      try {
        const stat = await fs.stat(agentDir)
        if (!stat.isDirectory()) {
          throw new CliError(`Not a directory: ${agentDir}`)
        }
      } catch (err) {
        if (err instanceof CliError) throw err
        throw new CliError(`Directory not found: ${agentDir}`)
      }

      // Verify orchagent.json exists
      try {
        await fs.access(path.join(agentDir, 'orchagent.json'))
      } catch {
        throw new CliError(
          `No orchagent.json found in ${agentDir}\n\n` +
          `To start a dev server, the directory must contain orchagent.json.\n` +
          `Create one with: orch init`
        )
      }

      // Load .env
      const dotEnvVars = await loadDotEnv(agentDir)
      const dotEnvCount = Object.keys(dotEnvVars).length
      if (dotEnvCount > 0) {
        for (const [key, value] of Object.entries(dotEnvVars)) {
          if (!(key in process.env) || process.env[key] === undefined) {
            process.env[key] = value
          }
        }
      }

      // Initial config load
      let initialConfig: AgentConfig
      try {
        initialConfig = await loadAgentConfig(agentDir)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new CliError(`Failed to load agent configuration: ${message}`)
      }

      const type = (initialConfig.manifest.type || 'agent').toLowerCase()
      if (type === 'skill') {
        throw new CliError(
          'Skills cannot be served as a dev server.\n' +
          'Skills are instructions meant to be injected into AI agent contexts.'
        )
      }

      // Set up state
      const state: WatcherState = {
        config: initialConfig,
        debounceTimer: null,
      }

      // Create server
      const { server, close } = createDevServer(
        port,
        verbose,
        () => state.config,
        {
          onRequest: printRequestLog,
          onError: verbose ? (err) => {
            process.stderr.write(chalk.red(`     Detail: ${err.message}\n`))
          } : undefined,
        }
      )

      // Start server
      await new Promise<void>((resolve, reject) => {
        server.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            reject(new CliError(
              `Port ${port} is already in use.\n\n` +
              `Try a different port: orch dev --port ${port + 1}`
            ))
          } else {
            reject(new CliError(`Server error: ${err.message}`))
          }
        })
        server.listen(port, () => resolve())
      })

      // Print banner
      printBanner(initialConfig, port)

      if (dotEnvCount > 0) {
        process.stderr.write(chalk.gray(`  Loaded ${dotEnvCount} variable${dotEnvCount === 1 ? '' : 's'} from .env\n`))
      }

      // Set up file watcher
      let watcher: ReturnType<typeof chokidar.watch> | null = null
      if (watchEnabled) {
        watcher = setupWatcher(agentDir, state, verbose)
      } else {
        process.stderr.write(chalk.gray(`  File watching disabled\n`))
      }

      // Handle shutdown
      const shutdown = async () => {
        process.stderr.write(chalk.gray('\n  Shutting down...\n'))
        if (watcher) {
          await watcher.close()
        }
        await close()
        process.exit(0)
      }

      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)

      // Keep process alive
      await new Promise(() => {})
    })
}
