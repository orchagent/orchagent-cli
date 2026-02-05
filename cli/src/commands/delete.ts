import { Command } from 'commander'
import readline from 'readline/promises'
import chalk from 'chalk'

import { getResolvedConfig } from '../lib/config'
import { listMyAgents, checkAgentDelete, deleteAgent } from '../lib/api'
import { CliError } from '../lib/errors'
import { track } from '../lib/analytics'

async function promptText(message: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  const answer = await rl.question(message)
  rl.close()
  return answer.trim()
}

async function promptConfirm(message: string): Promise<boolean> {
  const answer = await promptText(`${message} (y/N): `)
  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes'
}

function parseAgentArg(value: string): { name: string; version: string } {
  const atIndex = value.lastIndexOf('@')
  if (atIndex === -1 || atIndex === 0) {
    return { name: value, version: 'latest' }
  }
  return {
    name: value.slice(0, atIndex),
    version: value.slice(atIndex + 1) || 'latest',
  }
}

export function registerDeleteCommand(program: Command): void {
  program
    .command('delete <agent>')
    .description('Delete an agent')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--dry-run', 'Show what would be deleted without making changes')
    .addHelpText('after', `
Examples:
  orch delete my-agent           # Delete latest version
  orch delete my-agent@v1        # Delete specific version
  orch delete my-agent --dry-run # Preview deletion
`)
    .action(async (agent: string, options: { yes?: boolean; dryRun?: boolean }) => {
      const { name: agentName, version } = parseAgentArg(agent)
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Not logged in. Run `orch login` first.')
      }

      process.stdout.write('Finding agent...\n')

      // Find the agent
      const agents = await listMyAgents(config)
      const matching = agents.filter(a => a.name === agentName)

      if (matching.length === 0) {
        throw new CliError(`Agent '${agentName}' not found`)
      }

      // Select version
      let selectedAgent
      if (version !== 'latest') {
        selectedAgent = matching.find(a => a.version === version)
        if (!selectedAgent) {
          throw new CliError(`Version '${version}' not found for agent '${agentName}'`)
        }
      } else {
        // Get latest version
        selectedAgent = matching.sort((a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        )[0]
      }

      // Check if confirmation is required
      const deleteCheck = await checkAgentDelete(config, selectedAgent.id)

      // Show agent info
      process.stdout.write(`\n${chalk.bold('Agent:')} ${selectedAgent.name}@${selectedAgent.version}\n`)
      if (deleteCheck.stars_count > 0 || deleteCheck.fork_count > 0) {
        process.stdout.write(`${chalk.bold('Stars:')} ${deleteCheck.stars_count}  ${chalk.bold('Forks:')} ${deleteCheck.fork_count}\n`)
      }
      process.stdout.write('\n')

      // Handle dry-run
      if (options.dryRun) {
        process.stdout.write('\nDRY RUN - No changes will be made\n\n')
        process.stdout.write(`Would delete: ${selectedAgent.name}@${selectedAgent.version}\n`)
        if (deleteCheck.stars_count > 0 || deleteCheck.fork_count > 0) {
          process.stdout.write(chalk.yellow('Warning: This agent has stars or forks\n'))
        }
        process.stdout.write(chalk.gray('\nData would be retained for 30 days before permanent deletion.\n'))
        process.stdout.write('\nNo changes made (dry run)\n')
        return
      }

      // Handle confirmation
      if (!options.yes) {
        if (deleteCheck.requires_confirmation) {
          process.stdout.write(chalk.yellow('Warning: This agent has stars or forks. Type the agent name to confirm deletion.\n\n'))
          const confirmName = await promptText(`Type "${selectedAgent.name}" to confirm deletion: `)

          if (confirmName !== selectedAgent.name) {
            process.stdout.write(chalk.red('\nDeletion cancelled. Name did not match.\n'))
            process.exit(1)
          }
        } else {
          const confirmed = await promptConfirm(`Delete ${selectedAgent.name}@${selectedAgent.version}?`)

          if (!confirmed) {
            process.stdout.write(chalk.gray('Deletion cancelled.\n'))
            process.exit(0)
          }
        }
      }

      // Perform deletion
      process.stdout.write('Deleting agent...\n')
      const confirmationName = deleteCheck.requires_confirmation ? selectedAgent.name : undefined
      await deleteAgent(config, selectedAgent.id, confirmationName)

      await track('cli_delete', { agent_name: selectedAgent.name, version: selectedAgent.version })
      process.stdout.write(`✓ Deleted ${selectedAgent.name}@${selectedAgent.version}\n`)
      process.stdout.write(chalk.gray('\nData will be retained for 30 days before permanent deletion.\n'))
    })
}
