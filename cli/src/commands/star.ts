import { Command } from 'commander'

import { getResolvedConfig } from '../lib/config'
import { starAgent, unstarAgent, getPublicAgent } from '../lib/api'
import { CliError } from '../lib/errors'
import { track } from '../lib/analytics'

function parseAgentRef(ref: string): { org: string; name: string; version: string } {
  // Format: org/agent/version or org/agent (defaults to v1)
  const parts = ref.split('/')
  if (parts.length < 2 || parts.length > 3) {
    throw new CliError('Invalid agent reference. Use: org/agent or org/agent/version')
  }
  return {
    org: parts[0],
    name: parts[1],
    version: parts[2] || 'v1',
  }
}

export function registerStarCommand(program: Command): void {
  program
    .command('star')
    .description('Star an agent')
    .argument('<agent>', 'Agent reference (org/name or org/name/version)')
    .option('--remove', 'Remove star instead of adding')
    .action(async (agent: string, options: { remove?: boolean }) => {
      const config = await getResolvedConfig()
      const { org, name, version } = parseAgentRef(agent)

      // Get the agent to get its ID
      const agentInfo = await getPublicAgent(config, org, name, version)

      if (options.remove) {
        await unstarAgent(config, agentInfo.id)
        process.stdout.write(`Removed star from ${org}/${name}/${version}\n`)
      } else {
        const result = await starAgent(config, agentInfo.id)
        if (result.starred) {
          await track('cli_star', { agent: `${org}/${name}/${version}` })
          process.stdout.write(`Starred ${org}/${name}/${version}\n`)
        } else {
          // Already starred — toggle off
          await unstarAgent(config, agentInfo.id)
          process.stdout.write(`Unstarred ${org}/${name}/${version}\n`)
        }
      }
    })
}
