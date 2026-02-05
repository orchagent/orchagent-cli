import { Command } from 'commander'
import Table from 'cli-table3'
import chalk from 'chalk'
import * as fs from 'fs/promises'

import { getResolvedConfig, loadConfig } from '../lib/config'
import {
  listEnvironments,
  getEnvironment,
  createEnvironment,
  deleteEnvironment,
  setWorkspaceDefaultEnvironment,
  getOrg,
  request,
} from '../lib/api'
import { CliError } from '../lib/errors'
import { track } from '../lib/analytics'
import type { ResolvedConfig, Org } from '../types'

interface WorkspacesResponse {
  workspaces: { id: string; slug: string }[]
}

async function resolveWorkspaceId(
  config: ResolvedConfig,
  slug?: string
): Promise<string> {
  const configFile = await loadConfig()
  const targetSlug = slug ?? configFile.workspace

  if (!targetSlug) {
    // Use user's personal org
    const org = await getOrg(config)
    return org.id
  }

  // First check if the target slug matches the user's own org
  // This avoids calling /workspaces which requires Clerk user identity
  const org = await getOrg(config)
  if (org.slug === targetSlug) {
    return org.id
  }

  // Only call /workspaces if accessing a different team workspace
  const response = await request<WorkspacesResponse>(config, 'GET', '/workspaces')
  const workspace = response.workspaces.find((w) => w.slug === targetSlug)

  if (!workspace) {
    throw new CliError(`Workspace '${targetSlug}' not found`)
  }

  return workspace.id
}

function statusColor(status: string | undefined): string {
  switch (status) {
    case 'ready':
      return chalk.green(status)
    case 'building':
      return chalk.yellow(status)
    case 'failed':
      return chalk.red(status)
    case 'pending':
      return chalk.gray(status)
    default:
      return chalk.gray(status ?? 'unknown')
  }
}

async function listEnvs(
  config: ResolvedConfig,
  options: { workspace?: string }
): Promise<void> {
  const workspaceId = await resolveWorkspaceId(config, options.workspace)
  const result = await listEnvironments(config, workspaceId)

  if (result.environments.length === 0) {
    console.log(chalk.gray('No environments found.'))
    console.log(chalk.gray('Use `orch env create` to create one, or include a Dockerfile in your agent bundle.'))
    return
  }

  const table = new Table({
    head: [
      chalk.cyan('Name'),
      chalk.cyan('Status'),
      chalk.cyan('Agents'),
      chalk.cyan('Type'),
      chalk.cyan('ID'),
    ],
    style: { head: [], border: [] },
  })

  for (const env of result.environments) {
    const isDefault = env.environment.id === result.default_environment_id
    const name = isDefault
      ? `${env.environment.name} ${chalk.yellow('(default)')}`
      : env.environment.name

    table.push([
      name,
      statusColor(env.build?.status),
      env.agent_count.toString(),
      env.environment.is_predefined ? chalk.blue('predefined') : chalk.gray('custom'),
      env.environment.id.slice(0, 8),
    ])
  }

  console.log()
  console.log(chalk.bold('Environments:'))
  console.log(table.toString())
  console.log()

  if (result.default_environment_id) {
    const defaultEnv = result.environments.find(
      (e) => e.environment.id === result.default_environment_id
    )
    if (defaultEnv) {
      console.log(
        chalk.gray(`Workspace default: ${chalk.white(defaultEnv.environment.name)}`)
      )
      console.log(
        chalk.gray('All new agents will use this environment unless they include their own Dockerfile.')
      )
    }
  }
}

async function getEnvStatus(
  config: ResolvedConfig,
  environmentId: string
): Promise<void> {
  const result = await getEnvironment(config, environmentId)

  console.log()
  console.log(chalk.bold(`Environment: ${result.environment.name}`))
  console.log()
  console.log(`  ID:      ${result.environment.id}`)
  console.log(`  Status:  ${statusColor(result.build?.status)}`)
  console.log(`  Agents:  ${result.agent_count}`)
  console.log(`  Type:    ${result.environment.is_predefined ? 'predefined' : 'custom'}`)
  console.log(`  Created: ${new Date(result.environment.created_at).toLocaleString()}`)

  if (result.build?.status === 'failed') {
    console.log()
    console.log(chalk.red('Build Error:'))
    console.log(chalk.red(`  ${result.build.error_message || 'Unknown error'}`))
  }

  if (result.build?.build_logs) {
    console.log()
    console.log(chalk.gray('Build Logs:'))
    console.log(chalk.gray(result.build.build_logs))
  }

  console.log()
  console.log(chalk.gray('Dockerfile:'))
  console.log(chalk.gray('---'))
  console.log(result.environment.dockerfile_content)
  console.log(chalk.gray('---'))
}

async function createEnv(
  config: ResolvedConfig,
  options: { file: string; name: string }
): Promise<void> {
  let dockerfileContent: string
  try {
    dockerfileContent = await fs.readFile(options.file, 'utf-8')
  } catch (err) {
    throw new CliError(`Failed to read Dockerfile: ${options.file}`)
  }

  console.log(chalk.gray(`Creating environment '${options.name}'...`))

  const result = await createEnvironment(config, options.name, dockerfileContent)

  if (result.reused) {
    console.log(chalk.cyan('Existing environment with same Dockerfile found, reusing.'))
    console.log(`Environment ID: ${result.environment.id}`)
  } else {
    console.log(chalk.green('Environment created, build started.'))
    console.log(`Environment ID: ${result.environment.id}`)
    console.log()
    console.log(chalk.gray(`Check build status: orch env status ${result.environment.id}`))
  }

  await track('env_create', {
    environment_id: result.environment.id,
    reused: result.reused,
  })
}

async function deleteEnv(
  config: ResolvedConfig,
  environmentId: string
): Promise<void> {
  console.log(chalk.gray(`Deleting environment ${environmentId}...`))

  await deleteEnvironment(config, environmentId)

  console.log(chalk.green('Environment deleted.'))

  await track('env_delete', { environment_id: environmentId })
}

async function setDefault(
  config: ResolvedConfig,
  environmentId: string,
  options: { workspace?: string }
): Promise<void> {
  const workspaceId = await resolveWorkspaceId(config, options.workspace)

  console.log(chalk.gray(`Setting default environment for workspace...`))

  await setWorkspaceDefaultEnvironment(config, workspaceId, environmentId)

  console.log(chalk.green('Default environment set for workspace.'))
  console.log(
    chalk.gray('All new agents will use this environment unless they include their own Dockerfile.')
  )

  await track('env_set_default', {
    environment_id: environmentId,
    workspace_id: workspaceId,
  })
}

async function clearDefault(
  config: ResolvedConfig,
  options: { workspace?: string }
): Promise<void> {
  const workspaceId = await resolveWorkspaceId(config, options.workspace)

  console.log(chalk.gray(`Clearing default environment for workspace...`))

  await setWorkspaceDefaultEnvironment(config, workspaceId, null)

  console.log(chalk.green('Default environment cleared. Agents will use base image.'))

  await track('env_clear_default', { workspace_id: workspaceId })
}

export function registerEnvCommand(program: Command): void {
  const env = program
    .command('env')
    .description('Manage custom Docker environments for code agents')

  env
    .command('list')
    .description('List environments in workspace')
    .option('-w, --workspace <slug>', 'Workspace slug')
    .action(async (options) => {
      const config = await getResolvedConfig()
      await listEnvs(config, options)
    })

  env
    .command('status <environment-id>')
    .description('Check environment build status')
    .action(async (environmentId) => {
      const config = await getResolvedConfig()
      await getEnvStatus(config, environmentId)
    })

  env
    .command('create')
    .description('Create environment from Dockerfile')
    .requiredOption('-f, --file <path>', 'Path to Dockerfile')
    .requiredOption('-n, --name <name>', 'Environment name')
    .action(async (options) => {
      const config = await getResolvedConfig()
      await createEnv(config, options)
    })

  env
    .command('delete <environment-id>')
    .description('Delete an environment')
    .action(async (environmentId) => {
      const config = await getResolvedConfig()
      await deleteEnv(config, environmentId)
    })

  env
    .command('set-default <environment-id>')
    .description('Set workspace default environment (all agents use this)')
    .option('-w, --workspace <slug>', 'Workspace slug (defaults to current)')
    .action(async (environmentId, options) => {
      const config = await getResolvedConfig()
      await setDefault(config, environmentId, options)
    })

  env
    .command('clear-default')
    .description('Clear workspace default environment (agents use base image)')
    .option('-w, --workspace <slug>', 'Workspace slug (defaults to current)')
    .action(async (options) => {
      const config = await getResolvedConfig()
      await clearDefault(config, options)
    })
}
