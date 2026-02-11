import { Command } from 'commander'
import readline from 'readline/promises'
import chalk from 'chalk'

import { getResolvedConfig, loadConfig } from '../lib/config'
import { request, listMyAgents, checkAgentTransfer, transferAgent, ApiError } from '../lib/api'
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

interface AgentSummary {
  id: string
  name: string
  created_at: string
}

function getTransferAuthError(err: unknown): CliError | null {
  if (!(err instanceof ApiError) || err.status !== 403) {
    return null
  }
  const message = err.message.toLowerCase()
  if (
    message.includes('personal workspace session key') ||
    message.includes('user authentication') ||
    message.includes('clerk jwt')
  ) {
    return new CliError(
      'Transfer requires a user session key. Run `orch login` (browser sign-in, without `--key`) and retry.'
    )
  }
  return null
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
    .option('-w, --workspace <workspace-slug>', 'Source workspace slug (defaults to active workspace)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--dry-run', 'Show what would be transferred without making changes')
    .option('--json', 'Output result as JSON')
    .addHelpText('after', `
Examples:
  orch transfer my-agent --to team-workspace           # Transfer agent to another workspace
  orch transfer my-agent --to team-workspace --workspace my-team
  orch transfer my-agent --to team-workspace --dry-run  # Preview transfer
  orch transfer my-agent --to team-workspace --yes      # Skip confirmation
`)
    .action(async (agentName: string, options: { to: string; workspace?: string; yes?: boolean; dryRun?: boolean; json?: boolean }) => {
      const write = (message: string) => {
        if (!options.json) process.stdout.write(message)
      }

      const config = await getResolvedConfig()
      const configFile = await loadConfig()
      if (!config.apiKey) {
        throw new CliError('Not logged in. Run `orchagent login` first.')
      }

      write('Finding agent and workspaces...\n')

      // Fetch workspace list first (needed to resolve source/target IDs).
      const workspacesResponse = await request<WorkspacesResponse>(config, 'GET', '/workspaces')

      // Find the target workspace by slug
      const targetWorkspace = workspacesResponse.workspaces.find((w) => w.slug === options.to)
      if (!targetWorkspace) {
        throw new CliError(
          `Workspace '${options.to}' not found. Run \`orchagent workspace list\` to see available workspaces.`
        )
      }

      // Resolve source workspace (optional). If set, list agents from that workspace.
      const sourceWorkspaceSlug = options.workspace ?? configFile.workspace
      const sourceWorkspace = sourceWorkspaceSlug
        ? workspacesResponse.workspaces.find((w) => w.slug === sourceWorkspaceSlug)
        : null

      if (sourceWorkspaceSlug && !sourceWorkspace) {
        throw new CliError(
          `Source workspace '${sourceWorkspaceSlug}' not found. Run \`orchagent workspace list\` to see available workspaces.`
        )
      }

      if (sourceWorkspace && sourceWorkspace.id === targetWorkspace.id) {
        throw new CliError('Source and target workspaces must be different.')
      }

      const agents: AgentSummary[] = sourceWorkspace
        ? await request<AgentSummary[]>(
            config,
            'GET',
            `/agents?workspace_id=${encodeURIComponent(sourceWorkspace.id)}`
          )
        : (await listMyAgents(config)) as AgentSummary[]

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
      let check
      try {
        check = await checkAgentTransfer(config, agent.id, targetWorkspace.id)
      } catch (err) {
        const authErr = getTransferAuthError(err)
        if (authErr) throw authErr
        throw err
      }

      // Show transfer summary
      write(`\n${chalk.bold('Agent:')} ${agent.name}\n`)
      write(`${chalk.bold('Target workspace:')} ${targetWorkspace.name} (${targetWorkspace.slug})\n`)

      const { details } = check
      write(`${chalk.bold('Versions:')} ${details.version_count}\n`)
      if (details.grants_count > 0) {
        write(`${chalk.bold('Grants to revoke:')} ${details.grants_count}\n`)
      }
      if (details.keys_count > 0) {
        write(`${chalk.bold('Keys to delete:')} ${details.keys_count}\n`)
      }
      if (details.schedules_count > 0) {
        write(`${chalk.bold('Schedules to disable:')} ${details.schedules_count}\n`)
      }
      write('\n')

      // Show warnings
      if (check.warnings.length > 0) {
        for (const warning of check.warnings) {
          write(chalk.yellow(`Warning: ${warning}\n`))
        }
        write('\n')
      }

      // Show blockers and exit if any
      if (check.blockers.length > 0) {
        if (options.json) {
          printJson({
            can_transfer: false,
            blockers: check.blockers,
            warnings: check.warnings,
            details,
            agent_name: agent.name,
            target_workspace: {
              id: targetWorkspace.id,
              slug: targetWorkspace.slug,
              name: targetWorkspace.name,
            },
          })
          process.exit(1)
        }
        for (const blocker of check.blockers) {
          write(chalk.red(`Blocker: ${blocker}\n`))
        }
        write(chalk.red('\nTransfer cannot proceed due to blockers above.\n'))
        process.exit(1)
      }

      // Handle dry-run
      if (options.dryRun) {
        if (options.json) {
          printJson({
            dry_run: true,
            can_transfer: true,
            agent_name: agent.name,
            target_workspace: {
              id: targetWorkspace.id,
              slug: targetWorkspace.slug,
              name: targetWorkspace.name,
            },
            details,
            warnings: check.warnings,
            blockers: check.blockers,
          })
          return
        }
        write('DRY RUN - No changes will be made\n\n')
        write(`Would transfer: ${agent.name} (${details.version_count} version(s))\n`)
        write(`Target: ${targetWorkspace.name} (${targetWorkspace.slug})\n`)
        if (details.grants_count > 0 || details.keys_count > 0 || details.schedules_count > 0) {
          write(
            chalk.yellow(
              `Cleanup: ${details.grants_count} grant(s) revoked, ${details.keys_count} key(s) deleted, ${details.schedules_count} schedule(s) disabled\n`
            )
          )
        }
        write('\nNo changes made (dry run)\n')
        return
      }

      // Prompt for confirmation
      if (!options.yes) {
        write(chalk.yellow('This will transfer the agent and all its versions to the target workspace.\n'))
        write(chalk.yellow('Existing grants, keys, and schedules in the source workspace will be cleaned up.\n\n'))
        const confirmName = await promptText(`Type "${agent.name}" to confirm transfer: `)

        if (confirmName !== agent.name) {
          if (options.json) {
            printJson({ cancelled: true, reason: 'confirmation_mismatch' })
          } else {
            write(chalk.red('\nTransfer cancelled. Name did not match.\n'))
          }
          process.exit(1)
        }
      }

      // Perform transfer
      write('Transferring agent...\n')
      let result
      try {
        result = await transferAgent(config, agent.id, {
          target_workspace_id: targetWorkspace.id,
          confirmation_name: agent.name,
        })
      } catch (err) {
        const authErr = getTransferAuthError(err)
        if (authErr) throw authErr
        throw err
      }

      await track('cli_transfer', {
        agent_name: result.agent_name,
        versions_transferred: result.versions_transferred,
        target_workspace: result.target_workspace.slug,
      })

      if (options.json) {
        printJson(result)
        return
      }

      write(`\n${chalk.green('+')} Transferred ${result.agent_name} (${result.versions_transferred} version(s))\n`)
      write(`  From: ${result.source_workspace.name} (${result.source_workspace.slug})\n`)
      write(`  To:   ${result.target_workspace.name} (${result.target_workspace.slug})\n`)
      if (result.cleanup.grants_revoked > 0 || result.cleanup.keys_deleted > 0 || result.cleanup.schedules_disabled > 0) {
        write(
          chalk.gray(
            `\nCleanup: ${result.cleanup.grants_revoked} grant(s) revoked, ${result.cleanup.keys_deleted} key(s) deleted, ${result.cleanup.schedules_disabled} schedule(s) disabled\n`
          )
        )
      }
    })
}
