#!/usr/bin/env node
import * as Sentry from '@sentry/node'

if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN })
}

import { Command } from 'commander'

import { registerCommands } from './commands'
import { exitWithError } from './lib/errors'
import { initPostHog, shutdownPostHog } from './lib/analytics'
import { loadConfig } from './lib/config'
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
  run   Download and run an agent locally (your machine)
  call  Execute an agent on orchagent servers (requires login)
  info  Show agent details and input/output schemas

Installation:
  npm install -g @orchagent/cli   Install globally (then use: orch)
  npx orchagent <command>         Run without installing

Documentation: https://docs.orchagent.io
  orchagent docs         Open docs in browser
  orchagent docs cli     CLI command reference
  orchagent docs agents  Building agents guide
`)

registerCommands(program)

// Initialize progress setting before parsing
async function main() {
  // Check config for no_progress setting
  const config = await loadConfig()
  if (config.no_progress) {
    setProgressEnabled(false)
  }

  // Parse args - hook will set noProgress if --no-progress flag is passed
  program.hook('preAction', () => {
    const opts = program.opts()
    if (opts.progress === false) {
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
