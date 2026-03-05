import { Command } from 'commander'
import chalk from 'chalk'

import { getResolvedConfig, loadConfig } from '../lib/config'
import { request } from '../lib/api'
import { CliError } from '../lib/errors'
import { printJson } from '../lib/output'
import type { ResolvedConfig } from '../types'

// ============================================
// TYPES
// ============================================

interface NamespacesResponse {
  namespaces: string[]
}

interface ListKeysResponse {
  keys: string[]
  cursor: string | null
  has_more: boolean
}

interface DocumentResponse {
  namespace: string
  key: string
  value: unknown
  version: number
  size_bytes: number
  updated_at: string
  updated_by: string
}

interface DeleteResponse {
  deleted: boolean
  namespace: string
  key?: string
  documents_deleted?: number
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

const NAMESPACE_RE = /^[a-z][a-z0-9-]{0,63}$/
const KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/

async function resolveWorkspaceId(
  config: ResolvedConfig,
  slug?: string
): Promise<string> {
  const configFile = await loadConfig()
  const targetSlug = slug ?? configFile.workspace

  const response = await request<WorkspacesResponse>(config, 'GET', '/workspaces')

  if (targetSlug) {
    const workspace = response.workspaces.find((w) => w.slug === targetSlug)
    if (!workspace) {
      throw new CliError(`Workspace '${targetSlug}' not found.`)
    }
    return workspace.id
  }

  if (response.workspaces.length === 0) {
    throw new CliError('No workspaces found. Create one with `orch workspace create <name>`.')
  }

  if (response.workspaces.length === 1) {
    return response.workspaces[0].id
  }

  const slugs = response.workspaces.map((w) => w.slug).join(', ')
  throw new CliError(
    `Multiple workspaces available: ${slugs}\n` +
    'Specify one with --workspace <slug> or run `orch workspace use <slug>`.'
  )
}

function validateNamespace(ns: string): void {
  if (!NAMESPACE_RE.test(ns)) {
    throw new CliError(
      `Invalid namespace '${ns}'.\n\n` +
      'Namespaces must:\n' +
      '  - Start with a lowercase letter\n' +
      '  - Be 1-64 chars of lowercase letters, digits, and hyphens\n\n' +
      'Examples: signals, my-data, competitors'
    )
  }
}

function validateKey(key: string): void {
  if (!KEY_RE.test(key)) {
    throw new CliError(
      `Invalid key '${key}'.\n\n` +
      'Keys must:\n' +
      '  - Start with a letter or digit\n' +
      '  - Be 1-256 chars of letters, digits, dots, hyphens, and underscores\n\n' +
      'Examples: 2026-03-05, config.v2, weekly-report'
    )
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString()
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

async function parseJsonArg(arg: string): Promise<unknown> {
  // Support @file.json syntax
  if (arg.startsWith('@')) {
    const fs = await import('fs/promises')
    const filePath = arg.slice(1)
    try {
      const content = await fs.readFile(filePath, 'utf-8')
      return JSON.parse(content)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new CliError(`File not found: ${filePath}`)
      }
      throw new CliError(`Invalid JSON in ${filePath}: ${(err as Error).message}`)
    }
  }

  try {
    return JSON.parse(arg)
  } catch {
    throw new CliError(
      'Invalid JSON value.\n\n' +
      'Pass valid JSON or use @file.json to read from a file.\n' +
      'Example: orch storage set signals 2026-03-05 \'{"pending": [], "done": []}\''
    )
  }
}

// ============================================
// COMMAND REGISTRATION
// ============================================

export function registerStorageCommand(program: Command): void {
  const storage = program
    .command('storage')
    .description('Manage agent storage (persistent shared key-value documents)')
    .action(() => { storage.help() })

  // orch storage list [namespace]
  storage
    .command('list [namespace]')
    .description('List namespaces, or list keys in a namespace')
    .option('--workspace <slug>', 'Workspace slug (default: current workspace)')
    .option('--limit <n>', 'Max keys to return (default: 100)', '100')
    .option('--cursor <cursor>', 'Pagination cursor from previous response')
    .option('--json', 'Output as JSON')
    .action(async (namespace: string | undefined, options: {
      workspace?: string
      limit?: string
      cursor?: string
      json?: boolean
    }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orch login` first.')
      }

      const workspaceId = await resolveWorkspaceId(config, options.workspace)
      const headers: Record<string, string> = { 'X-Workspace-Id': workspaceId }

      if (!namespace) {
        // List namespaces
        const result = await request<NamespacesResponse>(
          config, 'GET', '/storage', { headers }
        )

        if (options.json) {
          printJson(result)
          return
        }

        if (result.namespaces.length === 0) {
          process.stdout.write('No storage namespaces found.\n')
          process.stdout.write(chalk.gray('\nCreate one: orch storage set my-namespace my-key \'{"hello": "world"}\'\n'))
          return
        }

        for (const ns of result.namespaces) {
          process.stdout.write(`  ${ns}\n`)
        }
        process.stdout.write(chalk.gray(`\n${result.namespaces.length} namespace(s)\n`))
      } else {
        // List keys in namespace
        validateNamespace(namespace)
        const limit = parseInt(options.limit ?? '100', 10)
        let path = `/storage/${namespace}?limit=${limit}`
        if (options.cursor) path += `&cursor=${encodeURIComponent(options.cursor)}`

        const result = await request<ListKeysResponse>(
          config, 'GET', path, { headers }
        )

        if (options.json) {
          printJson(result)
          return
        }

        if (result.keys.length === 0) {
          process.stdout.write(`No keys found in namespace '${namespace}'.\n`)
          return
        }

        for (const key of result.keys) {
          process.stdout.write(`  ${key}\n`)
        }

        const countText = `${result.keys.length} key(s)`
        process.stdout.write(chalk.gray(`\n${countText}`))
        if (result.has_more) {
          process.stdout.write(chalk.gray(` (more available, use --cursor "${result.cursor}")`))
        }
        process.stdout.write('\n')
      }
    })

  // orch storage get <namespace> <key>
  storage
    .command('get <namespace> <key>')
    .description('Get a document by namespace and key')
    .option('--workspace <slug>', 'Workspace slug (default: current workspace)')
    .option('--json', 'Output as JSON (full response with metadata)')
    .option('--raw', 'Output only the value (no metadata)')
    .action(async (namespace: string, key: string, options: {
      workspace?: string
      json?: boolean
      raw?: boolean
    }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orch login` first.')
      }

      validateNamespace(namespace)
      validateKey(key)

      const workspaceId = await resolveWorkspaceId(config, options.workspace)
      const result = await request<DocumentResponse>(
        config, 'GET', `/storage/${namespace}/${key}`,
        { headers: { 'X-Workspace-Id': workspaceId } }
      )

      if (options.raw) {
        process.stdout.write(JSON.stringify(result.value, null, 2) + '\n')
        return
      }

      if (options.json) {
        printJson(result)
        return
      }

      // Pretty output
      process.stdout.write(chalk.gray(`namespace: ${result.namespace}  key: ${result.key}  `) +
        chalk.gray(`v${result.version}  ${formatBytes(result.size_bytes)}  `) +
        chalk.gray(`updated: ${formatDate(result.updated_at)} by ${result.updated_by}\n\n`))
      process.stdout.write(JSON.stringify(result.value, null, 2) + '\n')
    })

  // orch storage set <namespace> <key> <value>
  storage
    .command('set <namespace> <key> <value>')
    .description('Create or update a document (JSON string or @file.json)')
    .option('--workspace <slug>', 'Workspace slug (default: current workspace)')
    .option('--version <n>', 'Expected version for compare-and-swap (CAS)')
    .action(async (namespace: string, key: string, value: string, options: {
      workspace?: string
      version?: string
    }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orch login` first.')
      }

      validateNamespace(namespace)
      validateKey(key)
      const parsed = await parseJsonArg(value)

      const workspaceId = await resolveWorkspaceId(config, options.workspace)
      const headers: Record<string, string> = {
        'X-Workspace-Id': workspaceId,
        'X-Orchagent-Client': 'cli',
        'Content-Type': 'application/json',
      }
      if (options.version) {
        headers['If-Match'] = options.version
      }

      const result = await request<DocumentResponse>(
        config, 'PUT', `/storage/${namespace}/${key}`,
        {
          body: JSON.stringify(parsed),
          headers,
        }
      )

      process.stdout.write(
        chalk.green('\u2713') +
        ` ${namespace}/${key} ` +
        chalk.gray(`v${result.version} (${formatBytes(result.size_bytes)})\n`)
      )
    })

  // orch storage patch <namespace> <key> <value>
  storage
    .command('patch <namespace> <key> <value>')
    .description('Merge-patch a document (shallow merge JSON into existing)')
    .option('--workspace <slug>', 'Workspace slug (default: current workspace)')
    .action(async (namespace: string, key: string, value: string, options: {
      workspace?: string
    }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orch login` first.')
      }

      validateNamespace(namespace)
      validateKey(key)
      const parsed = await parseJsonArg(value)

      if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
        throw new CliError('Patch value must be a JSON object (not array or primitive).')
      }

      const workspaceId = await resolveWorkspaceId(config, options.workspace)
      const result = await request<DocumentResponse>(
        config, 'PATCH', `/storage/${namespace}/${key}`,
        {
          body: JSON.stringify(parsed),
          headers: {
            'X-Workspace-Id': workspaceId,
            'X-Orchagent-Client': 'cli',
            'Content-Type': 'application/json',
          },
        }
      )

      process.stdout.write(
        chalk.green('\u2713') +
        ` Patched ${namespace}/${key} ` +
        chalk.gray(`v${result.version} (${formatBytes(result.size_bytes)})\n`)
      )
    })

  // orch storage delete <namespace> [key]
  storage
    .command('delete <namespace> [key]')
    .description('Delete a document, or all documents in a namespace (with --all)')
    .option('--workspace <slug>', 'Workspace slug (default: current workspace)')
    .option('--all', 'Delete all documents in the namespace')
    .action(async (namespace: string, key: string | undefined, options: {
      workspace?: string
      all?: boolean
    }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orch login` first.')
      }

      validateNamespace(namespace)

      const workspaceId = await resolveWorkspaceId(config, options.workspace)
      const headers: Record<string, string> = {
        'X-Workspace-Id': workspaceId,
        'X-Orchagent-Client': 'cli',
      }

      if (options.all) {
        // Delete entire namespace
        const result = await request<DeleteResponse>(
          config, 'DELETE', `/storage/${namespace}`, { headers }
        )
        process.stdout.write(
          chalk.green('\u2713') +
          ` Deleted namespace '${namespace}' (${result.documents_deleted ?? 0} document(s))\n`
        )
      } else if (key) {
        // Delete single document
        validateKey(key)
        await request<DeleteResponse>(
          config, 'DELETE', `/storage/${namespace}/${key}`, { headers }
        )
        process.stdout.write(chalk.green('\u2713') + ` Deleted ${namespace}/${key}\n`)
      } else {
        throw new CliError(
          'Specify a key to delete, or use --all to delete the entire namespace.\n\n' +
          'Examples:\n' +
          `  orch storage delete ${namespace} my-key\n` +
          `  orch storage delete ${namespace} --all`
        )
      }
    })
}
