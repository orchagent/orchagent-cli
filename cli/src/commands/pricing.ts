import { Command } from 'commander'
import chalk from 'chalk'

import { getResolvedConfig } from '../lib/config'
import { setAgentPricing, listMyAgents, getOrg } from '../lib/api'
import { CliError, ExitCodes } from '../lib/errors'

export function registerPricingCommand(program: Command): void {
  program
    .command('pricing <agent> <mode>')
    .description('Set pricing for your agent (free or per-call in USD)')
    .option('--local-download', 'Allow users to download and run locally')
    .option('--no-local-download', 'Restrict to server-only (cloud execution)')
    .action(async (agentRef: string, mode: string, options: { localDownload?: boolean }) => {
      const resolved = await getResolvedConfig()

      // Parse agent reference
      const [orgOrAgent, maybeName] = agentRef.split('/')
      let org: string
      let agentName: string

      if (maybeName) {
        // Format: org/agent
        org = orgOrAgent
        agentName = maybeName
      } else {
        // Format: agent (use default org)
        const userOrg = await getOrg(resolved)
        org = userOrg.slug
        agentName = orgOrAgent
      }

      // Look up agent ID
      const myAgents = await listMyAgents(resolved)
      const agent = myAgents.find(a => a.org_slug === org && a.name === agentName)

      if (!agent) {
        throw new CliError(
          `Agent '${org}/${agentName}' not found in your agents.\n\n` +
          `List your agents: orch agents`,
          ExitCodes.NOT_FOUND
        )
      }

      // Parse pricing mode
      let pricingMode: 'free' | 'per_call'
      let pricePerCallCents: number | undefined

      if (mode === 'free' || mode === '0') {
        pricingMode = 'free'
        pricePerCallCents = undefined
      } else {
        // Parse as dollar amount
        const priceFloat = parseFloat(mode)
        if (isNaN(priceFloat)) {
          throw new CliError(
            `Invalid pricing mode: ${mode}\n\n` +
            `Use "free" or a dollar amount (e.g., "0.50" for $0.50 USD)`,
            ExitCodes.INVALID_INPUT
          )
        }
        if (priceFloat < 0.01) {
          throw new CliError(
            'Price must be at least $0.01 USD',
            ExitCodes.INVALID_INPUT
          )
        }
        pricingMode = 'per_call'
        pricePerCallCents = Math.round(priceFloat * 100)
      }

      // Determine allow_local_download value
      let allowLocalDownload: boolean | undefined
      if (pricingMode === 'per_call') {
        // Paid agents are always server-only
        allowLocalDownload = false
        if (options.localDownload) {
          process.stderr.write(chalk.yellow('Note: Paid agents are always server-only. --local-download ignored.\n'))
        }
      } else if (options.localDownload !== undefined) {
        allowLocalDownload = options.localDownload
      }

      // Set pricing
      await setAgentPricing(resolved, agent.id, pricingMode, pricePerCallCents, allowLocalDownload)

      // Show confirmation
      process.stdout.write(chalk.green('✓ Pricing updated\n'))
      process.stdout.write(`Agent: ${org}/${agentName}\n`)

      if (pricingMode === 'free') {
        process.stdout.write(`Mode: FREE\n`)
        if (allowLocalDownload === true) {
          process.stdout.write(`Local download: enabled\n`)
        } else if (allowLocalDownload === false) {
          process.stdout.write(`Local download: disabled (server-only)\n`)
        }
      } else {
        process.stdout.write(`Mode: Pay per call\n`)
        process.stdout.write(`Price: $${(pricePerCallCents! / 100).toFixed(2)} USD per call\n`)
        process.stdout.write(`Local download: disabled (paid agents are server-only)\n`)
      }
    })
}
