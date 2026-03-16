import { Command } from 'commander'

import { getResolvedConfig, loadConfig } from '../lib/config'
import { resolveWorkspaceIdForOrg } from '../lib/api'
import { parseAgentRef } from '../lib/agent-ref'
import { CliError } from '../lib/errors'
import { getAgentInfo } from './info'

export function registerSchemaCommand(program: Command): void {
  program
    .command('schema <agent>')
    .description('Show agent input/output schemas as machine-readable JSON')
    .option('--input-only', 'Show only the input schema')
    .option('--output-only', 'Show only the output schema')
    .option('--full', 'Show full agent spec (type, execution_engine, schemas, custom_tools, secrets)')
    .action(async (agentArg: string, options: { inputOnly?: boolean; outputOnly?: boolean; full?: boolean }) => {
      const config = await getResolvedConfig()
      const parsed = parseAgentRef(agentArg)
      const configFile = await loadConfig()
      const org = parsed.org ?? configFile.workspace ?? config.defaultOrg
      if (!org) {
        throw new CliError('Missing org. Use org/agent format or set default org.')
      }
      const { agent, version } = parsed

      const workspaceId = await resolveWorkspaceIdForOrg(config, org)
      const agentData = await getAgentInfo(config, org, agent, version, workspaceId)

      const ref = `${org}/${agent}@${agentData.version || version}`

      if (options.inputOnly) {
        process.stdout.write(JSON.stringify(agentData.input_schema || {}, null, 2) + '\n')
        return
      }

      if (options.outputOnly) {
        process.stdout.write(JSON.stringify(agentData.output_schema || {}, null, 2) + '\n')
        return
      }

      if (options.full) {
        const output: Record<string, unknown> = {
          agent: ref,
          type: agentData.type,
          callable: agentData.callable ?? false,
          supported_providers: agentData.supported_providers,
          input_schema: agentData.input_schema || {},
          output_schema: agentData.output_schema || {},
        }
        if (agentData.description) {
          output.description = agentData.description
        }
        if (agentData.required_secrets && agentData.required_secrets.length > 0) {
          output.required_secrets = agentData.required_secrets
        }
        if (agentData.optional_secrets && agentData.optional_secrets.length > 0) {
          output.optional_secrets = agentData.optional_secrets
        }
        if (agentData.dependencies && agentData.dependencies.length > 0) {
          output.dependencies = agentData.dependencies
        }
        if (agentData.default_skills && agentData.default_skills.length > 0) {
          output.default_skills = agentData.default_skills
        }
        if (agentData.custom_tools && agentData.custom_tools.length > 0) {
          output.custom_tools = agentData.custom_tools
        }
        if (agentData.environment) {
          output.environment = agentData.environment
        }
        process.stdout.write(JSON.stringify(output, null, 2) + '\n')
        return
      }

      // Default: show both schemas with agent ref
      const output = {
        agent: ref,
        type: agentData.type,
        input_schema: agentData.input_schema || {},
        output_schema: agentData.output_schema || {},
      }
      process.stdout.write(JSON.stringify(output, null, 2) + '\n')
    })
}
