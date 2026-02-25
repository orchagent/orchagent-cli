/**
 * `orch validate` — Validate agent or skill configuration without publishing.
 *
 * Runs all pre-publish checks locally: config files, schemas, prompt,
 * dependencies, code scanning. Optionally runs server-side validation
 * with --server flag.
 *
 * Exit codes: 0 = valid, 1 = errors found
 */

import { Command } from 'commander'
import chalk from 'chalk'

import { getResolvedConfig, loadConfig } from '../lib/config'
import { getOrg, validateAgentPublish, request } from '../lib/api'
import { validateAgentProject, type ValidationResult, type ValidationIssue } from '../lib/validate'
import { checkDependencies } from './publish'
import { CliError, ExitCodes } from '../lib/errors'
import { track } from '../lib/analytics'

function issueIcon(level: ValidationIssue['level']): string {
  switch (level) {
    case 'error': return chalk.red('✗')
    case 'warning': return chalk.yellow('⚠')
    case 'info': return chalk.blue('ℹ')
  }
}

function formatIssue(issue: ValidationIssue): string {
  const icon = issueIcon(issue.level)
  const file = issue.file ? chalk.dim(` (${issue.file})`) : ''
  return `  ${icon} ${issue.message}${file}`
}

function printResult(result: ValidationResult, serverIssues?: ValidationIssue[]): void {
  const allIssues = [...result.issues, ...(serverIssues || [])]
  const errors = allIssues.filter(i => i.level === 'error')
  const warnings = allIssues.filter(i => i.level === 'warning')
  const infos = allIssues.filter(i => i.level === 'info')
  const m = result.metadata

  // Header
  const label = m.isSkill ? 'skill' : 'agent'
  const name = m.agentName || '(unknown)'
  process.stderr.write(`\n${chalk.dim('[validation only]')} Validating ${label}: ${chalk.bold(name)}\n\n`)

  // Summary line: type, engine, mode
  if (!m.isSkill && m.agentType && m.executionEngine) {
    process.stderr.write(chalk.dim(`  Type: ${m.agentType} (${m.executionEngine}), Run mode: ${m.runMode || 'on_demand'}\n\n`))
  }

  // All issues sorted: errors first, then warnings, then info
  for (const issue of errors) process.stderr.write(formatIssue(issue) + '\n')
  for (const issue of warnings) process.stderr.write(formatIssue(issue) + '\n')
  for (const issue of infos) process.stderr.write(formatIssue(issue) + '\n')

  // Metadata summary (only if no critical errors)
  if (errors.length === 0 && !m.isSkill) {
    if (m.hasPrompt) process.stderr.write(`  ${chalk.green('✓')} prompt.md found\n`)
    if (m.hasSchema) process.stderr.write(`  ${chalk.green('✓')} schema.json found\n`)
    if (m.executionEngine === 'managed_loop') {
      process.stderr.write(`  ${chalk.green('✓')} Custom tools: ${m.customToolCount}, Max turns: ${m.maxTurns || 25}\n`)
    }
    if (m.bundleEntrypoint) {
      process.stderr.write(`  ${chalk.green('✓')} Entrypoint: ${m.bundleEntrypoint}\n`)
    }
    if (m.bundleSizeBytes !== undefined && m.bundleFileCount !== undefined) {
      process.stderr.write(`  ${chalk.green('✓')} Bundle: ${m.bundleFileCount} files, ${(m.bundleSizeBytes / 1024).toFixed(1)} KB\n`)
    }
    if (m.sdkCompatible) {
      process.stderr.write(`  ${chalk.green('✓')} SDK detected (Local Ready)\n`)
    }
  }

  // Final verdict
  process.stderr.write('\n')
  const parts: string[] = []
  if (warnings.length > 0) parts.push(`${warnings.length} warning${warnings.length > 1 ? 's' : ''}`)
  if (infos.length > 0) parts.push(`${infos.length} note${infos.length > 1 ? 's' : ''}`)
  const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : ''

  if (errors.length > 0) {
    process.stderr.write(chalk.red.bold(`✗ Validation failed: ${errors.length} error${errors.length > 1 ? 's' : ''}${suffix}\n`))
  } else {
    process.stderr.write(chalk.green.bold(`✓ Validation passed${suffix}\n`))
  }
}

function toJsonOutput(result: ValidationResult, serverIssues?: ValidationIssue[]): object {
  const allIssues = [...result.issues, ...(serverIssues || [])]
  return {
    valid: result.valid && allIssues.filter(i => i.level === 'error').length === 0,
    errors: allIssues.filter(i => i.level === 'error').map(i => ({ message: i.message, file: i.file })),
    warnings: allIssues.filter(i => i.level === 'warning').map(i => ({ message: i.message, file: i.file })),
    info: allIssues.filter(i => i.level === 'info').map(i => ({ message: i.message, file: i.file })),
    metadata: {
      name: result.metadata.agentName,
      type: result.metadata.agentType,
      execution_engine: result.metadata.executionEngine,
      run_mode: result.metadata.runMode,
      is_skill: result.metadata.isSkill,
      has_prompt: result.metadata.hasPrompt,
      has_schema: result.metadata.hasSchema,
      sdk_compatible: result.metadata.sdkCompatible,
      entrypoint: result.metadata.bundleEntrypoint,
      custom_tools: result.metadata.customToolCount,
      max_turns: result.metadata.maxTurns,
      bundle_size_bytes: result.metadata.bundleSizeBytes,
      bundle_file_count: result.metadata.bundleFileCount,
    },
  }
}

export function registerValidateCommand(program: Command): void {
  program
    .command('validate')
    .alias('lint')
    .description('Validate configuration only (no tests)')
    .addHelpText('after', `
Use 'orch validate' to check configuration before publishing.
Use 'orch test' to validate + run test suite (fixtures, unit tests, etc).

Options:
  --json              Output as JSON (for CI/CD pipelines)
  --server            Also validate against server (requires auth)
  --profile <name>    Use API key from named profile
  --url <url>         Agent URL (for code-based agents)
  --docker            Validate with Dockerfile
`)
    .option('--profile <name>', 'Use API key from named profile')
    .option('--json', 'Output as JSON (for CI/CD)')
    .option('--server', 'Also run server-side validation (requires auth)')
    .option('--url <url>', 'Agent URL (for code-based agents without local code)')
    .option('--docker', 'Validate with Dockerfile inclusion')
    .action(async (options: {
      profile?: string
      json?: boolean
      server?: boolean
      url?: string
      docker?: boolean
    }) => {
      const cwd = process.cwd()

      // Run local validation
      const result = await validateAgentProject(cwd, {
        url: options.url,
        docker: options.docker,
      })

      // Online checks (dependencies + server-side validation)
      const serverIssues: ValidationIssue[] = []

      if (options.server || result.metadata.manifest?.manifest?.dependencies?.length) {
        try {
          const config = await getResolvedConfig({}, options.profile)
          if (!config.apiKey) {
            if (options.server) {
              serverIssues.push({
                level: 'warning',
                message: 'Server validation skipped: not logged in. Run `orch login` first.',
              })
            }
          } else {
            // Resolve workspace
            const configFile = await loadConfig()
            let workspaceId: string | undefined
            if (configFile.workspace && !options.profile) {
              try {
                const { workspaces } = await request<{ workspaces: Array<{ id: string; slug: string }> }>(
                  config, 'GET', '/workspaces'
                )
                const ws = workspaces.find(w => w.slug === configFile.workspace)
                if (ws) workspaceId = ws.id
              } catch { /* skip workspace resolution */ }
            }

            // Dependency checks
            const deps = result.metadata.manifest?.manifest?.dependencies
            if (deps?.length) {
              try {
                const org = await getOrg(config, workspaceId)
                const depResults = await checkDependencies(config, deps, org.slug, workspaceId)
                const notFound = depResults.filter(r => r.status === 'not_found')
                const notCallable = depResults.filter(r => r.status === 'found_not_callable')

                if (notFound.length > 0) {
                  for (const dep of notFound) {
                    serverIssues.push({
                      level: 'warning',
                      message: `Unpublished dependency: ${dep.ref}`,
                    })
                  }
                }
                if (notCallable.length > 0) {
                  for (const dep of notCallable) {
                    serverIssues.push({
                      level: 'warning',
                      message: `Dependency has callable: false: ${dep.ref}`,
                    })
                  }
                }
              } catch {
                serverIssues.push({
                  level: 'warning',
                  message: 'Could not check dependencies (network error)',
                })
              }
            }

            // Server-side validation
            if (options.server && result.valid && result.metadata.agentName) {
              try {
                const m = result.metadata
                const manifest = m.manifest
                const validation = await validateAgentPublish(config, {
                  name: m.agentName!,
                  type: m.agentType || 'agent',
                  run_mode: m.runMode,
                  callable: m.callable,
                  description: manifest?.description,
                  is_public: false,
                  supported_providers: m.supportedProviders,
                  default_models: manifest?.default_models,
                  timeout_seconds: manifest?.timeout_seconds,
                  manifest: manifest?.manifest,
                  required_secrets: m.requiredSecrets,
                  default_skills: manifest?.default_skills,
                  skills_locked: manifest?.skills_locked,
                  environment: manifest?.environment,
                }, workspaceId)

                if (validation.warnings?.length) {
                  for (const w of validation.warnings) {
                    serverIssues.push({ level: 'warning', message: `Server: ${w}` })
                  }
                }
                if (!validation.valid) {
                  for (const e of validation.errors) {
                    serverIssues.push({ level: 'error', message: `Server: ${e}` })
                  }
                } else {
                  serverIssues.push({ level: 'info', message: 'Server-side validation passed' })
                }
              } catch {
                serverIssues.push({
                  level: 'warning',
                  message: 'Could not reach server for validation (offline?)',
                })
              }
            }
          }
        } catch {
          if (options.server) {
            serverIssues.push({
              level: 'warning',
              message: 'Server validation skipped: authentication error',
            })
          }
        }
      }

      const allValid = result.valid && serverIssues.filter(i => i.level === 'error').length === 0

      await track('cli_validate', {
        valid: allValid,
        errors: [...result.issues, ...serverIssues].filter(i => i.level === 'error').length,
        warnings: [...result.issues, ...serverIssues].filter(i => i.level === 'warning').length,
        type: result.metadata.agentType,
        engine: result.metadata.executionEngine,
        server: options.server || false,
        json: options.json || false,
      })

      if (options.json) {
        process.stdout.write(JSON.stringify(toJsonOutput(result, serverIssues), null, 2) + '\n')
      } else {
        printResult(result, serverIssues)
      }

      if (!allValid) {
        const err = new CliError('Validation failed', ExitCodes.INVALID_INPUT)
        err.displayed = true
        throw err
      }
    })
}
