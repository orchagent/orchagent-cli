import { Command } from 'commander'
import readline from 'readline/promises'
import chalk from 'chalk'

import { getResolvedConfig } from '../lib/config'
import { request, listMyAgents, checkAgentTransfer, transferAgent } from '../lib/api'
import { CliError } from '../lib/errors'
import { track } from '../lib/analytics'
import { printJson } from '../lib/output'

interface Workspace {
  id: string
  name: string
  slug: string
  type: string
  role: string
  member_count: number
}

interface WorkspacesResponse {
  workspaces: Workspace[]
}

async function promptText(message: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  const answer = await rl.question(message)
  rl.close()
  return answer.trim()
}

export function registerTransferCommand(program: Command): void {
  program
    .command('transfer <agent-name>')
    .description('Transfer an agent to another workspace')
    .requiredOption('--to <workspace-slug>', 'Target workspace slug')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--dry-run', 'Show what would be transferred without making changes')
    .option('--json', 'Output result as JSON')
    .addHelpText('after', `
Examples:
  orch transfer my-agent --to team-workspace           # Transfer agent to another workspace
  orch transfer my-agent --to team-workspace --dry-run  # Preview transfer
  orch transfer my-agent --to team-workspace --yes      # Skip confirmation
`)
    .action(async (agentName: string, options: { to: string; yes?: boolean; dryRun?: boolean; json?: boolean }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Not logged in. Run `orchagent login` first.')
      }

      process.stdout.write('Finding agent and workspaces...\n')

      // Fetch workspaces and agents in parallel
      const [workspacesResponse, agents] = await Promise.all([
        request<WorkspacesResponse>(config, 'GET', '/workspaces'),
        listMyAgents(config),
      ])

      // Find the target workspace by slug
      const targetWorkspace = workspacesResponse.workspaces.find((w) => w.slug === options.to)
      if (!targetWorkspace) {
        throw new CliError(
          `Workspace '${options.to}' not found. Run \`orchagent workspace list\` to see available workspaces.`
        )
      }

      // Find the agent by name
      const matching = agents.filter((a) => a.name === agentName)
      if (matching.length === 0) {
        throw new CliError(`Agent '${agentName}' not found in current workspace.`)
      }

      // Use the most recent version to get the agent ID
      const agent = matching.sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      )[0]

      // Check transfer eligibility
      const check = await checkAgentTransfer(config, agent.id, targetWorkspace.id)

      // Show transfer summary
      process.stdout.write(`\n${chalk.bold('Agent:')} ${agent.name}\n`)
      process.stdout.write(`${chalk.bold('Target workspace:')} ${targetWorkspace.name} (${targetWorkspace.slug})\n`)

      const { details } = check
      process.stdout.write(`${chalk.bold('Versions:')} ${details.version_count}\n`)
      if (details.grants_count > 0) {
        process.stdout.write(`${chalk.bold('Grants to revoke:')} ${details.grants_count}\n`)
      }
      if (details.keys_count > 0) {
        process.stdout.write(`${chalk.bold('Keys to delete:')} ${details.keys_count}\n`)
      }
      if (details.schedules_count > 0) {
        process.stdout.write(`${chalk.bold('Schedules to disable:')} ${details.schedules_count}\n`)
      }
      process.stdout.write('\n')

      // Show warnings
      if (check.warnings.length > 0) {
        for (const warning of check.warnings) {
          process.stdout.write(chalk.yellow(`Warning: ${warning}\n`))
        }
        process.stdout.write('\n')
      }

      // Show blockers and exit if any
      if (check.blockers.length > 0) {
        for (const blocker of check.blockers) {
          process.stdout.write(chalk.red(`Blocker: ${blocker}\n`))
        }
        process.stdout.write(chalk.red('\nTransfer cannot proceed due to blockers above.\n'))
        process.exit(1)
      }

      // Handle dry-run
      if (options.dryRun) {
        process.stdout.write('DRY RUN - No changes will be made\n\n')
        process.stdout.write(`Would transfer: ${agent.name} (${details.version_count} version(s))\n`)
        process.stdout.write(`Target: ${targetWorkspace.name} (${targetWorkspace.slug})\n`)
        if (details.grants_count > 0 || details.keys_count > 0 || details.schedules_count > 0) {
          process.stdout.write(
            chalk.yellow(
              `Cleanup: ${details.grants_count} grant(s) revoked, ${details.keys_count} key(s) deleted, ${details.schedules_count} schedule(s) disabled\n`
            )
          )
        }
        process.stdout.write('\nNo changes made (dry run)\n')
        return
      }

      // Prompt for confirmation
      if (!options.yes) {
        process.stdout.write(chalk.yellow('This will transfer the agent and all its versions to the target workspace.\n'))
        process.stdout.write(chalk.yellow('Existing grants, keys, and schedules in the source workspace will be cleaned up.\n\n'))
        const confirmName = await promptText(`Type "${agent.name}" to confirm transfer: `)

        if (confirmName !== agent.name) {
          process.stdout.write(chalk.red('\nTransfer cancelled. Name did not match.\n'))
          process.exit(1)
        }
      }

      // Perform transfer
      process.stdout.write('Transferring agent...\n')
      const result = await transferAgent(config, agent.id, {
        target_workspace_id: targetWorkspace.id,
        confirmation_name: agent.name,
      })

      await track('cli_transfer', {
        agent_name: result.agent_name,
        versions_transferred: result.versions_transferred,
        target_workspace: result.target_workspace.slug,
      })

      if (options.json) {
        printJson(result)
        return
      }

      process.stdout.write(`\n${chalk.green('+')} Transferred ${result.agent_name} (${result.versions_transferred} version(s))\n`)
      process.stdout.write(`  From: ${result.source_workspace.name} (${result.source_workspace.slug})\n`)
      process.stdout.write(`  To:   ${result.target_workspace.name} (${result.target_workspace.slug})\n`)
      if (result.cleanup.grants_revoked > 0 || result.cleanup.keys_deleted > 0 || result.cleanup.schedules_disabled > 0) {
        process.stdout.write(
          chalk.gray(
            `\nCleanup: ${result.cleanup.grants_revoked} grant(s) revoked, ${result.cleanup.keys_deleted} key(s) deleted, ${result.cleanup.schedules_disabled} schedule(s) disabled\n`
          )
        )
      }
    })
}
