import { Command } from 'commander'
import Table from 'cli-table3'
import chalk from 'chalk'

import { getResolvedConfig, loadConfig } from '../lib/config'
import { request } from '../lib/api'
import { CliError } from '../lib/errors'
import { printJson } from '../lib/output'
import type { ResolvedConfig } from '../types'

// ============================================
// TYPES
// ============================================

interface Secret {
  id: string
  name: string
  description: string | null
  secret_type: string
  llm_provider: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

interface SecretsListResponse {
  secrets: Secret[]
}

interface SecretResponse {
  secret: Secret
}

interface Workspace {
  id: string
  name: string
  slug: string
}

interface WorkspacesResponse {
  workspaces: Workspace[]
}

// ============================================
// HELPERS
// ============================================

const SECRET_NAME_REGEX = /^[A-Z][A-Z0-9_]*$/

async function resolveWorkspaceId(
  config: ResolvedConfig,
  slug?: string
): Promise<string> {
  const configFile = await loadConfig()
  const targetSlug = slug ?? configFile.workspace

  if (!targetSlug) {
    throw new CliError(
      'No workspace specified. Use --workspace <slug> or run `orch workspace use <slug>` first.'
    )
  }

  const response = await request<WorkspacesResponse>(config, 'GET', '/workspaces')
  const workspace = response.workspaces.find((w) => w.slug === targetSlug)

  if (!workspace) {
    throw new CliError(`Workspace '${targetSlug}' not found.`)
  }

  return workspace.id
}

function formatDate(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString()
}

function validateSecretName(name: string): void {
  if (!name || name.length > 128) {
    throw new CliError('Secret name must be 1-128 characters.')
  }
  if (!SECRET_NAME_REGEX.test(name)) {
    throw new CliError(
      `Invalid secret name '${name}'.\n\n` +
      'Secret names must:\n' +
      '  - Start with an uppercase letter (A-Z)\n' +
      '  - Contain only uppercase letters, digits, and underscores\n\n' +
      'Examples: STRIPE_SECRET_KEY, DISCORD_TOKEN, MY_API_KEY_2'
    )
  }
}

async function findSecretByName(
  config: ResolvedConfig,
  workspaceId: string,
  name: string
): Promise<Secret | undefined> {
  const result = await request<SecretsListResponse>(
    config,
    'GET',
    `/workspaces/${workspaceId}/secrets`
  )
  return result.secrets.find((s) => s.name === name)
}

// ============================================
// COMMAND REGISTRATION
// ============================================

export function registerSecretsCommand(program: Command): void {
  const secrets = program
    .command('secrets')
    .description('Manage workspace secrets (injected as env vars into agent sandboxes)')
    .action(() => { secrets.help() })

  // orch secrets list
  secrets
    .command('list')
    .description('List secrets in your workspace (names and metadata, never values)')
    .option('--workspace <slug>', 'Workspace slug (default: current workspace)')
    .option('--json', 'Output as JSON')
    .action(async (options: { workspace?: string; json?: boolean }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orch login` first.')
      }

      const workspaceId = await resolveWorkspaceId(config, options.workspace)
      const result = await request<SecretsListResponse>(
        config,
        'GET',
        `/workspaces/${workspaceId}/secrets`
      )

      if (options.json) {
        printJson(result)
        return
      }

      if (result.secrets.length === 0) {
        process.stdout.write('No secrets found in this workspace.\n')
        process.stdout.write(chalk.gray('\nAdd one with: orch secrets set MY_SECRET_NAME my-secret-value\n'))
        return
      }

      const table = new Table({
        head: [
          chalk.bold('Name'),
          chalk.bold('Type'),
          chalk.bold('Description'),
          chalk.bold('Updated'),
        ],
      })

      for (const s of result.secrets) {
        table.push([
          s.name,
          s.secret_type === 'llm_key'
            ? chalk.cyan(`llm_key (${s.llm_provider ?? '?'})`)
            : chalk.gray('custom'),
          s.description ? s.description.slice(0, 40) + (s.description.length > 40 ? '...' : '') : chalk.gray('-'),
          formatDate(s.updated_at),
        ])
      }

      process.stdout.write(`\n${table.toString()}\n`)
      process.stdout.write(chalk.gray(`\n${result.secrets.length} secret(s)\n`))
    })

  // orch secrets set <NAME> <VALUE>
  secrets
    .command('set <name> <value>')
    .description('Create or update a workspace secret')
    .option('--description <text>', 'Description of what this secret is for')
    .option('--workspace <slug>', 'Workspace slug (default: current workspace)')
    .action(async (name: string, value: string, options: {
      description?: string
      workspace?: string
    }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orch login` first.')
      }

      validateSecretName(name)

      if (!value) {
        throw new CliError('Secret value cannot be empty.')
      }

      const workspaceId = await resolveWorkspaceId(config, options.workspace)

      // Check if secret already exists (by name)
      const existing = await findSecretByName(config, workspaceId, name)

      if (existing) {
        // Update existing secret
        const body: Record<string, string> = { value }
        if (options.description !== undefined) {
          body.description = options.description
        }

        const result = await request<{ updated: boolean; restarted_services?: { service_name: string }[] }>(
          config,
          'PATCH',
          `/workspaces/${workspaceId}/secrets/${existing.id}`,
          {
            body: JSON.stringify(body),
            headers: { 'Content-Type': 'application/json' },
          }
        )

        process.stdout.write(chalk.green('\u2713') + ` Updated secret ${chalk.bold(name)}\n`)

        if (result.restarted_services && result.restarted_services.length > 0) {
          process.stdout.write(chalk.yellow('\n  Restarted running services that use this secret:\n'))
          for (const svc of result.restarted_services) {
            process.stdout.write(`    - ${svc.service_name}\n`)
          }
        }
      } else {
        // Create new secret
        const body: Record<string, string> = {
          name,
          value,
          secret_type: 'custom',
        }
        if (options.description !== undefined) {
          body.description = options.description
        }

        await request<SecretResponse>(
          config,
          'POST',
          `/workspaces/${workspaceId}/secrets`,
          {
            body: JSON.stringify(body),
            headers: { 'Content-Type': 'application/json' },
          }
        )

        process.stdout.write(chalk.green('\u2713') + ` Created secret ${chalk.bold(name)}\n`)
      }
    })

  // orch secrets delete <NAME>
  secrets
    .command('delete <name>')
    .description('Delete a workspace secret')
    .option('--workspace <slug>', 'Workspace slug (default: current workspace)')
    .action(async (name: string, options: { workspace?: string }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orch login` first.')
      }

      const workspaceId = await resolveWorkspaceId(config, options.workspace)

      // Resolve name → ID
      const existing = await findSecretByName(config, workspaceId, name)
      if (!existing) {
        throw new CliError(
          `Secret '${name}' not found in this workspace.\n\n` +
          'Run `orch secrets list` to see available secrets.'
        )
      }

      await request<{ deleted: boolean }>(
        config,
        'DELETE',
        `/workspaces/${workspaceId}/secrets/${existing.id}`
      )

      process.stdout.write(chalk.green('\u2713') + ` Deleted secret ${chalk.bold(name)}\n`)
    })
}
