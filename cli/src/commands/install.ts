import { Command } from 'commander'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

import { getResolvedConfig, getDefaultFormats, getDefaultScope } from '../lib/config'
import { publicRequest, ApiError, getOrg, listMyAgents, getPublicAgent, request } from '../lib/api'
import { CliError, ExitCodes } from '../lib/errors'
import { resolveAgentContext } from '../lib/resolve-agent'
import { track } from '../lib/analytics'
import { adapterRegistry, type CanonicalAgent } from '../adapters'
import { resolveSkills } from '../lib/skill-resolve'
import { trackInstall, computeHash, type InstalledAgent } from '../lib/installed'
import { mergeAgentsMdContent } from '../lib/agents-md-utils'
import type { Agent, ResolvedConfig } from '../types'

async function downloadAgentWithFallback(
  config: ResolvedConfig,
  org: string,
  name: string,
  version: string,
  workspaceId?: string
): Promise<CanonicalAgent> {
  // Fetch public metadata first to check if paid
  let publicMeta
  try {
    publicMeta = await getPublicAgent(config, org, name, version)
  } catch (err) {
    // If 404, might be private agent - will handle below
    if (err instanceof ApiError && err.status === 404) {
      publicMeta = null
    } else {
      throw err
    }
  }

  // Check if download is disabled (server-only agent)
  if (publicMeta && publicMeta.allow_local_download === false) {
    // Check if owner (can bypass)
    if (config.apiKey) {
      const callerOrg = await getOrg(config, workspaceId)
      const isOwner = (publicMeta.org_id && callerOrg.id === publicMeta.org_id) ||
                      (publicMeta.org_slug && callerOrg.slug === publicMeta.org_slug)

      if (isOwner) {
        // Owner - fetch from authenticated endpoint
        const myAgents = await listMyAgents(config, workspaceId)
        const matching = myAgents.filter(a => a.name === name)
        if (matching.length > 0) {
          let targetAgent: Agent
          if (version === 'latest') {
            targetAgent = matching.sort((a, b) =>
              new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
            )[0]
          } else {
            const found = matching.find(a => a.version === version)
            if (!found) {
              throw new ApiError(`Agent '${org}/${name}@${version}' not found`, 404)
            }
            targetAgent = found
          }
          const agentData = await request<Agent>(config, 'GET', `/agents/${targetAgent.id}`)
          return { ...agentData, org_slug: org }
        }
      }
    }
    const typeLabel = publicMeta.type || 'agent'
    throw new CliError(
      `This ${typeLabel} is server-only and cannot be downloaded.\n\n` +
      `Use: orch run ${org}/${name}@${version} --data '{...}'`
    )
  }

  // Free agent - proceed normally with public data
  if (publicMeta) {
    // Cast PublicAgent to Agent for use as CanonicalAgent
    // publicRequest already returns full agent data for free agents
    const agent = await publicRequest<Agent>(
      config,
      `/public/agents/${org}/${name}/${version}`
    )
    return { ...agent, org_slug: org }
  }

  // No public metadata found - fallback to authenticated endpoint for private agents
  if (!config.apiKey) {
    throw new ApiError(`Agent '${org}/${name}@${version}' not found`, 404)
  }

  const userOrg = await getOrg(config, workspaceId)
  if (userOrg.slug !== org) {
    throw new ApiError(`Agent '${org}/${name}@${version}' not found`, 404)
  }

  const agents = await listMyAgents(config, workspaceId)
  const matching = agents.filter(a => a.name === name)
  if (matching.length === 0) {
    throw new ApiError(`Agent '${org}/${name}@${version}' not found`, 404)
  }

  let targetAgent: Agent
  if (version === 'latest') {
    targetAgent = matching.sort((a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )[0]
  } else {
    const found = matching.find(a => a.version === version)
    if (!found) {
      throw new ApiError(`Agent '${org}/${name}@${version}' not found`, 404)
    }
    targetAgent = found
  }

  return { ...targetAgent, org_slug: org }
}

export function registerInstallCommand(program: Command): void {
  program
    .command('install <agent>')
    .description('Install agent as sub-agent (Claude Code, Cursor, etc.)')
    .option('--format <formats>', 'Comma-separated format IDs (e.g., claude-code,cursor)')
    .option('--scope <scope>', 'Install scope: user (home dir) or project (current dir)')
    .option('--global', 'Install to home directory (alias for --scope user)')
    .option('--dry-run', 'Show what would be installed without making changes')
    .option('--json', 'Output result as JSON (for automation/tooling)')
    .action(
      async (
        agentArg: string,
        options: {
          format?: string
          scope?: string
          global?: boolean
          dryRun?: boolean
          json?: boolean
        }
      ) => {
        const jsonMode = options.json === true
        const log = (msg: string) => { if (!jsonMode) process.stdout.write(msg) }
        const logErr = (msg: string) => { if (!jsonMode) process.stderr.write(msg) }

        // Result tracking for JSON output
        const result: {
          success: boolean
          agent: string
          version: string
          scope: string
          formats: string[]
          files: { path: string; format: string }[]
          warnings: string[]
          errors: string[]
        } = {
          success: false,
          agent: '',
          version: '',
          scope: '',
          formats: [],
          files: [],
          warnings: [],
          errors: [],
        }

        const resolved = await getResolvedConfig()
        let agentCtx
        try {
          agentCtx = await resolveAgentContext(agentArg, resolved)
        } catch (err) {
          if (jsonMode && err instanceof CliError) {
            result.errors.push(err.message)
            process.stdout.write(JSON.stringify(result, null, 2) + '\n')
            process.exit(ExitCodes.INVALID_INPUT)
          }
          throw err
        }
        const { org, agent: agentName, version, workspaceId } = agentCtx

        result.agent = `${org}/${agentName}`
        result.version = version

        // Determine target formats
        let targetFormats: string[] = []
        if (options.format) {
          targetFormats = options.format.split(',').map(f => f.trim())
          const invalid = targetFormats.filter(f => !adapterRegistry.has(f))
          if (invalid.length > 0) {
            const errMsg = `Unknown format(s): ${invalid.join(', ')}. Available: ${adapterRegistry.getIds().join(', ')}`
            if (jsonMode) {
              result.errors.push(errMsg)
              process.stdout.write(JSON.stringify(result, null, 2) + '\n')
              process.exit(ExitCodes.INVALID_INPUT)
            }
            throw new CliError(errMsg)
          }
        } else {
          const defaults = await getDefaultFormats(resolved)
          if (defaults.length > 0) {
            targetFormats = defaults
          } else {
            // No default configured - use claude-code as sensible default
            targetFormats = ['claude-code']
          }
        }

        result.formats = targetFormats

        // Resolve scope: --global > --scope > config default > fallback to 'user'
        let scope = (options.global ? 'user' : (options.scope ?? await getDefaultScope() ?? 'user')) as 'user' | 'project'
        if (scope !== 'user' && scope !== 'project') {
          const errMsg = 'Scope must be "user" or "project"'
          if (jsonMode) {
            result.errors.push(errMsg)
            process.stdout.write(JSON.stringify(result, null, 2) + '\n')
            process.exit(ExitCodes.INVALID_INPUT)
          }
          throw new CliError(errMsg)
        }
        result.scope = scope

        // Download agent
        log(`Fetching ${org}/${agentName}@${version}...\n`)
        let agent: CanonicalAgent
        try {
          agent = await downloadAgentWithFallback(resolved, org, agentName, version, workspaceId)
        } catch (err) {
          if (jsonMode) {
            result.errors.push(err instanceof Error ? err.message : String(err))
            process.stdout.write(JSON.stringify(result, null, 2) + '\n')
            process.exit(ExitCodes.NOT_FOUND)
          }
          throw err
        }

        // Resolve default skills if present
        if (agent.default_skills && agent.default_skills.length > 0) {
          log(`Resolving ${agent.default_skills.length} bundled skill(s)...\n`)
          const skills = await resolveSkills(
            resolved,
            agent.default_skills,
            (warning) => {
              result.warnings.push(warning)
              logErr(`Warning: ${warning}\n`)
            }
          )
          if (skills.length > 0) {
            agent.resolvedSkills = skills
            log(`Bundled ${skills.length} skill(s): ${skills.map(s => s.name).join(', ')}\n`)
          }
        }

        // Install for each format
        let filesWritten = 0
        for (const formatId of targetFormats) {
          const adapter = adapterRegistry.get(formatId)
          if (!adapter) {
            const warn = `Unknown format '${formatId}', skipping`
            result.warnings.push(warn)
            logErr(`Warning: ${warn}\n`)
            continue
          }

          // Check if can convert
          const checkResult = adapter.canConvert(agent)
          if (!checkResult.canConvert) {
            logErr(`Cannot convert to ${adapter.name}:\n`)
            for (const err of checkResult.errors) {
              result.errors.push(`${adapter.name}: ${err}`)
              logErr(`  - ${err}\n`)
            }
            continue
          }

          // Show warnings
          for (const warn of checkResult.warnings) {
            result.warnings.push(`${formatId}: ${warn}`)
            log(`Warning (${formatId}): ${warn}\n`)
          }

          // Determine scope for this adapter (use local variable to not affect other formats)
          let effectiveScope: 'user' | 'project' = scope
          const supportedScopes = adapter.installPaths.map(p => p.scope)
          if (!supportedScopes.includes(effectiveScope)) {
            const warn = `${adapter.name} doesn't support '${scope}' scope. Using '${supportedScopes[0]}' instead.`
            result.warnings.push(warn)
            logErr(`Warning: ${warn}\n`)
            effectiveScope = supportedScopes[0] as 'user' | 'project'
          }

          // Convert
          const files = adapter.convert(agent)

          // Determine base directory
          const baseDir = effectiveScope === 'user' ? os.homedir() : process.cwd()

          // Install each file
          for (const file of files) {
            const fullDir = path.join(baseDir, file.installPath)
            const fullPath = path.join(fullDir, file.filename)

            if (options.dryRun) {
              log(`Would install: ${fullPath}\n`)
              log(`Content preview:\n${file.content.slice(0, 500)}...\n\n`)
              result.files.push({ path: fullPath, format: formatId })
              continue
            }

            // Create directory and write file
            await fs.mkdir(fullDir, { recursive: true })

            // Special handling for AGENTS.md - append/replace instead of overwrite
            if (file.filename === 'AGENTS.md') {
              let existingContent = ''
              try {
                existingContent = await fs.readFile(fullPath, 'utf-8')
              } catch {
                // File doesn't exist, will create new
              }
              const agentRef = `${org}/${agentName}`
              file.content = mergeAgentsMdContent(existingContent, file.content, agentRef)
            }

            await fs.writeFile(fullPath, file.content)
            filesWritten++

            // Track installation
            const installedAgent: InstalledAgent = {
              agent: `${org}/${agentName}`,
              version: version,
              format: formatId,
              scope: effectiveScope,
              path: fullPath,
              installedAt: new Date().toISOString(),
              adapterVersion: adapter.version,
              contentHash: computeHash(file.content),
            }
            await trackInstall(installedAgent)

            result.files.push({ path: fullPath, format: formatId })
            log(`Installed: ${fullPath}\n`)
          }
        }

        if (!options.dryRun) {
          if (filesWritten > 0) {
            await track('cli_agent_install', {
              agent: `${org}/${agentName}`,
              formats: targetFormats,
              scope,
            })

            result.success = true
            log(`\nAgent installed successfully!\n`)
            if (scope === 'user') {
              log(`Available in all your projects.\n`)
            } else {
              log(`Available in this project only.\n`)
            }
          } else {
            result.errors.push('No files were installed. Check warnings.')
            logErr(`\nNo files were installed. Check warnings above.\n`)
          }
        } else {
          // Dry run is considered success if we got file list
          result.success = result.files.length > 0
        }

        // Output JSON result
        if (jsonMode) {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n')
          if (!result.success) {
            process.exit(ExitCodes.GENERAL_ERROR)
          }
        } else if (!result.success && !options.dryRun) {
          process.exit(ExitCodes.GENERAL_ERROR)
        }
      }
    )
}
