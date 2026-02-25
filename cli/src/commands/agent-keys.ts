import { Command } from 'commander'
import chalk from 'chalk'

import { getResolvedConfig, loadConfig } from '../lib/config'
import { listMyAgents, listAgentKeys, createAgentKey, deleteAgentKey, resolveWorkspaceIdForOrg } from '../lib/api'
import { CliError } from '../lib/errors'
import { saveServiceKey, loadServiceKeys } from '../lib/key-store'
import type { ResolvedConfig, Agent } from '../types'

/**
 * Resolve an agent reference ("org/agent" or just "agent") to an agent ID.
 * Uses the authenticated list-agents endpoint and finds the latest version.
 */
async function resolveAgentId(config: ResolvedConfig, ref: string): Promise<{ agent: Agent; agentId: string; orgSlug: string; workspaceId?: string }> {
  const parts = ref.split('/')
  const agentName = parts.length >= 2 ? parts[1] : parts[0]
  const orgSlug = parts.length >= 2 ? parts[0] : undefined

  // Resolve workspace context from org slug or config
  const configFile = await loadConfig()
  const resolvedOrg = orgSlug ?? configFile.workspace ?? config.defaultOrg
  const workspaceId = resolvedOrg ? await resolveWorkspaceIdForOrg(config, resolvedOrg) : undefined

  const agents = await listMyAgents(config, workspaceId)
  const matching = agents.filter(a => a.name === agentName)

  if (matching.length === 0) {
    throw new CliError(`Agent '${ref}' not found. Run 'orchagent agents' to list your agents.`)
  }

  // Use the latest version
  const latest = matching.sort((a, b) =>
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  )[0]

  return { agent: latest, agentId: latest.id, orgSlug: latest.org_slug ?? resolvedOrg ?? '', workspaceId }
}

export function registerAgentKeysCommand(program: Command): void {
  const agentKeys = program
    .command('agent-keys')
    .description('Manage agent service keys')

  agentKeys
    .command('list <agent>')
    .description('List service keys for an agent (org/name or name)')
    .action(async (ref: string) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orchagent login` first.')
      }

      const { agent, agentId, orgSlug, workspaceId } = await resolveAgentId(config, ref)
      const result = await listAgentKeys(config, agentId, workspaceId)

      // Load locally-saved keys for this agent
      const localKeys = await loadServiceKeys(orgSlug, agent.name)
      const localPrefixes = new Set(localKeys.map(k => k.prefix))

      if (result.keys.length === 0) {
        process.stdout.write(`No service keys for ${agent.name}.\n`)
        process.stdout.write(`\nCreate one with: orchagent agent-keys create ${ref}\n`)
        return
      }

      process.stdout.write(`Service keys for ${agent.name}:\n\n`)
      process.stdout.write(`  ${'ID'.padEnd(38)} ${'PREFIX'.padEnd(14)} ${'CREATED'.padEnd(22)} ${'LAST USED'.padEnd(22)} SAVED\n`)
      process.stdout.write(`  ${'─'.repeat(38)} ${'─'.repeat(14)} ${'─'.repeat(22)} ${'─'.repeat(22)} ${'─'.repeat(5)}\n`)

      for (const key of result.keys) {
        const created = new Date(key.created_at).toLocaleDateString()
        const lastUsed = key.last_used_at
          ? new Date(key.last_used_at).toLocaleDateString()
          : chalk.gray('never')
        const saved = localPrefixes.has(key.prefix) ? chalk.green('yes') : chalk.gray('no')
        process.stdout.write(`  ${key.id.padEnd(38)} ${key.prefix.padEnd(14)} ${created.padEnd(22)} ${String(lastUsed).padEnd(22)} ${saved}\n`)
      }

      if (localKeys.length > 0) {
        process.stdout.write(`\n  ${chalk.gray('Keys marked "yes" can be retrieved from ~/.orchagent/keys/')}\n`)
      }
      process.stdout.write('\n')
    })

  agentKeys
    .command('create <agent>')
    .description('Create a new service key for an agent')
    .action(async (ref: string) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orchagent login` first.')
      }

      const { agent, orgSlug, workspaceId } = await resolveAgentId(config, ref)
      const result = await createAgentKey(config, agent.id, workspaceId)

      process.stdout.write(`\nNew service key for ${agent.name}:\n\n`)
      process.stdout.write(`  ${result.key}\n\n`)

      try {
        const savedPath = await saveServiceKey(orgSlug, agent.name, agent.version, result.key, result.prefix)
        process.stdout.write(`  ${chalk.gray(`Saved to ${savedPath}`)}\n`)
      } catch {
        process.stderr.write(chalk.yellow('Could not save key locally. Copy it now — it cannot be retrieved from the server.\n'))
      }
    })

  agentKeys
    .command('delete <agent> <key-id>')
    .description('Delete a service key')
    .action(async (ref: string, keyId: string) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orchagent login` first.')
      }

      const { agent, agentId, workspaceId } = await resolveAgentId(config, ref)
      await deleteAgentKey(config, agentId, keyId, workspaceId)

      process.stdout.write(`Deleted key ${keyId} from ${agent.name}.\n`)
    })
}
