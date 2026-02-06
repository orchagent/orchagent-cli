import { Command } from 'commander'

import { getResolvedConfig } from '../lib/config'
import { forkAgent, getPublicAgent, getOrg } from '../lib/api'
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

export function registerForkCommand(program: Command): void {
  program
    .command('fork')
    .description('Fork an agent to your account')
    .argument('<agent>', 'Agent reference (org/name or org/name/version)')
    .action(async (agent: string) => {
      const config = await getResolvedConfig()
      const { org, name, version } = parseAgentRef(agent)

      // Get the agent to get its ID
      const agentInfo = await getPublicAgent(config, org, name, version)

      // Fork it
      const result = await forkAgent(config, agentInfo.id)

      // Get our org info
      const myOrg = await getOrg(config)

      await track('cli_fork', { agent: `${org}/${name}/${version}` })
      process.stdout.write(`Forked ${org}/${name}/${version} to your account\n`)
      process.stdout.write(`\nYour forked agent: ${myOrg.slug}/${name}/v1\n`)
      process.stdout.write(`\nNext steps:\n`)
      process.stdout.write(`  1. Run: orchagent install ${myOrg.slug}/${name}\n`)
      process.stdout.write(`  2. Edit the prompt and schemas locally\n`)
      process.stdout.write(`  3. Run: orchagent publish\n`)
    })
}
