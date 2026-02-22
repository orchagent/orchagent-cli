import { Command } from 'commander'
import chalk from 'chalk'

import { getResolvedConfig } from '../lib/config'
import { getPublicAgent, request, forkAgent, ApiError } from '../lib/api'
import { parseAgentRef } from '../lib/agent-ref'
import { CliError } from '../lib/errors'
import { track } from '../lib/analytics'
import { printJson } from '../lib/output'
import { saveServiceKey } from '../lib/key-store'

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

function getWorkspaceAuthError(err: unknown): CliError | null {
  if (!(err instanceof ApiError) || (err.status !== 401 && err.status !== 403)) {
    return null
  }
  const message = err.message.toLowerCase()
  if (
    message.includes('workspace targeting') ||
    message.includes('specified workspace') ||
    message.includes('user authentication') ||
    message.includes('clerk')
  ) {
    return new CliError(
      'Forking into a specific workspace requires a user session key. Run `orch login` (browser sign-in, without `--key`) and retry.'
    )
  }
  return null
}

async function resolveWorkspace(
  config: { apiKey?: string; apiUrl: string },
  workspaceSlug: string
): Promise<Workspace> {
  const response = await request<WorkspacesResponse>(config, 'GET', '/workspaces')
  const workspace = response.workspaces.find((w) => w.slug === workspaceSlug)
  if (!workspace) {
    throw new CliError(
      `Workspace '${workspaceSlug}' not found. Run \`orchagent workspace list\` to see available workspaces.`
    )
  }
  return workspace
}

export function registerForkCommand(program: Command): void {
  program
    .command('fork <agent>')
    .description('Fork a public agent into your workspace')
    .option('--name <new-name>', 'Rename the forked agent')
    .option('-w, --workspace <workspace-slug>', 'Target workspace slug')
    .option('--json', 'Output raw JSON')
    .addHelpText('after', `
Examples:
  orch fork orchagent/my-discord-agent
  orch fork orchagent/my-discord-agent --workspace acme-corp
  orch fork orchagent/my-discord-agent --name customer-support-bot
  orch fork orchagent/my-discord-agent@v2 --json
`)
    .action(async (agentRef: string, options: { name?: string; workspace?: string; json?: boolean }) => {
      const write = (message: string) => {
        if (!options.json) process.stdout.write(message)
      }

      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Not logged in. Run `orchagent login` first.')
      }

      const { org, agent, version } = parseAgentRef(agentRef)

      write('Resolving source agent...\n')
      const source = await getPublicAgent(config, org, agent, version)
      if (!source.id) {
        throw new CliError(
          `Could not resolve source agent ID for '${org}/${agent}@${version}'.`
        )
      }

      let targetWorkspace: Workspace | null = null
      if (options.workspace) {
        write('Resolving target workspace...\n')
        targetWorkspace = await resolveWorkspace(config, options.workspace)
      }

      write('Forking agent...\n')

      const payload: { workspace_id?: string; new_name?: string } = {}
      if (targetWorkspace) payload.workspace_id = targetWorkspace.id
      const requestedName = options.name?.trim()
      if (requestedName) payload.new_name = requestedName

      let result
      try {
        result = await forkAgent(config, source.id, payload)
      } catch (err) {
        const authErr = getWorkspaceAuthError(err)
        if (authErr) throw authErr
        throw err
      }

      await track('cli_fork', {
        source_org: org,
        source_agent: agent,
        source_version: version,
        target_workspace: targetWorkspace?.slug ?? null,
      })

      if (options.json) {
        printJson(result)
        return
      }

      const forked = result.agent
      const targetOrgSlug = forked.org_slug ?? targetWorkspace?.slug ?? 'current-workspace'
      write(`\n${chalk.green('\u2713')} Forked ${org}/${agent}@${version}\n`)
      write(`  New agent: ${targetOrgSlug}/${forked.name}@${forked.version}\n`)

      if (targetWorkspace) {
        write(`  Workspace: ${targetWorkspace.name} (${targetWorkspace.slug})\n`)
      }

      if (result.service_key) {
        write(`\nService key:\n`)
        write(`  ${result.service_key}\n`)
        try {
          const keyPrefix = result.service_key.substring(0, 12)
          const savedPath = await saveServiceKey(targetOrgSlug, forked.name, forked.version, result.service_key, keyPrefix)
          write(`  ${chalk.gray(`Saved to ${savedPath}`)}\n`)
        } catch {
          write(`  ${chalk.yellow('Could not save key locally. Copy it now — it cannot be retrieved from the server.')}\n`)
        }
        write(`  Retrieve later: ${chalk.cyan(`orch agent-keys list ${targetOrgSlug}/${forked.name}`)}\n`)
      }
    })
}
