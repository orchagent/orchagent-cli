import { Command } from 'commander'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import yaml from 'yaml'
import chalk from 'chalk'
import { spawnSync } from 'child_process'

import { getResolvedConfig, loadConfig } from '../lib/config'
import { createAgent, getOrg, uploadCodeBundle, previewAgentVersion, validateAgentPublish, request, getPublicAgent, ApiError } from '../lib/api'
import { CliError, ExitCodes } from '../lib/errors'
import { track } from '../lib/analytics'
import { createCodeBundle, detectEntrypoint, validateBundle, previewBundle } from '../lib/bundle'
import { saveServiceKey } from '../lib/key-store'
import { discoverAgents, topoSort, formatPublishPlan, formatDryRunSummary } from '../lib/batch-publish'
import type { AgentManifest, Agent, ResolvedConfig } from '../types'
import { validateModelIds } from '../lib/llm'

/**
 * Extract template placeholders from a prompt template.
 * Matches double-brace patterns like {{variable}}.
 * Returns unique variable names in order of first appearance.
 */
export function extractTemplateVariables(template: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  // Match double-brace template variables: two opening braces, word chars, two closing braces
  const pattern = /\{\{(\w+)\}\}/g
  let match
  while ((match = pattern.exec(template)) !== null) {
    const name = match[1]
    if (!seen.has(name)) {
      seen.add(name)
      result.push(name)
    }
  }
  return result
}

/**
 * Derive a JSON Schema input object from template variable names.
 * Each variable becomes a required string property.
 */
export function deriveInputSchema(variables: string[]): object {
  const properties: Record<string, { type: string; description: string }> = {}
  for (const name of variables) {
    properties[name] = {
      type: 'string',
      description: `Value for the ${name} template variable`,
    }
  }
  return {
    type: 'object',
    properties,
    required: [...variables],
  }
}

/**
 * Scan Python files for environment variable references and return var names
 * that aren't covered by required_secrets or auto-injected by the platform.
 */
export async function scanUndeclaredEnvVars(agentDir: string, requiredSecrets: string[]): Promise<string[]> {
  // Auto-injected by the gateway — never need to be in required_secrets
  const autoInjected = new Set([
    'ORCHAGENT_SERVICE_KEY', 'ORCHAGENT_GATEWAY_URL', 'ORCHAGENT_CALL_CHAIN',
    'ORCHAGENT_DEADLINE_MS', 'ORCHAGENT_MAX_HOPS', 'ORCHAGENT_DOWNSTREAM_REMAINING',
    'ORCHAGENT_SDK_REQUIRED', 'ORCHAGENT_BILLING_ORG_ID', 'ORCHAGENT_ROOT_RUN_ID',
    'ORCHAGENT_REQUEST_ID',
    // LLM keys injected via the platform's credential mechanism
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'LLM_MODEL',
    // Standard system env vars
    'PATH', 'HOME', 'USER', 'LANG', 'SHELL', 'TERM', 'PWD', 'TMPDIR',
  ])
  const declared = new Set(requiredSecrets)

  // Python env var access patterns
  const patterns = [
    /os\.environ\s*\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g,
    /os\.environ\.get\s*\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
    /os\.getenv\s*\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
  ]

  const found = new Set<string>()

  // JS/TS env var access pattern
  const jsEnvPattern = /process\.env\.([A-Z_][A-Z0-9_]*)/g

  // Scan .py/.js/.ts files in the agent directory (up to 2 levels deep)
  async function scanDir(dir: string, depth: number) {
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
      if (!entries || !Array.isArray(entries)) return
    } catch {
      return
    }
    for (const entry of entries) {
      const name = entry.name as string
      const fullPath = path.join(dir, name)
      if (entry.isDirectory() && depth < 2 && !name.startsWith('.') && name !== 'node_modules' && name !== '__pycache__' && name !== 'venv' && name !== '.venv') {
        await scanDir(fullPath, depth + 1)
      } else if (entry.isFile() && name.endsWith('.py')) {
        try {
          const content = await fs.readFile(fullPath, 'utf-8')
          for (const re of patterns) {
            re.lastIndex = 0
            let m: RegExpExecArray | null
            while ((m = re.exec(content)) !== null) { // eslint-disable-line no-cond-assign
              found.add(m[1])
            }
          }
        } catch {
          // Skip unreadable files
        }
      } else if (entry.isFile() && (name.endsWith('.js') || name.endsWith('.ts'))) {
        try {
          const content = await fs.readFile(fullPath, 'utf-8')
          jsEnvPattern.lastIndex = 0
          let m: RegExpExecArray | null
          while ((m = jsEnvPattern.exec(content)) !== null) { // eslint-disable-line no-cond-assign
            found.add(m[1])
          }
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  await scanDir(agentDir, 0)

  // Return env vars that are referenced but not declared or auto-injected
  return [...found].filter(v => !declared.has(v) && !autoInjected.has(v)).sort()
}

/**
 * Scan code files for patterns that bind to port 8080 — the platform reserves
 * this port for the always-on service health server.  Returns true if a likely
 * port-8080 binding is detected.
 */
export async function scanReservedPort(agentDir: string): Promise<boolean> {
  // Patterns that indicate binding to port 8080 in Python / JS / TS
  const pyPatterns = [
    /\.listen\s*\(\s*8080\b/,                              // server.listen(8080
    /\.run\s*\([^)]*port\s*=\s*8080\b/,                    // app.run(port=8080
    /\.run\s*\([^)]*host\s*=\s*['"][^'"]*['"],?\s*8080\b/, // app.run("0.0.0.0", 8080
    /bind\s*\(\s*\(?['"][^'"]*['"]\s*,\s*8080\b/,          // bind(("0.0.0.0", 8080
    /PORT\s*=\s*8080\b/,                                    // PORT = 8080
    /port\s*=\s*8080\b/,                                    // port=8080
  ]
  const jsPatterns = [
    /\.listen\s*\(\s*8080\b/,               // app.listen(8080
    /port\s*[:=]\s*8080\b/,                  // port: 8080  or  port = 8080
    /PORT\s*[:=]\s*8080\b/,                  // PORT = 8080
  ]

  async function scanDir(dir: string, depth: number): Promise<boolean> {
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
      if (!entries || !Array.isArray(entries)) return false
    } catch {
      return false
    }
    for (const entry of entries) {
      const name = entry.name as string
      const fullPath = path.join(dir, name)
      if (entry.isDirectory() && depth < 2 && !name.startsWith('.') && name !== 'node_modules' && name !== '__pycache__' && name !== 'venv' && name !== '.venv') {
        if (await scanDir(fullPath, depth + 1)) return true
      } else if (entry.isFile() && name.endsWith('.py')) {
        try {
          const content = await fs.readFile(fullPath, 'utf-8')
          for (const re of pyPatterns) {
            if (re.test(content)) return true
          }
        } catch { /* skip */ }
      } else if (entry.isFile() && (name.endsWith('.js') || name.endsWith('.ts'))) {
        try {
          const content = await fs.readFile(fullPath, 'utf-8')
          for (const re of jsPatterns) {
            if (re.test(content)) return true
          }
        } catch { /* skip */ }
      }
    }
    return false
  }

  return scanDir(agentDir, 0)
}

interface SkillFrontmatter {
  name: string
  description: string
  license?: string
  metadata?: { author?: string; version?: string }
}

/**
 * Check if orchagent-sdk is listed in requirements.txt or pyproject.toml
 */
export async function detectSdkCompatible(agentDir: string): Promise<boolean> {
  // Check requirements.txt
  const requirementsPath = path.join(agentDir, 'requirements.txt')
  try {
    const content = await fs.readFile(requirementsPath, 'utf-8')
    // Match orchagent-sdk with or without version specifier (e.g., orchagent-sdk, orchagent-sdk>=0.1.0)
    if (/^orchagent-sdk\b/m.test(content)) {
      return true
    }
  } catch {
    // File doesn't exist, continue checking pyproject.toml
  }

  // Check pyproject.toml
  const pyprojectPath = path.join(agentDir, 'pyproject.toml')
  try {
    const content = await fs.readFile(pyprojectPath, 'utf-8')
    // Match orchagent-sdk in dependencies (various formats in TOML)
    // e.g., "orchagent-sdk", 'orchagent-sdk>=0.1.0', orchagent-sdk = ">=0.1.0"
    if (/["']?orchagent-sdk["']?\s*[=<>~!]?/m.test(content)) {
      return true
    }
  } catch {
    // File doesn't exist
  }

  // Check package.json (JS/TS agents)
  const pkgJsonPath = path.join(agentDir, 'package.json')
  try {
    const content = await fs.readFile(pkgJsonPath, 'utf-8')
    const pkgJson = JSON.parse(content)
    const deps = { ...pkgJson.dependencies, ...pkgJson.devDependencies }
    if (deps['orchagent-sdk'] || deps['@orchagent/sdk']) {
      return true
    }
  } catch {
    // File doesn't exist or invalid JSON
  }

  return false
}

async function parseSkillMd(filePath: string): Promise<{
  frontmatter: SkillFrontmatter
  body: string
} | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!match) return null
    const frontmatter = yaml.parse(match[1]) as SkillFrontmatter
    const body = match[2].trim()
    if (!frontmatter.name || !frontmatter.description) return null
    return { frontmatter, body }
  } catch {
    return null
  }
}

/**
 * Binary file extensions to skip when collecting skill files (SC-05)
 */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp', '.tiff',
  '.pdf', '.zip', '.tar', '.gz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv',
  '.pyc', '.pyo', '.class', '.o', '.obj',
])

/**
 * Collect all text files in the skill directory for SC-05 multi-file support
 */
async function collectSkillFiles(
  skillDir: string,
  maxFiles = 20,
  maxTotalSize = 500_000
): Promise<{ path: string; content: string; size: number }[]> {
  const files: { path: string; content: string; size: number }[] = []
  let totalSize = 0

  async function walkDir(dir: string, relativePath = ''): Promise<void> {
    if (files.length >= maxFiles || totalSize >= maxTotalSize) return

    const entries = await fs.readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      if (files.length >= maxFiles || totalSize >= maxTotalSize) break

      const fullPath = path.join(dir, entry.name)
      const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name

      // Skip hidden files and common non-content directories
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') {
        continue
      }

      if (entry.isDirectory()) {
        await walkDir(fullPath, relPath)
      } else if (entry.isFile()) {
        // Skip binary files
        const ext = path.extname(entry.name).toLowerCase()
        if (BINARY_EXTENSIONS.has(ext)) continue

        try {
          const stat = await fs.stat(fullPath)
          if (totalSize + stat.size > maxTotalSize) continue

          const content = await fs.readFile(fullPath, 'utf-8')
          files.push({
            path: relPath,
            content,
            size: stat.size,
          })
          totalSize += stat.size
        } catch {
          // Skip files that can't be read (binary, permissions, etc.)
        }
      }
    }
  }

  await walkDir(skillDir)
  return files
}

type CanonicalType = 'prompt' | 'tool' | 'agent' | 'skill'
type ExecutionEngine = 'direct_llm' | 'managed_loop' | 'code_runtime'

function canonicalizeManifestType(typeValue: string | undefined): { canonicalType: CanonicalType; rawType: string } {
  const rawType = (typeValue || 'agent').trim().toLowerCase()
  if (['prompt', 'tool', 'agent', 'skill'].includes(rawType)) {
    return { canonicalType: rawType as CanonicalType, rawType }
  }
  // Legacy aliases
  if (rawType === 'agentic') {
    return { canonicalType: 'agent', rawType }
  }
  if (rawType === 'code') {
    return { canonicalType: 'tool', rawType }
  }
  throw new CliError(
    `Invalid type '${typeValue}'. Use 'prompt', 'tool', 'agent', or 'skill' (legacy aliases: agentic, code).`
  )
}

function normalizeRunMode(runMode: string | undefined): 'on_demand' | 'always_on' {
  const normalized = (runMode || 'on_demand').trim().toLowerCase()
  if (normalized === 'on_demand' || normalized === 'always_on') {
    return normalized
  }
  throw new CliError("run_mode must be 'on_demand' or 'always_on'")
}

function inferExecutionEngineFromManifest(
  manifest: AgentManifest,
  rawType: string
): ExecutionEngine {
  const runtimeCommand = manifest.runtime?.command?.trim()
  const hasLoop = Boolean(manifest.loop && Object.keys(manifest.loop).length > 0)

  if (runtimeCommand && hasLoop) {
    throw new CliError('runtime.command and loop cannot both be set')
  }
  if (runtimeCommand) return 'code_runtime'
  if (hasLoop) return 'managed_loop'
  if (rawType === 'tool' || rawType === 'code') return 'code_runtime'
  if (rawType === 'agentic' || rawType === 'agent') return 'managed_loop'
  return 'direct_llm'
}

function commandForEntrypoint(entrypoint: string): string {
  if (entrypoint.endsWith('.js') || entrypoint.endsWith('.mjs') || entrypoint.endsWith('.cjs') || entrypoint.endsWith('.ts')) {
    return `node ${entrypoint}`
  }
  return `python3 ${entrypoint}`
}

export type DepCheckResult = {
  ref: string
  status: 'found_callable' | 'found_not_callable' | 'not_found' | 'not_found_cross_org'
}

/**
 * Check if manifest dependencies are published and callable.
 * Best-effort: network errors cause the check to be silently skipped
 * (returns empty array) to avoid false alarms.
 */
export async function checkDependencies(
  config: ResolvedConfig,
  dependencies: Array<{ id: string; version: string }>,
  publishingOrgSlug: string,
  workspaceId?: string
): Promise<DepCheckResult[]> {
  // Pre-fetch user's agents if any deps are in the same org (one API call)
  let myAgents: Agent[] | null = null
  const hasSameOrgDeps = dependencies.some(d => {
    const [org] = d.id.split('/')
    return org === publishingOrgSlug
  })

  if (hasSameOrgDeps) {
    try {
      const headers: Record<string, string> = {}
      if (workspaceId) headers['X-Workspace-Id'] = workspaceId
      myAgents = await request<Agent[]>(config, 'GET', '/agents', { headers })
    } catch {
      return [] // Can't reach API — skip check entirely
    }
  }

  return Promise.all(
    dependencies.map(async (dep): Promise<DepCheckResult> => {
      const parts = dep.id.split('/')
      const ref = `${dep.id}@${dep.version}`
      if (parts.length !== 2) return { ref, status: 'not_found' }
      const [depOrg, depName] = parts

      // Same org: check against pre-fetched agent list
      if (depOrg === publishingOrgSlug && myAgents) {
        const match = myAgents.find(a => a.name === depName && a.version === dep.version)
        if (!match) return { ref, status: 'not_found' }
        return { ref, status: match.callable ? 'found_callable' : 'found_not_callable' }
      }

      // Different org: try public endpoint
      try {
        const agent = await getPublicAgent(config, depOrg, depName, dep.version)
        return { ref, status: agent.callable ? 'found_callable' : 'found_not_callable' }
      } catch (err: unknown) {
        if ((err as { status?: number })?.status === 404) {
          // Could be unpublished OR published-but-private — we can't tell from a 404
          return { ref, status: 'not_found_cross_org' }
        }
        // Network/unexpected error — don't false alarm
        return { ref, status: 'found_callable' }
      }
    })
  )
}

/**
 * Provider names the platform supports for LLM vault keys.
 * Must stay in sync with gateway's _PROVIDER_TO_SECRET_NAME (db.py).
 */
const PROVIDER_TO_SECRET_NAME: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
}

/**
 * After a successful publish, check whether the target workspace has LLM vault
 * keys that match the agent's supported_providers. If not, print a warning so
 * the user knows cloud runs will fail.
 *
 * Best-effort: API errors are silently swallowed (the agent is already published).
 */
export async function checkWorkspaceLlmKeys(
  config: ResolvedConfig,
  workspaceId: string,
  workspaceSlug: string,
  executionEngine: ExecutionEngine,
  supportedProviders: string[]
): Promise<void> {
  // Only direct_llm and managed_loop engines need LLM keys
  if (executionEngine !== 'direct_llm' && executionEngine !== 'managed_loop') {
    return
  }

  // Reverse map: secret name → provider (e.g. ANTHROPIC_API_KEY → anthropic)
  const SECRET_NAME_TO_PROVIDER: Record<string, string> = Object.fromEntries(
    Object.entries(PROVIDER_TO_SECRET_NAME).map(([provider, name]) => [name, provider])
  )

  let secrets: Array<{ name?: string; secret_type: string; llm_provider: string | null }>
  try {
    const result = await request<{
      secrets: Array<{ name?: string; secret_type: string; llm_provider: string | null }>
    }>(config, 'GET', `/workspaces/${workspaceId}/secrets`)
    secrets = result.secrets
    if (!Array.isArray(secrets)) return
  } catch {
    return // Can't reach API or unexpected response — skip warning silently
  }

  // Resolve providers from both secret_type metadata AND secret name.
  // Gateway resolves LLM keys by name, but `orch secrets set` creates them
  // with secret_type='custom'. Match by name to avoid false warnings.
  const availableProviders = new Set<string>()
  for (const s of secrets) {
    if (s.secret_type === 'llm_key' && s.llm_provider) {
      availableProviders.add(s.llm_provider)
    }
    if (s.name && s.name in SECRET_NAME_TO_PROVIDER) {
      availableProviders.add(SECRET_NAME_TO_PROVIDER[s.name])
    }
  }

  // Determine which providers the agent needs
  const needsAny = supportedProviders.includes('any')
  if (needsAny) {
    // 'any' means any single provider works
    if (availableProviders.size > 0) return
  } else {
    // Check if at least one of the supported providers has a key
    const hasMatch = supportedProviders.some(p => availableProviders.has(p))
    if (hasMatch) return
  }

  // Build the warning message
  const providerList = needsAny
    ? Object.keys(PROVIDER_TO_SECRET_NAME).join(', ')
    : supportedProviders.join(', ')

  const exampleSecretName = needsAny
    ? 'ANTHROPIC_API_KEY'
    : (PROVIDER_TO_SECRET_NAME[supportedProviders[0]] || `${supportedProviders[0].toUpperCase()}_API_KEY`)

  process.stderr.write(
    chalk.yellow(`\n⚠ No LLM vault keys found in workspace '${workspaceSlug}' for providers: ${providerList}\n`) +
    `  Cloud runs will fail until you add keys.\n` +
    `  Add a key: ${chalk.cyan(`orch secrets set ${exampleSecretName} <key>`)}\n`
  )
}

/**
 * Pre-publish check: verify that all required_secrets exist in the workspace
 * BEFORE publishing. This lets users set missing secrets before wasting time
 * on the publish step (DX-3).
 *
 * In TTY mode: warns and asks for confirmation to continue.
 * In non-TTY mode: warns but does not block (for CI/CD pipelines).
 * API errors are silently swallowed (non-fatal).
 *
 * Returns the list of missing secret names (empty if all present or check failed).
 */
export async function prePublishSecretsCheck(
  config: ResolvedConfig,
  workspaceId: string,
  workspaceSlug: string,
  requiredSecrets: string[]
): Promise<string[]> {
  if (!requiredSecrets.length) return []

  let secrets: Array<{ name: string }>
  try {
    const result = await request<{
      secrets: Array<{ name: string }>
    }>(config, 'GET', `/workspaces/${workspaceId}/secrets`)
    secrets = result.secrets
    if (!Array.isArray(secrets)) return []
  } catch {
    return [] // Can't reach API — skip pre-check, gateway will catch at runtime
  }

  const existingNames = new Set(secrets.map(s => s.name))
  const missing = requiredSecrets.filter(name => !existingNames.has(name))
  if (missing.length === 0) return []

  // Show prominent warning about missing secrets
  process.stderr.write(
    chalk.yellow.bold(`\n⚠ ${missing.length} required secret${missing.length === 1 ? '' : 's'} missing from workspace '${workspaceSlug}':\n`)
  )
  for (const name of missing) {
    process.stderr.write(`  ${chalk.yellow('•')} ${chalk.bold(name)}\n`)
  }
  process.stderr.write(`\n  Set them now:\n`)
  for (const name of missing) {
    process.stderr.write(`  ${chalk.cyan(`orch secrets set ${name} <value>`)}\n`)
  }
  process.stderr.write(
    chalk.gray(`\n  Without these secrets, the agent will fail at runtime.\n`)
  )

  // In TTY mode, ask user to confirm they want to continue publishing
  if (process.stdin.isTTY && process.stderr.isTTY) {
    const readline = await import('readline/promises')
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
    const answer = await rl.question(chalk.yellow('\n  Publish anyway? (y/N): '))
    rl.close()
    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
      process.stderr.write('\nPublish cancelled. Set the missing secrets first.\n')
      process.exit(0)
    }
  } else {
    process.stderr.write(chalk.gray(`  (non-interactive — continuing with publish)\n\n`))
  }

  return missing
}

/**
 * After a successful publish, check whether the workspace has all the secrets
 * declared in required_secrets. Warns about any missing ones so the user can
 * set them before running the agent.
 *
 * Best-effort: API errors are silently swallowed (the agent is already published).
 */
export async function checkRequiredSecrets(
  config: ResolvedConfig,
  workspaceId: string,
  workspaceSlug: string,
  requiredSecrets: string[]
): Promise<void> {
  if (!requiredSecrets.length) return

  let secrets: Array<{ name: string }>
  try {
    const result = await request<{
      secrets: Array<{ name: string }>
    }>(config, 'GET', `/workspaces/${workspaceId}/secrets`)
    secrets = result.secrets
    if (!Array.isArray(secrets)) return
  } catch {
    return // Can't reach API — fall back to showing all secrets as instructions
  }

  const existingNames = new Set(secrets.map(s => s.name))
  const missing = requiredSecrets.filter(name => !existingNames.has(name))

  if (missing.length === 0) {
    // All secrets present — brief confirmation
    process.stderr.write(
      chalk.green(`\n✓ All ${requiredSecrets.length} required secret${requiredSecrets.length === 1 ? '' : 's'} found in workspace '${workspaceSlug}'\n`)
    )
    return
  }

  // Some secrets missing — warn with set commands
  process.stderr.write(
    chalk.yellow(`\n⚠ ${missing.length} required secret${missing.length === 1 ? '' : 's'} not set in workspace '${workspaceSlug}':\n`)
  )
  for (const name of missing) {
    process.stderr.write(`  ${chalk.yellow(name)}\n`)
  }
  process.stderr.write(`\n  Set before running:\n`)
  for (const name of missing) {
    process.stderr.write(`  ${chalk.cyan(`orch secrets set ${name} <value>`)}\n`)
  }
}

/**
 * Batch publish all agents found in subdirectories, in dependency order.
 * Discovers orchagent.json/SKILL.md in immediate subdirectories,
 * topologically sorts by manifest dependencies, and publishes leaf-first.
 */
export async function batchPublish(
  rootDir: string,
  options: { profile?: string; dryRun?: boolean; skills?: string; skillsLocked?: boolean; docker?: boolean; localDownload?: boolean; requiredSecrets?: boolean; verbose?: boolean }
): Promise<void> {
  process.stderr.write(`\nScanning for agents in ${rootDir}...\n`)

  const agents = await discoverAgents(rootDir)
  if (agents.length === 0) {
    throw new CliError(
      'No agents found. Expected subdirectories with orchagent.json or SKILL.md files.\n\n' +
      'Example monorepo layout:\n' +
      '  my-project/\n' +
      '    leaf-tool/\n' +
      '      orchagent.json\n' +
      '    orchestrator/\n' +
      '      orchagent.json\n' +
      '      prompt.md\n\n' +
      'Run `orch publish --all` from the parent directory.'
    )
  }

  const result = topoSort(agents)
  if (!result.ok) {
    throw new CliError(
      `Circular dependency detected between: ${result.cycle.join(' → ')}\n\n` +
      'Break the cycle by removing a dependency in one of these agents\' orchagent.json manifest.dependencies.'
    )
  }

  const sorted = result.sorted

  // Resolve org for display (best-effort)
  let orgSlug: string | undefined
  try {
    const config = await getResolvedConfig({}, options.profile)
    const configFile = await loadConfig()
    let workspaceId: string | undefined
    if (configFile.workspace && !options.profile) {
      const { workspaces } = await request<{ workspaces: Array<{ id: string; slug: string }> }>(
        config, 'GET', '/workspaces'
      )
      const ws = workspaces.find(w => w.slug === configFile.workspace)
      if (ws) workspaceId = ws.id
    }
    const org = await getOrg(config, workspaceId)
    orgSlug = org.slug
  } catch {
    // Non-critical — just won't show org prefix
  }

  // Dry-run: show ordering preview and exit (no subprocesses)
  if (options.dryRun) {
    const summary = formatDryRunSummary(sorted, orgSlug)
    process.stderr.write(summary)

    await track('cli_publish_all', {
      total: sorted.length,
      succeeded: 0,
      failed: 0,
      skipped: sorted.length,
      dry_run: true,
    })
    return
  }

  const plan = formatPublishPlan(sorted, orgSlug)
  process.stderr.write(plan)

  // Build the CLI args to forward (exclude --all)
  const forwardArgs: string[] = []
  if (options.profile) forwardArgs.push('--profile', options.profile)
  if (options.dryRun) forwardArgs.push('--dry-run')
  if (options.skills) forwardArgs.push('--skills', options.skills)
  if (options.skillsLocked) forwardArgs.push('--skills-locked')
  if (options.docker) forwardArgs.push('--docker')
  if (options.localDownload === false) forwardArgs.push('--no-local-download')
  if (options.requiredSecrets === false) forwardArgs.push('--no-required-secrets')
  if (options.verbose) forwardArgs.push('--verbose')

  const results: Array<{ name: string; dir: string; success: boolean; error?: string }> = []

  for (let i = 0; i < sorted.length; i++) {
    const agent = sorted[i]
    const label = `[${i + 1}/${sorted.length}]`

    process.stderr.write(`${chalk.bold(label)} Publishing ${chalk.cyan(agent.name)} from ${agent.dirName}/...\n`)

    // Spawn orch publish in the agent's directory
    const spawnResult = spawnSync(
      process.argv[0],
      [process.argv[1], 'publish', ...forwardArgs],
      {
        cwd: agent.dir,
        stdio: ['inherit', 'inherit', 'inherit'],
        env: process.env,
        timeout: 120_000, // 2 minute timeout per agent
      }
    )

    if (spawnResult.status === 0) {
      results.push({ name: agent.name, dir: agent.dirName, success: true })
    } else {
      const errMsg = spawnResult.error?.message || `exit code ${spawnResult.status}`
      results.push({ name: agent.name, dir: agent.dirName, success: false, error: errMsg })

      // Stop on first failure — downstream agents depend on this one
      process.stderr.write(
        chalk.red(`\n✗ Failed to publish ${agent.name}. Stopping — downstream agents may depend on it.\n`)
      )
      break
    }

    if (i < sorted.length - 1) {
      process.stderr.write('\n') // Visual separator between publishes
    }
  }

  // Summary
  const succeeded = results.filter(r => r.success)
  const failed = results.filter(r => !r.success)
  const skipped = sorted.length - results.length

  process.stderr.write('\n' + chalk.bold('─'.repeat(50)) + '\n')
  process.stderr.write(chalk.bold(`Batch publish summary:\n\n`))

  for (const r of results) {
    if (r.success) {
      process.stderr.write(`  ${chalk.green('✔')} ${r.name}\n`)
    } else {
      process.stderr.write(`  ${chalk.red('✗')} ${r.name} — ${r.error}\n`)
    }
  }
  if (skipped > 0) {
    const skippedAgents = sorted.slice(results.length)
    for (const a of skippedAgents) {
      process.stderr.write(`  ${chalk.yellow('○')} ${a.name} (skipped)\n`)
    }
  }

  process.stderr.write(`\n  ${succeeded.length} succeeded`)
  if (failed.length > 0) process.stderr.write(`, ${chalk.red(`${failed.length} failed`)}`)
  if (skipped > 0) process.stderr.write(`, ${chalk.yellow(`${skipped} skipped`)}`)
  process.stderr.write('\n')

  await track('cli_publish_all', {
    total: sorted.length,
    succeeded: succeeded.length,
    failed: failed.length,
    skipped,
    dry_run: options.dryRun || false,
  })

  if (failed.length > 0) {
    throw new CliError(`Batch publish failed: ${failed[0].name}`, ExitCodes.GENERAL_ERROR)
  }
}

export function registerPublishCommand(program: Command): void {
  program
    .command('publish')
    .description('Publish agent or skill from local files')
    .option('--url <url>', 'Agent URL (for code-based agents)')
    .option('--profile <name>', 'Use API key from named profile')
    .option('--dry-run', 'Show what would be published without making changes')
    .option('--skills <skills>', 'Default skills (comma-separated, e.g., org/skill@v1,org/other@v1)')
    .option('--skills-locked', 'Lock default skills (callers cannot override via headers)')
    .option('--docker', 'Include Dockerfile for custom environment (builds E2B template)')
    .option('--no-local-download', 'Prevent users from downloading and running locally (default: allowed)')
    .option('--no-required-secrets', '(deprecated) No longer needed — required_secrets defaults to []')
    .option('--all', 'Publish all agents in subdirectories (dependency order)')
    .option('--verbose', 'Show detailed bundle contents (file list)')
    .action(async (options: { url?: string; profile?: string; dryRun?: boolean; skills?: string; skillsLocked?: boolean; docker?: boolean; localDownload?: boolean; requiredSecrets?: boolean; all?: boolean; verbose?: boolean }) => {
      const cwd = process.cwd()

      // --all: batch publish all agents in subdirectories
      if (options.all) {
        await batchPublish(cwd, options)
        return
      }

      const skillsFromFlag = options.skills
        ? options.skills.split(',').map(s => s.trim()).filter(Boolean)
        : undefined
      const config = await getResolvedConfig({}, options.profile)

      // Resolve workspace context — if `orch workspace use` was called, publish
      // to that workspace instead of the personal org (F-5)
      // Skip workspace resolution when using a named profile — the global
      // workspace belongs to the default profile's context, not the named one.
      const configFile = await loadConfig()
      let workspaceId: string | undefined
      if (configFile.workspace && !options.profile) {
        const { workspaces } = await request<{ workspaces: Array<{ id: string; slug: string; name: string }> }>(
          config, 'GET', '/workspaces'
        )
        const ws = workspaces.find(w => w.slug === configFile.workspace)
        if (!ws) {
          throw new CliError(
            `Workspace '${configFile.workspace}' not found. Run \`orch workspace list\` to see available workspaces.`
          )
        }
        workspaceId = ws.id

        // Warn when publishing to the public showcase workspace
        if (ws.slug === 'orchagent-public' && !options.dryRun) {
          process.stderr.write(
            chalk.red.bold('\n  PUBLIC WORKSPACE\n') +
            chalk.red(`  Everything published to "${ws.slug}" is publicly visible on orchagent.io.\n\n`)
          )
          const readline = await import('readline/promises')
          const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
          const answer = await rl.question(chalk.red('  Continue? (y/N): '))
          rl.close()
          if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
            process.stderr.write('\nPublish cancelled.\n')
            process.exit(0)
          }
        }
      }

      // Check for SKILL.md first (skills take precedence)
      const skillMdPath = path.join(cwd, 'SKILL.md')
      const skillData = await parseSkillMd(skillMdPath)

      if (skillData) {
        // Publish as a skill (server auto-assigns version)
        const org = await getOrg(config, workspaceId)

        if (workspaceId && !options.dryRun) {
          process.stdout.write(`Workspace: ${org.slug}\n`)
        }

        // SC-05: Collect all files in the skill directory for multi-file support
        const skillFiles = await collectSkillFiles(cwd)
        const hasMultipleFiles = skillFiles.length > 1

        // Handle dry-run for skills
        if (options.dryRun) {
          const preview = await previewAgentVersion(config, skillData.frontmatter.name, workspaceId)
          const skillBodyBytes = Buffer.byteLength(skillData.body, 'utf-8')
          const totalFilesSize = skillFiles.reduce((sum, f) => sum + f.size, 0)
          const versionInfo = preview.existing_versions.length > 0
            ? `${preview.next_version} (new version, ${preview.existing_versions[preview.existing_versions.length - 1]} exists)`
            : `${preview.next_version} (first version)`

          process.stderr.write('\nDRY RUN - No changes will be made\n\n')
          process.stderr.write('Validating...\n')
          process.stderr.write(`  ✓ SKILL.md found and valid\n`)
          process.stderr.write(`  ✓ Skill prompt (${skillBodyBytes.toLocaleString()} bytes)\n`)
          if (hasMultipleFiles) {
            process.stderr.write(`  ✓ Skill files: ${skillFiles.length} files (${(totalFilesSize / 1024).toFixed(1)} KB)\n`)
          }
          process.stderr.write(`  ✓ Authentication valid (org: ${org.slug})\n`)
          process.stderr.write('\nSkill Preview:\n')
          process.stderr.write(`  Name:        ${skillData.frontmatter.name}\n`)
          process.stderr.write(`  Type:        skill\n`)
          if (workspaceId) {
            process.stderr.write(`  Workspace:   ${org.slug}\n`)
          }
          process.stderr.write(`  Version:     ${versionInfo}\n`)
          process.stderr.write(`  Visibility:  private\n`)
          process.stderr.write(`  Providers:   any\n`)
          if (hasMultipleFiles) {
            process.stderr.write(`  Files:       ${skillFiles.length} files\n`)
            for (const f of skillFiles.slice(0, 5)) {
              process.stderr.write(`               - ${f.path}\n`)
            }
            if (skillFiles.length > 5) {
              process.stderr.write(`               ... and ${skillFiles.length - 5} more\n`)
            }
          }
          process.stderr.write(`\nWould publish: ${preview.org_slug}/${skillData.frontmatter.name}@${preview.next_version}\n`)
          process.stderr.write(`API endpoint: POST ${config.apiUrl}/${preview.org_slug}/${skillData.frontmatter.name}/${preview.next_version}/run\n\n`)
          process.stderr.write('No changes made (dry run)\n')
          return
        }

        try {
          const skillResult = await createAgent(config, {
            name: skillData.frontmatter.name,
            type: 'skill',
            description: skillData.frontmatter.description,
            prompt: skillData.body,
            is_public: false,
            callable: false,
            supported_providers: ['any'],
            default_skills: skillsFromFlag,
            skills_locked: options.skillsLocked || undefined,
            // SC-05: Include all skill files for UI preview
            skill_files: hasMultipleFiles ? skillFiles : undefined,
            allow_local_download: options.localDownload !== false,
          }, workspaceId)
          const skillVersion = skillResult.agent?.version || 'v1'
          const skillAgentId = skillResult.agent?.id

          await track('cli_publish', { agent_type: 'skill', multi_file: hasMultipleFiles })
          process.stdout.write(`\n${chalk.green('✔')} Published ${org.slug}/${skillData.frontmatter.name}@${skillVersion} successfully!\n\n`)
          if (hasMultipleFiles) {
            process.stdout.write(`Files: ${skillFiles.length} files included\n`)
            if (options.verbose) {
              for (const f of skillFiles) {
                process.stdout.write(`  ${f.path}\n`)
              }
            }
          }
          process.stdout.write(`Visibility: private\n`)

          process.stdout.write(`\nView analytics and usage: https://orchagent.io/dashboard\n`)
        } catch (err) {
          throw err
        }
        return
      }

      // Read manifest
      const manifestPath = path.join(cwd, 'orchagent.json')
      let manifest: AgentManifest
      try {
        const raw = await fs.readFile(manifestPath, 'utf-8')
        manifest = JSON.parse(raw)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new CliError('No orchagent.json found. Run `orchagent init` first.')
        }
        throw new CliError(`Failed to read orchagent.json: ${err}`)
      }

      // UX-1: Collect validation errors and report them all at once
      const validationErrors: string[] = []

      // Validate manifest
      if (!manifest.name) {
        validationErrors.push('orchagent.json must have name')
      } else {
        // Validate agent name format (must match gateway rules)
        const agentNameRegex = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/
        const agentName = manifest.name
        if (agentName.length < 2 || agentName.length > 50) {
          validationErrors.push('Agent name must be 2-50 characters')
        }
        if (agentName !== agentName.toLowerCase()) {
          validationErrors.push('Agent name must be lowercase')
        }
        if (agentName.length > 1 && !agentNameRegex.test(agentName)) {
          validationErrors.push('Agent name must contain only lowercase letters, numbers, and hyphens, and must start/end with a letter or number')
        }
        if (agentName.includes('--')) {
          validationErrors.push('Agent name must not contain consecutive hyphens')
        }
      }
      const { canonicalType, rawType } = canonicalizeManifestType(manifest.type)
      const runMode = normalizeRunMode(manifest.run_mode)
      const executionEngine = inferExecutionEngineFromManifest(manifest, rawType)
      const callable = manifest.callable !== undefined ? Boolean(manifest.callable) : true

      if (canonicalType === 'skill') {
        throw new CliError(
          'Skills use a different publishing format (SKILL.md with YAML front matter).\n\n' +
          '  To publish a skill:\n' +
          '    1. Run: orchagent skill create ' + (manifest.name || '<name>') + '\n' +
          '    2. Edit the generated SKILL.md with your skill content\n' +
          '    3. Run: orchagent publish\n\n' +
          '  orchagent.json is not used for skills — SKILL.md replaces it entirely.\n' +
          '  See: https://orchagent.io/docs/skills'
        )
      }
      if (runMode === 'always_on' && executionEngine === 'direct_llm') {
        validationErrors.push('run_mode=always_on requires runtime.command or loop configuration')
      }
      if (manifest.timeout_seconds !== undefined) {
        if (!Number.isInteger(manifest.timeout_seconds) || manifest.timeout_seconds <= 0) {
          validationErrors.push('timeout_seconds must be a positive integer')
        }
      }

      // Validate model_tasks: "default" key required, all values non-empty strings
      if (manifest.model_tasks !== undefined) {
        if (typeof manifest.model_tasks !== 'object' || manifest.model_tasks === null || Array.isArray(manifest.model_tasks)) {
          validationErrors.push('model_tasks must be an object mapping task names to model IDs')
        } else {
          const tasks = manifest.model_tasks
          if (!tasks.default) {
            validationErrors.push('model_tasks must include a "default" key')
          }
          for (const [taskName, modelId] of Object.entries(tasks)) {
            if (typeof modelId !== 'string' || modelId.trim() === '') {
              validationErrors.push(`model_tasks.${taskName} must be a non-empty string (model ID)`)
            }
            if (!/^[a-z0-9_]+$/.test(taskName)) {
              validationErrors.push(`model_tasks key "${taskName}" must contain only lowercase letters, numbers, and underscores`)
            }
          }
        }
      }

      // Warn about deprecated prompt field
      if (manifest.prompt) {
        process.stderr.write(chalk.yellow('Warning: "prompt" field in orchagent.json is ignored. Use prompt.md file instead.\n'))
      }

      // UX-9: Warn about model (singular) vs default_models
      if ((manifest as Record<string, unknown>).model && !manifest.default_models) {
        const modelVal = (manifest as Record<string, unknown>).model
        process.stderr.write(chalk.yellow(
          `\nWarning: "model" field in orchagent.json is not recognized.\n` +
          `  Use "default_models" instead to set per-provider defaults:\n\n` +
          `  ${chalk.cyan(`"default_models": { "anthropic": "${modelVal}" }`)}\n\n` +
          `  The model resolution order is: caller --model flag → agent default_models → platform default.\n\n`
        ))
      }

      // DX-17: Validate model IDs in default_models
      if (manifest.default_models && typeof manifest.default_models === 'object') {
        const modelWarnings = validateModelIds(manifest.default_models as Record<string, string>)
        for (const w of modelWarnings) {
          process.stderr.write(chalk.yellow(`Warning: ${w.message}\n`))
        }
      }

      // Auto-migrate inline schemas to schema.json
      const schemaPath = path.join(cwd, 'schema.json')
      let schemaFileExists = false
      try {
        await fs.access(schemaPath)
        schemaFileExists = true
      } catch {
        // File doesn't exist
      }

      if ((manifest.input_schema || manifest.output_schema) && !schemaFileExists) {
        // Auto-create schema.json from inline schemas
        const schemaContent: Record<string, object> = {}
        if (manifest.input_schema) schemaContent.input = manifest.input_schema
        if (manifest.output_schema) schemaContent.output = manifest.output_schema

        if (options.dryRun) {
          process.stderr.write(chalk.cyan('Would create schema.json from inline schemas in orchagent.json\n'))
        } else {
          await fs.writeFile(schemaPath, JSON.stringify(schemaContent, null, 2) + '\n')
          process.stderr.write(chalk.green('Created schema.json from inline schemas in orchagent.json\n'))
          process.stderr.write(chalk.yellow('You can now remove input_schema/output_schema from orchagent.json\n'))
        }
      } else if ((manifest.input_schema || manifest.output_schema) && schemaFileExists) {
        process.stderr.write(chalk.yellow('Warning: inline schemas in orchagent.json are ignored (schema.json takes priority).\n'))
      }

      // Check for misplaced manifest fields at top level (common user error)
      const manifestFields = ['manifest_version', 'dependencies', 'max_hops', 'timeout_ms', 'per_call_downstream_cap']
      const misplacedFields = manifestFields.filter(f => f in manifest && !manifest.manifest)
      if (misplacedFields.length > 0) {
        validationErrors.push(
          `Found manifest fields (${misplacedFields.join(', ')}) at top level of orchagent.json. ` +
          `These must be nested under a "manifest" key. See docs/manifest.md for details.`
        )
      }

      // Read prompt for LLM-driven engines (direct_llm + managed_loop).
      let prompt: string | undefined
      if (executionEngine === 'direct_llm' || executionEngine === 'managed_loop') {
        const promptPath = path.join(cwd, 'prompt.md')
        try {
          prompt = await fs.readFile(promptPath, 'utf-8')
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            validationErrors.push(
              'No prompt.md found. Create a prompt.md file with your prompt template.'
            )
          } else {
            throw err
          }
        }
      }

      // Validate managed-loop specific fields + normalize loop payload
      let loopConfig: Record<string, unknown> | undefined
      if (executionEngine === 'managed_loop') {
        if (manifest.max_turns !== undefined) {
          if (typeof manifest.max_turns !== 'number' || manifest.max_turns < 1 || manifest.max_turns > 50) {
            validationErrors.push('max_turns must be a number between 1 and 50')
          }
        }

        const providedLoop =
          manifest.loop && typeof manifest.loop === 'object'
            ? { ...manifest.loop }
            : {}
        if (!('max_turns' in providedLoop) && manifest.max_turns !== undefined) {
          providedLoop.max_turns = manifest.max_turns
        }
        if (!('custom_tools' in providedLoop) && manifest.custom_tools?.length) {
          providedLoop.custom_tools = manifest.custom_tools
        }
        if (Object.keys(providedLoop).length === 0) {
          providedLoop.max_turns = 25
        }
        loopConfig = providedLoop

        // Validate custom_tools from the merged loopConfig (covers both top-level
        // manifest.custom_tools and loop.custom_tools placements — BUG-15)
        const mergedTools = Array.isArray(loopConfig.custom_tools) ? loopConfig.custom_tools as Array<{ name?: string; command?: string }> : []
        if (mergedTools.length > 0) {
          const reservedNames = new Set(['bash', 'read_file', 'write_file', 'list_files', 'submit_result'])
          const seenNames = new Set<string>()
          for (const tool of mergedTools) {
            if (!tool.name || !tool.command) {
              validationErrors.push(
                `Invalid custom_tool: each tool must have 'name' and 'command' fields. Found: ${JSON.stringify(tool)}`
              )
            } else {
              if (reservedNames.has(tool.name)) {
                validationErrors.push(
                  `Custom tool '${tool.name}' conflicts with a built-in tool name. Reserved names: ${[...reservedNames].join(', ')}`
                )
              }
              if (seenNames.has(tool.name)) {
                validationErrors.push(`Duplicate custom tool name: '${tool.name}'`)
              }
              seenNames.add(tool.name)
            }
          }
        }

        if (!manifest.supported_providers) {
          manifest.supported_providers = ['anthropic']
        }
      }

      // Read schemas
      let inputSchema: object | undefined
      let outputSchema: object | undefined
      let schemaFromFile = false
      try {
        const raw = await fs.readFile(schemaPath, 'utf-8')
        const schemas = JSON.parse(raw)
        inputSchema = schemas.input
        outputSchema = schemas.output
        schemaFromFile = true
      } catch (err) {
        // Schema is optional
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new CliError(`Failed to read schema.json: ${err}`)
        }
      }

      // For direct LLM and managed loop agents, derive input schema from template variables if needed.
      if (prompt && (executionEngine === 'direct_llm' || executionEngine === 'managed_loop')) {
        const templateVars = extractTemplateVariables(prompt)
        if (templateVars.length > 0) {
          if (!schemaFromFile) {
            // No schema.json provided - auto-generate from template variables
            inputSchema = deriveInputSchema(templateVars)
          } else if (inputSchema && 'properties' in (inputSchema as any)) {
            // schema.json exists - check for mismatches with template variables
            const schemaProps = Object.keys((inputSchema as any).properties || {})
            const missing = templateVars.filter(v => !schemaProps.includes(v))
            const extra = schemaProps.filter(p => !templateVars.includes(p))
            if (missing.length > 0 || extra.length > 0) {
              const parts: string[] = []
              if (missing.length > 0) {
                parts.push(`template uses {{${missing.join('}}, {{')}}} but schema.json doesn't define ${missing.join(', ')}`)
              }
              if (extra.length > 0) {
                parts.push(`schema.json defines ${extra.join(', ')} but template doesn't use {{${extra.join('}}, {{')}}}`)
              }
              process.stderr.write(chalk.yellow(`Warning: Schema mismatch - ${parts.join('; ')}.\n`))
              process.stderr.write(chalk.yellow(`  Consider updating schema.json to match your prompt.md template variables.\n`))
            }
          }
        }
      }

      let agentUrl = options.url
      let shouldUploadBundle = false
      let servicesUpdated = 0
      let runtimeConfig: Record<string, unknown> | undefined
      let bundleEntrypoint = manifest.entrypoint

      if (executionEngine === 'code_runtime') {
        if (!bundleEntrypoint) {
          bundleEntrypoint = await detectEntrypoint(cwd) || undefined
        }
        if (!options.url) {
          if (!bundleEntrypoint) {
            validationErrors.push(
              'Tool requires either --url <url> or an entry point file (main.py, app.py, index.js, etc.)'
            )
          } else {
            shouldUploadBundle = true
            agentUrl = 'https://tool.internal'
            process.stdout.write(`Detected code runtime entrypoint: ${bundleEntrypoint}\n`)
          }
        }

        let runtimeCommand = manifest.runtime?.command?.trim() || ''
        if (!runtimeCommand && manifest.run_command?.trim()) {
          runtimeCommand = manifest.run_command.trim()
        }
        if (!runtimeCommand) {
          runtimeCommand = commandForEntrypoint(bundleEntrypoint || 'main.py')
        }
        runtimeConfig = { ...(manifest.runtime || {}), command: runtimeCommand }
      } else {
        agentUrl = agentUrl || 'https://prompt-agent.internal'
      }

      if (options.docker && executionEngine !== 'code_runtime') {
        validationErrors.push('--docker is only supported for code runtime agents')
      }

      // Get org info (workspace-aware — returns workspace org if workspace is active)
      const org = await getOrg(config, workspaceId)

      if (workspaceId && !options.dryRun) {
        process.stdout.write(`Workspace: ${org.slug}\n`)
      }

      // Default to 'any' provider if not specified
      const supportedProviders = manifest.supported_providers || ['any']

      // Detect SDK compatibility for code runtime agents
      let sdkCompatible = false
      if (executionEngine === 'code_runtime') {
        sdkCompatible = await detectSdkCompatible(cwd)
        if (sdkCompatible && !options.dryRun) {
          process.stdout.write(`SDK detected - agent will be marked as Local Ready\n`)
        }
      }

      // Check if manifest dependencies are published and callable (F-9b).
      // Runs for both dry-run and normal publish so users catch issues early.
      const manifestDeps = manifest.manifest?.dependencies
      if (manifestDeps?.length) {
        const depResults = await checkDependencies(config, manifestDeps, org.slug, workspaceId)
        const notFound = depResults.filter(r => r.status === 'not_found')
        const notFoundCrossOrg = depResults.filter(r => r.status === 'not_found_cross_org')
        const notCallable = depResults.filter(r => r.status === 'found_not_callable')

        if (notFound.length > 0) {
          process.stderr.write(chalk.yellow(`\n⚠ Unpublished dependencies:\n`))
          for (const dep of notFound) {
            process.stderr.write(chalk.yellow(`  - ${dep.ref}\n`))
          }
          process.stderr.write(
            `\n  These agents must be published before this orchestrator can call them.\n` +
            `  Publish each dependency first, then re-run this publish.\n\n`
          )
        }

        if (notFoundCrossOrg.length > 0) {
          process.stderr.write(chalk.yellow(`\n⚠ Dependencies not found (unpublished or not accessible from this workspace):\n`))
          for (const dep of notFoundCrossOrg) {
            process.stderr.write(chalk.yellow(`  - ${dep.ref}\n`))
          }
          process.stderr.write(
            `\n  If the dependency is published in another workspace, ensure it's in the same\n` +
            `  workspace as this orchestrator, or use agent access grants.\n\n`
          )
        }

        if (notCallable.length > 0) {
          process.stderr.write(chalk.yellow(`\n⚠ Dependencies have callable: false:\n`))
          for (const dep of notCallable) {
            process.stderr.write(chalk.yellow(`  - ${dep.ref}\n`))
          }
          process.stderr.write(
            `\n  These agents have explicitly set callable: false, which blocks\n` +
            `  agent-to-agent calls at runtime. Set callable: true (or remove\n` +
            `  the field to use the default) and republish each dependency.\n\n`
          )
        }
      }

      // UX-13-02: Warn when managed-loop orchestrator has dependencies but no custom_tools.
      // Without custom_tools, the LLM has no way to call its declared dependencies.
      if (executionEngine === 'managed_loop' && manifestDeps?.length) {
        const mergedTools = Array.isArray((loopConfig as any)?.custom_tools) ? (loopConfig as any).custom_tools : []
        if (mergedTools.length === 0) {
          process.stderr.write(chalk.yellow(
            `\n⚠ This managed-loop agent declares dependencies but no custom_tools.\n` +
            `  Without custom_tools, the LLM cannot call dependencies at runtime —\n` +
            `  it will waste turns exploring the filesystem instead.\n\n` +
            `  Use 'orch scaffold orchestration' to auto-generate the correct\n` +
            `  custom_tools configuration, or add them manually to your loop config:\n\n` +
            `    "loop": {\n` +
            `      "custom_tools": [\n` +
            `        { "name": "call_worker", "description": "...", "command": "python3 /home/user/helpers/orch_call.py org/worker@v1" }\n` +
            `      ]\n` +
            `    }\n\n`
          ))
        }
      }

      // UX-2: Default required_secrets to [] when omitted for tool/agent types.
      // Prompt and skill types are exempt (prompt agents get LLM keys from platform,
      // skills don't run standalone).
      if (
        (canonicalType === 'tool' || canonicalType === 'agent') &&
        manifest.required_secrets === undefined
      ) {
        manifest.required_secrets = []
        process.stderr.write(
          chalk.dim(`  ℹ No required_secrets declared — defaulting to [] (no secrets needed)\n`)
        )
      }

      // UX-1: Report all validation errors at once
      if (validationErrors.length > 0) {
        if (validationErrors.length === 1) {
          throw new CliError(validationErrors[0])
        }
        const numbered = validationErrors.map((e, i) => `  ${i + 1}. ${e}`).join('\n')
        process.stderr.write(
          chalk.red(`\nFound ${validationErrors.length} validation errors:\n\n`) +
          numbered + '\n'
        )
        const err = new CliError(
          `Found ${validationErrors.length} validation errors:\n${numbered}`,
          ExitCodes.INVALID_INPUT
        )
        err.displayed = true
        throw err
      }

      // Handle dry-run for agents
      if (options.dryRun) {
        const preview = await previewAgentVersion(config, manifest.name, workspaceId)
        const versionInfo = preview.existing_versions.length > 0
          ? `${preview.next_version} (new version, ${preview.existing_versions[preview.existing_versions.length - 1]} exists)`
          : `${preview.next_version} (first version)`

        process.stderr.write('\nDRY RUN - No changes will be made\n\n')
        process.stderr.write('Validating...\n')
        process.stderr.write(`  ✓ orchagent.json found and valid\n`)

        if (executionEngine === 'direct_llm') {
          const promptBytes = prompt ? Buffer.byteLength(prompt, 'utf-8') : 0
          process.stderr.write(`  ✓ prompt.md found (${promptBytes.toLocaleString()} bytes)\n`)
          if (schemaFromFile) {
            const schemaTypes = [inputSchema ? 'input' : null, outputSchema ? 'output' : null].filter(Boolean).join(' + ')
            process.stderr.write(`  ✓ schema.json found (${schemaTypes} schemas)\n`)
          } else if (inputSchema) {
            const vars = prompt ? extractTemplateVariables(prompt) : []
            process.stderr.write(`  ✓ Input schema derived from template variables: ${vars.join(', ')}\n`)
          }
        } else if (executionEngine === 'managed_loop') {
          const promptBytes = prompt ? Buffer.byteLength(prompt, 'utf-8') : 0
          process.stderr.write(`  ✓ prompt.md found (${promptBytes.toLocaleString()} bytes)\n`)
          if (schemaFromFile) {
            const schemaTypes = [inputSchema ? 'input' : null, outputSchema ? 'output' : null].filter(Boolean).join(' + ')
            process.stderr.write(`  ✓ schema.json found (${schemaTypes} schemas)\n`)
          }
          const customToolCount = Array.isArray((loopConfig as any)?.custom_tools) ? (loopConfig as any).custom_tools.length : 0
          process.stderr.write(`  ✓ Custom tools: ${customToolCount}\n`)
          process.stderr.write(`  ✓ Max turns: ${(loopConfig as any)?.max_turns || manifest.max_turns || 25}\n`)
        } else if (executionEngine === 'code_runtime') {
          process.stderr.write(`  ✓ runtime.command: ${String(runtimeConfig?.command || '')}\n`)
          process.stderr.write(`  ✓ Entrypoint: ${bundleEntrypoint || '(remote url only)'}\n`)
          if (sdkCompatible) {
            process.stderr.write(`  ✓ SDK detected (orchagent-sdk in requirements.txt)\n`)
          }
        }

        process.stderr.write(`  ✓ Authentication valid (org: ${org.slug})\n`)

        // For hosted code-runtime agents, show bundle preview
        if (shouldUploadBundle) {
          const bundlePreview = await previewBundle(cwd, {
            entrypoint: bundleEntrypoint,
            exclude: manifest.bundle?.exclude,
            include: manifest.bundle?.include,
          })
          process.stderr.write(`\nBundle Preview:\n`)
          process.stderr.write(`  Files:       ${bundlePreview.fileCount} files\n`)
          process.stderr.write(`  Size:        ${(bundlePreview.totalSizeBytes / 1024).toFixed(1)} KB\n`)
          process.stderr.write(`  Entrypoint:  ${bundlePreview.entrypoint}\n`)
          if (options.verbose && bundlePreview.files?.length) {
            process.stderr.write(`  Bundled files:\n`)
            for (const f of bundlePreview.files) {
              process.stderr.write(`    ${f}\n`)
            }
          }
        }

        process.stderr.write('\nAgent Preview:\n')
        process.stderr.write(`  Name:        ${manifest.name}\n`)
        process.stderr.write(`  Type:        ${canonicalType}\n`)
        if (workspaceId) {
          process.stderr.write(`  Workspace:   ${org.slug}\n`)
        }
        process.stderr.write(`  Run mode:    ${runMode}\n`)
        process.stderr.write(`  Engine:      ${executionEngine}${shouldUploadBundle ? ' (hosted)' : ''}\n`)
        process.stderr.write(`  Callable:    ${callable ? 'enabled' : 'disabled'}\n`)
        process.stderr.write(`  Version:     ${versionInfo}\n`)
        process.stderr.write(`  Visibility:  private\n`)
        process.stderr.write(`  Providers:   ${supportedProviders.join(', ')}\n`)
        const effectiveSkills = skillsFromFlag || manifest.default_skills
        const effectiveLocked = manifest.skills_locked || options.skillsLocked
        if (effectiveLocked) {
          process.stderr.write(`  Skills:      ${effectiveSkills?.join(', ') || '(none)'} [LOCKED]\n`)
        } else if (effectiveSkills?.length) {
          process.stderr.write(`  Skills:      ${effectiveSkills.join(', ')}\n`)
        }
        if (manifest.required_secrets?.length) {
          process.stderr.write(`  Secrets:     ${manifest.required_secrets.join(', ')}\n`)
        }
        if (manifest.environment) {
          const envParts: string[] = []
          if (manifest.environment.python_version) envParts.push(`Python ${manifest.environment.python_version}`)
          if (manifest.environment.node_version) envParts.push(`Node ${manifest.environment.node_version}`)
          if (manifest.environment.pip_flags) envParts.push(`pip: ${manifest.environment.pip_flags}`)
          if (manifest.environment.npm_flags) envParts.push(`npm: ${manifest.environment.npm_flags}`)
          if (envParts.length) {
            process.stderr.write(`  Environment: ${envParts.join(', ')}\n`)
          }
        }

        // Server-side validation (BUG-11: dry-run missed server-side checks)
        process.stderr.write(`\nServer validation...\n`)
        try {
          const validation = await validateAgentPublish(config, {
            name: manifest.name,
            type: canonicalType,
            run_mode: runMode,
            runtime: runtimeConfig,
            loop: loopConfig,
            callable,
            description: manifest.description,
            prompt,
            url: agentUrl,
            input_schema: inputSchema,
            output_schema: outputSchema,
            is_public: false,
            supported_providers: supportedProviders,
            default_models: manifest.default_models,
            timeout_seconds: manifest.timeout_seconds,
            run_command: manifest.run_command,
            sdk_compatible: sdkCompatible || undefined,
            manifest: manifest.manifest,
            required_secrets: manifest.required_secrets,
            optional_secrets: manifest.optional_secrets,
            default_skills: skillsFromFlag || manifest.default_skills,
            skills_locked: manifest.skills_locked || options.skillsLocked || undefined,
            allow_local_download: options.localDownload !== false,
            environment: manifest.environment,
          }, workspaceId)

          if (validation.warnings?.length) {
            for (const warning of validation.warnings) {
              process.stderr.write(chalk.yellow(`  ⚠ ${warning}\n`))
            }
          }

          if (!validation.valid) {
            for (const error of validation.errors) {
              process.stderr.write(chalk.red(`  ✗ ${error}\n`))
            }
            process.stderr.write(chalk.red(`\nDry run failed: server-side validation found ${validation.errors.length} error(s)\n`))
            process.stderr.write('No changes made (dry run)\n')
            const err = new CliError('Server-side validation failed', ExitCodes.INVALID_INPUT)
            err.displayed = true
            throw err
          }
          process.stderr.write(`  ✓ Server-side validation passed\n`)
        } catch (err) {
          if (err instanceof CliError) throw err
          // Network or auth errors — show warning but don't block dry-run
          process.stderr.write(chalk.yellow(`  ⚠ Could not reach server for validation (offline?)\n`))
        }

        process.stderr.write(`\nWould publish: ${preview.org_slug}/${manifest.name}@${preview.next_version}\n`)
        if (shouldUploadBundle) {
          const bundlePreview = await previewBundle(cwd, {
            entrypoint: bundleEntrypoint,
            exclude: manifest.bundle?.exclude,
            include: manifest.bundle?.include,
          })
          process.stderr.write(`Would upload bundle: ${(bundlePreview.totalSizeBytes / 1024).toFixed(1)} KB\n`)
        }
        process.stderr.write(`API endpoint: POST ${config.apiUrl}/${preview.org_slug}/${manifest.name}/${preview.next_version}/run\n\n`)
        process.stderr.write('No changes made (dry run)\n')
        return
      }

      // Warn if ORCHAGENT_SERVICE_KEY is in required_secrets — the gateway
      // auto-injects it for agents with manifest dependencies (F-12).
      if (manifest.required_secrets?.includes('ORCHAGENT_SERVICE_KEY')) {
        process.stderr.write(
          '\n⚠ Warning: ORCHAGENT_SERVICE_KEY found in required_secrets.\n' +
          '  The gateway auto-injects this for agents with manifest dependencies.\n' +
          '  Having it in required_secrets can override the auto-injected key and\n' +
          '  break orchestration. Remove it from required_secrets in orchagent.json.\n\n'
        )
      }

      // Scan code for env var references not covered by required_secrets (F-1a).
      // Only relevant for agents with code (code_runtime engine).
      if (executionEngine === 'code_runtime') {
        const undeclared = await scanUndeclaredEnvVars(cwd, manifest.required_secrets || [])
        if (undeclared.length > 0) {
          process.stderr.write(
            chalk.yellow(`\n⚠ Your code references environment variables not in required_secrets:\n`) +
            chalk.yellow(`  ${undeclared.join(', ')}\n\n`) +
            `  If these should be workspace secrets, add them to required_secrets\n` +
            `  in orchagent.json so they're available in the sandbox at runtime.\n` +
            `  (Platform-injected vars like LLM API keys are already excluded.)\n\n`
          )
        }
      }

      // Warn if always_on code binds to port 8080 (reserved for platform health server)
      if (runMode === 'always_on' && executionEngine === 'code_runtime') {
        const usesReservedPort = await scanReservedPort(cwd)
        if (usesReservedPort) {
          process.stderr.write(
            chalk.yellow(`\n⚠ Your code appears to bind to port 8080, which is reserved by the\n`) +
            chalk.yellow(`  platform health server for always-on services.\n\n`) +
            `  Your service will crash with EADDRINUSE at runtime.\n` +
            `  Use a different port (e.g. 3000) or read the ORCHAGENT_HEALTH_PORT\n` +
            `  env var to detect the reserved port.\n\n`
          )
        }
      }

      // Pre-publish: check required secrets exist in workspace (DX-3)
      // Fail fast — warn before spending time on the publish API call
      await prePublishSecretsCheck(
        config,
        workspaceId || org.id,
        org.slug,
        manifest.required_secrets || []
      )

      // Create the agent (server auto-assigns version)
      let result: Awaited<ReturnType<typeof createAgent>>
      try {
        result = await createAgent(config, {
          name: manifest.name,
          type: canonicalType,
          run_mode: runMode,
          runtime: runtimeConfig,
          loop: loopConfig,
          callable,
          description: manifest.description,
          prompt,
          url: agentUrl,
          input_schema: inputSchema,
          output_schema: outputSchema,
          tags: manifest.tags,
          is_public: false,
          supported_providers: supportedProviders,
          default_models: manifest.default_models,
          timeout_seconds: manifest.timeout_seconds,
          // Local run fields for code runtime agents
          source_url: manifest.source_url,
          pip_package: manifest.pip_package,
          run_command: manifest.run_command,
          // SDK compatibility flag
          sdk_compatible: sdkCompatible || undefined,
          // Orchestration manifest (includes dependencies)
          manifest: manifest.manifest,
          required_secrets: manifest.required_secrets,
          optional_secrets: manifest.optional_secrets,
          default_skills: skillsFromFlag || manifest.default_skills,
          skills_locked: manifest.skills_locked || options.skillsLocked || undefined,
          allow_local_download: options.localDownload !== false,
          // Environment pinning
          environment: manifest.environment,
          // Per-task model assignment
          model_tasks: manifest.model_tasks,
        }, workspaceId)
      } catch (err) {
        // Improve SECURITY_BLOCKED error display
        if (err instanceof ApiError && err.status === 422) {
          const payload = err.payload as Record<string, unknown> | undefined
          const errorCode = (payload?.error as Record<string, unknown>)?.code
          if (errorCode === 'SECURITY_BLOCKED') {
            const analysis = payload?.security_analysis as Record<string, unknown> | undefined
            const blockReason = (payload?.error as Record<string, unknown>)?.message || 'Security pattern detected'

            process.stderr.write(chalk.red(`\nPublish blocked: ${blockReason}\n\n`))

            // Show matched patterns with file:line
            const matches = (analysis?.matches || []) as Array<Record<string, unknown>>
            if (matches.length > 0) {
              process.stderr.write(chalk.yellow('Patterns detected:\n'))
              for (const match of matches.slice(0, 5)) {
                const severity = String(match.severity || '').toUpperCase()
                const file = match.file_path || 'unknown'
                const line = match.line_number || '?'
                const desc = match.description || match.pattern_id || ''
                process.stderr.write(`  ${chalk.red(severity)} ${file}:${line} — ${desc}\n`)
              }
              process.stderr.write('\n')
            }

            process.stderr.write(
              'Skills are scanned for patterns that could instruct AI agents to\n' +
              'perform harmful actions (shell injection, data exfiltration, etc.).\n\n' +
              'Code-execution references (eval, subprocess, importlib) are allowed\n' +
              'since the E2B sandbox is the security boundary for code execution.\n'
            )
            throw new CliError('Publish blocked by security scan', ExitCodes.PERMISSION_DENIED)
          }
        }
        throw err
      }

      const assignedVersion = result.agent?.version || 'v1'
      const agentId = result.agent?.id

      // Upload code bundle for hosted code runtime agents
      if (shouldUploadBundle && agentId) {
        process.stdout.write(`\nBundling code...\n`)

        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchagent-bundle-'))
        const bundlePath = path.join(tempDir, 'bundle.zip')

        try {
          // Build include patterns - add Dockerfile if --docker flag is set
          const includePatterns = [...(manifest.bundle?.include || [])]
          if (options.docker) {
            const dockerfilePath = path.join(cwd, 'Dockerfile')
            try {
              await fs.access(dockerfilePath)
              includePatterns.push('Dockerfile')
              process.stdout.write(`  Including Dockerfile for custom environment\n`)
            } catch {
              throw new CliError('--docker flag specified but no Dockerfile found in project directory')
            }
          }

          if (executionEngine === 'code_runtime') {
            const reqPath = path.join(cwd, 'requirements.txt')
            try {
              await fs.access(reqPath)
              includePatterns.push('requirements.txt')
              process.stdout.write(`  Including requirements.txt for sandbox dependencies\n`)
            } catch {
              // Optional
            }

            // Include package.json + lockfile for JS agents only (overrides DEFAULT_EXCLUDES)
            // Guard on JS entrypoint to avoid bundling package.json for Python agents
            // in mixed repos — the sandbox Python template lacks npm and would fail
            if (bundleEntrypoint && bundleEntrypoint.endsWith('.js')) {
              const pkgPath = path.join(cwd, 'package.json')
              try {
                await fs.access(pkgPath)
                includePatterns.push('package.json')
                process.stdout.write(`  Including package.json for sandbox dependencies\n`)
                // Include lockfile for deterministic installs (npm ci)
                const lockPath = path.join(cwd, 'package-lock.json')
                try {
                  await fs.access(lockPath)
                  includePatterns.push('package-lock.json')
                  process.stdout.write(`  Including package-lock.json for deterministic installs\n`)
                } catch {
                  // No lockfile — npm install will be used instead of npm ci
                }
              } catch {
                // No package.json
              }
            }
          }

          const bundleResult = await createCodeBundle(cwd, bundlePath, {
            entrypoint: bundleEntrypoint,
            exclude: manifest.bundle?.exclude,
            include: includePatterns.length > 0 ? includePatterns : undefined,
            skipEntrypointCheck: false,
          })

          process.stdout.write(`  Created bundle: ${bundleResult.fileCount} files, ${(bundleResult.sizeBytes / 1024).toFixed(1)}KB\n`)

          if (options.verbose && bundleResult.files?.length) {
            process.stdout.write(`  Bundled files:\n`)
            for (const f of bundleResult.files) {
              process.stdout.write(`    ${f}\n`)
            }
          }

          // Validate bundle size
          const validation = await validateBundle(bundlePath)
          if (!validation.valid) {
            throw new CliError(`Bundle validation failed: ${validation.error}`)
          }

          // Upload the bundle with entrypoint
          process.stdout.write(`  Uploading bundle...\n`)
          const uploadResult = await uploadCodeBundle(config, agentId, bundlePath, bundleEntrypoint, workspaceId)
          process.stdout.write(`  Uploaded: ${uploadResult.code_hash.substring(0, 12)}...\n`)

          // Show environment info if applicable
          if (uploadResult.environment_id) {
            if (uploadResult.environment_source === 'dockerfile_new') {
              process.stdout.write(`  ${chalk.cyan('Custom environment detected (Dockerfile)')}\n`)
              process.stdout.write(`  ${chalk.yellow('Environment building...')} Agent will be ready when build completes.\n`)
              process.stdout.write(`  ${chalk.gray(`Check status: orchagent env status ${uploadResult.environment_id}`)}\n`)
            } else if (uploadResult.environment_source === 'dockerfile_reused') {
              process.stdout.write(`  ${chalk.green('Custom environment (reusing existing build)')}\n`)
            } else if (uploadResult.environment_source === 'workspace_default') {
              process.stdout.write(`  ${chalk.cyan('Using workspace default environment')}\n`)
            }
          }

          // Store service update count for success message
          if (uploadResult.services_updated && uploadResult.services_updated > 0) {
            servicesUpdated = uploadResult.services_updated
          }
        } finally {
          // Clean up temp files
          await fs.rm(tempDir, { recursive: true, force: true })
        }
      }

      await track('cli_publish', {
        agent_type: canonicalType,
        execution_engine: executionEngine,
        run_mode: runMode,
        callable,
        hosted: shouldUploadBundle,
      })
      process.stdout.write(`\n${chalk.green('✔')} Published ${org.slug}/${manifest.name}@${assignedVersion} successfully!\n`)
      if (servicesUpdated > 0) {
        process.stdout.write(`${chalk.green('✔')} Updated ${servicesUpdated} running service(s) to ${assignedVersion} successfully!\n`)
      }
      process.stdout.write(`\n`)
      process.stdout.write(`Type: ${canonicalType}\n`)
      process.stdout.write(`Run mode: ${runMode}\n`)
      process.stdout.write(`Execution engine: ${executionEngine}${shouldUploadBundle ? ' (hosted)' : ''}\n`)
      process.stdout.write(`Callable: ${callable ? 'enabled' : 'disabled'}\n`)
      process.stdout.write(`Providers: ${supportedProviders.join(', ')}\n`)
      process.stdout.write(`Visibility: private\n`)

      // Show orchestration mode for dependency orchestrators
      const orchMode = (result as Record<string, unknown>).orchestration_mode as string | undefined
      if (orchMode) {
        const modeColor = orchMode === 'strict' ? chalk.yellow : chalk.green
        process.stdout.write(`Orchestration: ${modeColor(orchMode)}\n`)
      }

      // Show publish warnings from gateway
      const publishWarnings = (result as Record<string, unknown>).warnings as string[] | undefined
      if (publishWarnings?.length) {
        process.stdout.write(`\n`)
        for (const warning of publishWarnings) {
          process.stderr.write(chalk.yellow(`⚠ ${warning}\n`))
        }
      }

      // Warn if workspace has no LLM vault keys for this agent's providers (UX-13-01)
      await checkWorkspaceLlmKeys(
        config,
        workspaceId || org.id,
        org.slug,
        executionEngine,
        supportedProviders
      )

      // Post-publish: confirm secrets status (DX-13, DX-3)
      // Shows green check when all present, yellow warning when missing
      await checkRequiredSecrets(
        config,
        workspaceId || org.id,
        org.slug,
        manifest.required_secrets || []
      )

      // Show security review result if available
      const secReview = (result as Record<string, unknown>).security_review as
        { verdict?: string; summary?: string } | undefined
      if (secReview?.verdict) {
        if (secReview.verdict === 'approved') {
          process.stdout.write(`Security: ${chalk.green('passed')}\n`)
        } else if (secReview.verdict === 'flagged') {
          process.stdout.write(`Security: ${chalk.yellow('flagged')} — ${secReview.summary || 'review recommended'}\n`)
        } else if (secReview.verdict === 'error') {
          process.stdout.write(`Security: ${chalk.gray('review unavailable')} — publish succeeded, review will be retried\n`)
        } else if (secReview.verdict === 'skipped') {
          process.stdout.write(`Security: ${chalk.gray('review skipped')} — ${secReview.summary || 'content not eligible for review'}\n`)
        } else {
          process.stdout.write(`Security: ${chalk.gray(secReview.verdict)} — ${secReview.summary || ''}\n`)
        }
      }

      if (result.service_key) {
        process.stdout.write(`\nService key:\n`)
        process.stdout.write(`  ${result.service_key}\n`)
        try {
          const keyPrefix = result.service_key.substring(0, 12)
          const savedPath = await saveServiceKey(org.slug, manifest.name, assignedVersion, result.service_key, keyPrefix)
          process.stdout.write(`  ${chalk.gray(`Saved to ${savedPath}`)}\n`)
        } catch {
          process.stdout.write(`  ${chalk.yellow('Could not save key locally. Copy it now — it cannot be retrieved from the server.')}\n`)
        }
        process.stdout.write(`  Retrieve later: ${chalk.cyan(`orch agent-keys list ${org.slug}/${manifest.name}`)}\n`)
      }

      // Show next-step CLI command based on run mode
      const runRef = `${org.slug}/${manifest.name}`
      if (runMode === 'always_on') {
        process.stdout.write(`\nDeploy as service:\n`)
        process.stdout.write(`  orch service deploy ${runRef}\n`)
      } else {
        const schemaProps = inputSchema && typeof inputSchema === 'object' && 'properties' in inputSchema
          ? Object.keys((inputSchema as Record<string, unknown>).properties as Record<string, unknown>).slice(0, 3)
          : null
        const exampleFields = schemaProps?.length
          ? schemaProps.map(k => `"${k}": "..."`).join(', ')
          : '"input": "..."'
        process.stdout.write(`\nRun with CLI:\n`)
        process.stdout.write(`  orch run ${runRef} --data '{${exampleFields}}'\n`)
      }

      process.stdout.write(`\nAPI endpoint:\n`)
      process.stdout.write(`  POST ${config.apiUrl}/${org.slug}/${manifest.name}/${assignedVersion}/run\n`)

      if (shouldUploadBundle) {
        process.stdout.write(`\nNote: Hosted code execution is in beta. Contact support for full deployment.\n`)
      }

      process.stdout.write(`\nView analytics and usage: https://orchagent.io/dashboard\n`)
    })
}
