#!/usr/bin/env node
import * as Sentry from '@sentry/node'

if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN })
}

import { Command } from 'commander'

import { registerCommands } from './commands'
import { exitWithError } from './lib/errors'
import { enhanceUnknownOptionSuggestions } from './lib/suggest'
import { initPostHog, shutdownPostHog } from './lib/analytics'
import { loadConfig } from './lib/config'
import { shouldAutoJson, setJsonMode } from './lib/output'
import { setProgressEnabled } from './lib/spinner'
import { checkForUpdates, printUpdateNotification } from './lib/update-notifier'
import packageJson from '../package.json'

initPostHog()
checkForUpdates()

const program = new Command()

program
  .name('orchagent')
  .description('orchagent CLI')
  .version(packageJson.version)
  .option('--no-progress', 'Disable progress spinners (useful for CI/scripts)')
  .addHelpText('after', `
Quick Reference:
  run   Run an agent (cloud by default, --local for local execution)
  info  Show agent details and input/output schemas
  fork  Fork a public template into your workspace

Installation:
  npm install -g @orchagent/cli   Install globally (then use: orch)
  npx orchagent <command>         Run without installing

Documentation: https://docs.orchagent.io
  orchagent docs         Open docs in browser
  orchagent docs cli     CLI command reference
  orchagent docs agents  Building agents guide
`)

registerCommands(program)
enhanceUnknownOptionSuggestions(program)

// Initialize progress setting before parsing
async function main() {
  // Check config for no_progress setting
  const config = await loadConfig()
  if (config.no_progress) {
    setProgressEnabled(false)
  }

  // Parse args - hook handles --no-progress and TTY auto-detection
  program.hook('preAction', (_thisCommand, actionCommand) => {
    const opts = program.opts()
    if (opts.progress === false) {
      setProgressEnabled(false)
    }

    // TTY auto-detection: non-TTY → auto-enable JSON on commands that support it
    // This lets piped output (orch agents | jq .) and agent consumers get JSON automatically.
    // Override: ORCHAGENT_OUTPUT=text forces human-readable even in non-TTY.
    const hasJsonOption = actionCommand.options.some(
      (o: { long?: string }) => o.long === '--json'
    )
    if (hasJsonOption && actionCommand.getOptionValue('json') === undefined) {
      if (shouldAutoJson()) {
        actionCommand.setOptionValue('json', true)
        setProgressEnabled(false)
      }
    }

    // Track JSON mode globally so exitWithError can output structured errors
    if (actionCommand.getOptionValue('json')) {
      setJsonMode(true)
    }

    // Also disable progress spinners in non-TTY (even if command has no --json option)
    if (!process.stdout.isTTY) {
      setProgressEnabled(false)
    }
  })

  await program.parseAsync(process.argv)
}

main()
  .catch(exitWithError)
  .finally(() => {
    printUpdateNotification()
    return shutdownPostHog()
  })
