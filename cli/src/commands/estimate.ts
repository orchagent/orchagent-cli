import { Command } from 'commander'
import chalk from 'chalk'

import { getResolvedConfig } from '../lib/config'
import { getAgentCostEstimate, ApiError } from '../lib/api'
import { parseAgentRef } from '../lib/agent-ref'
import { printJson } from '../lib/output'

function formatUsd(amount: number): string {
  if (amount < 0.001) return '<$0.001'
  if (amount < 0.01) return `$${amount.toFixed(4)}`
  if (amount < 1) return `$${amount.toFixed(3)}`
  return `$${amount.toFixed(2)}`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatTokens(count: number): string {
  if (count < 1000) return `${Math.round(count)}`
  return `${(count / 1000).toFixed(1)}k`
}

export function registerEstimateCommand(program: Command): void {
  program
    .command('estimate <agent>')
    .description('Show estimated cost for running an agent')
    .option('--json', 'Output as JSON')
    .action(async (agentArg: string, options: { json?: boolean }) => {
      const config = await getResolvedConfig()
      const { org, agent, version } = parseAgentRef(agentArg)

      if (!org) {
        process.stderr.write(chalk.red('Error: org/agent format required (e.g. myorg/my-agent)\n'))
        process.exit(1)
      }

      let data
      try {
        data = await getAgentCostEstimate(config, org, agent, version)
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          process.stderr.write(chalk.red(`Agent '${org}/${agent}@${version}' not found\n`))
          process.exit(1)
        }
        throw err
      }

      if (options.json) {
        printJson(data)
        return
      }

      const est = data.estimate
      process.stdout.write('\n')
      process.stdout.write(`${chalk.bold(data.agent)}\n`)
      process.stdout.write('='.repeat(40) + '\n\n')

      process.stdout.write(`Type: ${data.type}\n`)
      if (data.execution_engine) {
        process.stdout.write(`Engine: ${data.execution_engine}\n`)
      }
      process.stdout.write(`Providers: ${data.supported_providers.join(', ')}\n`)

      if (est.sample_size === 0) {
        process.stdout.write('\n' + chalk.yellow('No run history available for cost estimation.\n'))
        process.stdout.write(chalk.gray('Run the agent once and re-check for estimates.\n'))
        return
      }

      process.stdout.write(`\n${chalk.bold('Cost Estimate')} ${chalk.gray(`(${est.sample_size} runs, last ${est.period_days}d)`)}\n`)
      process.stdout.write('-'.repeat(40) + '\n')

      // Main cost stats
      process.stdout.write(`  Average:   ${chalk.green(formatUsd(est.avg_cost_usd!))}\n`)
      process.stdout.write(`  Median:    ${chalk.green(formatUsd(est.p50_cost_usd!))}\n`)
      process.stdout.write(`  95th pct:  ${chalk.yellow(formatUsd(est.p95_cost_usd!))}\n`)

      // Token averages
      if (est.avg_input_tokens || est.avg_output_tokens) {
        process.stdout.write(`\n${chalk.bold('Tokens (avg per run)')}\n`)
        process.stdout.write(`  Input:  ${formatTokens(est.avg_input_tokens!)}\n`)
        process.stdout.write(`  Output: ${formatTokens(est.avg_output_tokens!)}\n`)
      }

      // Duration
      if (est.avg_duration_ms) {
        process.stdout.write(`\n${chalk.bold('Duration')}\n`)
        process.stdout.write(`  Average: ${formatDuration(est.avg_duration_ms)}\n`)
      }

      // Success rate
      if (est.success_rate !== undefined) {
        const rateColor = est.success_rate >= 95 ? chalk.green : est.success_rate >= 80 ? chalk.yellow : chalk.red
        process.stdout.write(`  Success: ${rateColor(est.success_rate + '%')}\n`)
      }

      // Provider breakdown
      if (est.provider_breakdown && est.provider_breakdown.length > 0) {
        process.stdout.write(`\n${chalk.bold('By Provider')}\n`)
        for (const p of est.provider_breakdown) {
          const model = p.model !== 'unknown' ? ` (${p.model})` : ''
          process.stdout.write(
            `  ${chalk.cyan(p.provider)}${chalk.gray(model)}: ` +
            `${formatUsd(p.avg_cost_usd)} avg · ${p.runs} runs\n`
          )
        }
      }

      process.stdout.write('\n')
    })
}
