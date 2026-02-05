import { Command } from 'commander'
import Table from 'cli-table3'
import chalk from 'chalk'
import open from 'open'

import { getResolvedConfig } from '../lib/config'
import {
  createSellerOnboarding,
  getSellerStatus,
  getSellerDashboardLink,
  getSellerEarnings,
} from '../lib/api'
import { ApiError } from '../lib/api'
import { CliError, ExitCodes } from '../lib/errors'
import { printJson } from '../lib/output'

export function registerSellerCommand(program: Command): void {
  const seller = program
    .command('seller')
    .description('Manage seller account for monetizing your agents')

  // orch seller onboard
  seller
    .command('onboard')
    .description('Start Stripe seller onboarding process')
    .option('--country <code>', 'Country code (default: GB)', 'GB')
    .action(async (options) => {
      const resolved = await getResolvedConfig()
      const country = options.country || 'GB'

      // Create onboarding session
      const response = await createSellerOnboarding(resolved, country)

      // Open in browser
      process.stdout.write(`\nOpening Stripe onboarding...\n`)
      process.stdout.write(`Country: ${country}\n\n`)
      await open(response.onboarding_url)
      process.stdout.write(chalk.gray(`If browser doesn't open, visit:\n${response.onboarding_url}\n`))
    })

  // orch seller status
  seller
    .command('status')
    .description('Check seller account status')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const resolved = await getResolvedConfig()
      const status = await getSellerStatus(resolved)

      if (options.json) {
        printJson(status)
        return
      }

      // Display status
      if (!status.onboarded) {
        process.stdout.write(chalk.yellow('\nNot onboarded\n\n'))
        process.stdout.write('Start selling: orch seller onboard\n')
        return
      }

      process.stdout.write(chalk.green('\n✓ Onboarded\n\n'))
      if (status.charges_enabled !== undefined) {
        const chargesStatus = status.charges_enabled ? chalk.green('✓ Enabled') : chalk.yellow('⚠ Disabled')
        process.stdout.write(`Charges: ${chargesStatus}\n`)
      }
      if (status.payouts_enabled !== undefined) {
        const payoutsStatus = status.payouts_enabled ? chalk.green('✓ Enabled') : chalk.yellow('⚠ Disabled')
        process.stdout.write(`Payouts: ${payoutsStatus}\n`)
      }

      if (!status.charges_enabled || !status.payouts_enabled) {
        process.stdout.write(chalk.gray('\nComplete setup: orch seller dashboard\n'))
      }
    })

  // orch seller dashboard
  seller
    .command('dashboard')
    .description('Open Stripe Express dashboard')
    .action(async () => {
      const resolved = await getResolvedConfig()

      try {
        const response = await getSellerDashboardLink(resolved)

        // Open in browser
        process.stdout.write('\nOpening Stripe dashboard...\n\n')
        await open(response.dashboard_url)
        process.stdout.write(chalk.gray(`If browser doesn't open, visit:\n${response.dashboard_url}\n`))
      } catch (err) {
        if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
          process.stdout.write(chalk.yellow('\nNo seller account found\n\n'))
          process.stdout.write('Complete onboarding: orch seller onboard\n')
          process.exit(ExitCodes.NOT_FOUND)
        }
        throw err
      }
    })

  // orch seller earnings
  seller
    .command('earnings')
    .description('Show earnings from your agents')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const resolved = await getResolvedConfig()
      const earnings = await getSellerEarnings(resolved)

      if (options.json) {
        printJson(earnings)
        return
      }

      // Show total earnings
      const total = earnings.total_earnings_cents / 100
      process.stdout.write(chalk.bold(`\nTotal Earnings: ${chalk.green(`$${total.toFixed(2)} USD`)}\n\n`))

      // Show earnings by agent
      if (earnings.by_agent && earnings.by_agent.length > 0) {
        process.stdout.write(chalk.bold('Earnings by Agent:\n'))
        const table = new Table({
          head: [
            chalk.bold('Agent'),
            chalk.bold('Calls'),
            chalk.bold('Earnings'),
          ],
        })

        earnings.by_agent.forEach((item) => {
          const earningsStr = `$${(item.earnings_cents / 100).toFixed(2)}`
          table.push([item.agent_name, item.calls.toString(), earningsStr])
        })

        process.stdout.write(`${table.toString()}\n\n`)
      }

      // Show recent transactions
      if (earnings.recent_transactions && earnings.recent_transactions.length > 0) {
        process.stdout.write(chalk.bold('Recent Transactions:\n'))
        const table = new Table({
          head: [
            chalk.bold('Date'),
            chalk.bold('Agent'),
            chalk.bold('Sale'),
            chalk.bold('Your Cut'),
            chalk.bold('Fee'),
          ],
        })

        earnings.recent_transactions.forEach((tx) => {
          const date = new Date(tx.created_at).toLocaleDateString()
          const sale = `$${(tx.sale_amount_cents / 100).toFixed(2)}`
          const cut = `$${(tx.earnings_cents / 100).toFixed(2)}`
          const fee = `$${(tx.fee_cents / 100).toFixed(2)}`
          table.push([date, tx.agent_name, sale, cut, fee])
        })

        process.stdout.write(`${table.toString()}\n\n`)
      }

      process.stdout.write(chalk.gray('Manage payouts: orch seller dashboard\n'))
    })
}
