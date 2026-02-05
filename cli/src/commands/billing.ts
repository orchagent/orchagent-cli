import { Command } from 'commander'
import Table from 'cli-table3'
import chalk from 'chalk'
import open from 'open'

import { getResolvedConfig } from '../lib/config'
import { getCreditsBalance, createCreditCheckout } from '../lib/api'
import { CliError, ExitCodes } from '../lib/errors'
import { printJson } from '../lib/output'

export function registerBillingCommand(program: Command): void {
  const billing = program
    .command('billing')
    .description('Manage prepaid credits for calling paid agents')

  // orch billing balance
  billing
    .command('balance')
    .description('Show your credit balance and recent transactions')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const resolved = await getResolvedConfig()
      const data = await getCreditsBalance(resolved)

      if (options.json) {
        printJson(data)
        return
      }

      // Show balance
      const balance = data.balance_cents / 100
      process.stdout.write(chalk.bold(`\nBalance: ${chalk.green(`$${balance.toFixed(2)} USD`)}\n\n`))

      // Show recent transactions
      if (data.recent_transactions && data.recent_transactions.length > 0) {
        process.stdout.write(chalk.bold('Recent Transactions:\n'))
        const table = new Table({
          head: [
            chalk.bold('Date'),
            chalk.bold('Type'),
            chalk.bold('Amount'),
            chalk.bold('Balance'),
          ],
        })

        data.recent_transactions.forEach((tx) => {
          const date = new Date(tx.created_at).toLocaleDateString()
          const amount = (tx.amount_cents / 100).toFixed(2)
          const balance = (tx.balance_after_cents / 100).toFixed(2)
          const amountColor = tx.amount_cents >= 0 ? chalk.green : chalk.red
          table.push([date, tx.transaction_type, amountColor(`$${amount}`), `$${balance}`])
        })

        process.stdout.write(`${table.toString()}\n\n`)
      } else {
        process.stdout.write('No recent transactions\n\n')
      }

      process.stdout.write(chalk.gray('Add credits: orch billing add 5\n'))
    })

  // orch billing add <amount>
  billing
    .command('add [amount]')
    .description('Add credits via Stripe checkout (minimum $5.00 USD)')
    .action(async (amount?: string) => {
      const resolved = await getResolvedConfig()

      // Parse and validate amount
      let amountNum: number
      if (!amount) {
        amountNum = 5.00  // Default to $5
      } else {
        amountNum = parseFloat(amount)
        if (isNaN(amountNum) || amountNum < 5.00) {
          throw new CliError('Amount must be at least $5.00 USD', ExitCodes.INVALID_INPUT)
        }
      }

      const amountCents = Math.round(amountNum * 100)

      // Create checkout session
      const checkout = await createCreditCheckout(resolved, amountCents)

      // Open in browser
      process.stdout.write(`\nOpening checkout page...\n`)
      process.stdout.write(`Amount: $${amountNum.toFixed(2)} USD\n\n`)
      await open(checkout.checkout_url)
      process.stdout.write(chalk.gray(`If browser doesn't open, visit:\n${checkout.checkout_url}\n`))
    })

  // orch billing history (alias)
  billing
    .command('history')
    .description('Show transaction history (alias for balance)')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      // Just call balance command
      const resolved = await getResolvedConfig()
      const data = await getCreditsBalance(resolved)

      if (options.json) {
        printJson(data)
        return
      }

      // Simplified view - just show transactions
      if (data.recent_transactions && data.recent_transactions.length > 0) {
        const table = new Table({
          head: [
            chalk.bold('Date'),
            chalk.bold('Type'),
            chalk.bold('Amount'),
            chalk.bold('Balance'),
          ],
        })

        data.recent_transactions.forEach((tx) => {
          const date = new Date(tx.created_at).toLocaleDateString()
          const amount = (tx.amount_cents / 100).toFixed(2)
          const balance = (tx.balance_after_cents / 100).toFixed(2)
          const amountColor = tx.amount_cents >= 0 ? chalk.green : chalk.red
          table.push([date, tx.transaction_type, amountColor(`$${amount}`), `$${balance}`])
        })

        process.stdout.write(`\n${table.toString()}\n\n`)
      } else {
        process.stdout.write('\nNo transactions found\n\n')
      }

      const balance = data.balance_cents / 100
      process.stdout.write(chalk.gray(`Current balance: $${balance.toFixed(2)} USD\n`))
    })
}
