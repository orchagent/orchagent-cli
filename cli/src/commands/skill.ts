import { Command } from 'commander'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import chalk from 'chalk'

import { getResolvedConfig, getDefaultFormats, getDefaultScope, setDefaultFormats, FORMAT_SKILL_DIRS, VALID_FORMAT_IDS, loadConfig, type FormatId } from '../lib/config'
import { publicRequest, ApiError, getOrg, listMyAgents, reportInstall, getPublicAgent, request, resolveWorkspaceIdForOrg } from '../lib/api'
import { CliError, ExitCodes } from '../lib/errors'
import { track } from '../lib/analytics'
import { trackInstall, computeHash, untrackInstall, getInstalled, type InstalledAgent } from '../lib/installed'
import { latestOnly } from './agents'
import type { Agent, AgentTypeValue, PublicAgent, ResolvedConfig } from '../types'
import packageJson from '../../package.json'

const DEFAULT_VERSION = 'latest'

function stripFrontmatter(content: string): string {
  const match = content.match(/^---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)$/)
  return match ? match[1].trimStart() : content
}

type SkillRef = {
  org?: string
  skill: string
  version: string
}

type SkillDownload = {
  type: AgentTypeValue
  name: string
  version: string
  description?: string
  prompt?: string
}

/**
 * AI tool skill directories.
 *
 * Each AI coding tool has its own directory for skills. When installing a skill,
 * we write to all known directories so the skill works with any tool.
 *
 * TODO: Research and add more AI tool directories as the ecosystem evolves.
 * Known tools to research: Gemini CLI, Aider, OpenCode, Amp, Windsurf, Cline,
 * GitHub Copilot CLI, Qwen Code, Kimi Code, etc.
 *
 * References:
 * - https://github.com/gotalab/skillport
 * - https://github.com/numman-ali/openskills
 * - https://github.com/skillcreatorai/Ai-Agent-Skills
 */
const AI_TOOL_SKILL_DIRS = [
  { name: 'Claude Code', projectPath: '.claude/skills', userPath: '.claude/skills' },
  { name: 'Cursor', projectPath: '.cursor/skills', userPath: '.cursor/skills' },
  { name: 'Amp', projectPath: '.agents/skills', userPath: '.agents/skills' },
  { name: 'OpenCode', projectPath: '.opencode/skill', userPath: '.opencode/skill' },
  { name: 'Antigravity', projectPath: '.agent/skills', userPath: '.agent/skills' },
  // TODO: Add more as we research them:
  // { name: 'Windsurf', projectPath: '.windsurf/skills', userPath: '.windsurf/skills' },
]

function parseSkillRef(value: string): SkillRef {
  const [ref, versionPart] = value.split('@')
  const version = versionPart?.trim() || DEFAULT_VERSION
  const segments = ref.split('/')
  if (segments.length === 1) {
    return { skill: segments[0], version }
  }
  if (segments.length === 2) {
    return { org: segments[0], skill: segments[1], version }
  }
  throw new CliError('Invalid skill reference. Use org/skill or skill format.')
}

async function downloadSkillWithFallback(
  config: ResolvedConfig,
  org: string,
  skill: string,
  version: string,
  workspaceId?: string
): Promise<SkillDownload> {
  // Fetch metadata first to check if paid
  let skillMeta
  try {
    skillMeta = await getPublicAgent(config, org, skill, version)
  } catch (err) {
    // If 404, might be private skill - will handle below
    if (err instanceof ApiError && err.status === 404) {
      skillMeta = null
    } else {
      throw err
    }
  }

  // Verify it's a skill type before proceeding
  if (skillMeta) {
    const skillType = skillMeta.type as string | undefined
    if (skillType !== 'skill') {
      throw new CliError(
        `${org}/${skill} is not a skill (type: ${skillType || 'prompt'})`
      )
    }
  }

  // Check if download is disabled (server-only skill)
  if (skillMeta && skillMeta.allow_local_download === false) {
    if (config.apiKey) {
      const callerOrg = await getOrg(config, workspaceId)
      const isOwner = (skillMeta.org_id && callerOrg.id === skillMeta.org_id) ||
                      (skillMeta.org_slug && callerOrg.slug === skillMeta.org_slug)

      if (isOwner) {
        // Owner - fetch from authenticated endpoint
        const myAgents = await listMyAgents(config, workspaceId)
        const matching = myAgents.filter(a => a.name === skill && a.type === 'skill')

        if (matching.length > 0) {
          let targetAgent: Agent
          if (version === 'latest') {
            targetAgent = matching.sort((a, b) =>
              new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
            )[0]
          } else {
            const found = matching.find(a => a.version === version)
            if (!found) {
              throw new ApiError(`Skill '${org}/${skill}@${version}' not found`, 404)
            }
            targetAgent = found
          }

          const skillData = await request<Agent>(config, 'GET', `/agents/${targetAgent.id}`)
          return {
            type: skillData.type,
            name: skillData.name,
            version: skillData.version,
            description: skillData.description,
            prompt: skillData.prompt,
          }
        }
      }
    }
    throw new CliError(
      `This skill is server-only and cannot be downloaded.\n\n` +
      `Skills are loaded automatically during server execution via 'orchagent run'.`
    )
  }

  // Free skill or public metadata available - proceed with normal download
  if (skillMeta) {
    try {
      return await publicRequest<SkillDownload>(
        config,
        `/public/agents/${org}/${skill}/${version}/download`
      )
    } catch (err) {
      // If download fails but metadata exists, it might be a 403 for other reasons
      if (err instanceof ApiError && err.status === 403) {
        const payload = err.payload as any
        if (payload?.error?.code === 'DOWNLOAD_DISABLED') {
          throw new CliError(
            `This skill is server-only and cannot be downloaded.\n\n` +
            `Skills are loaded automatically during server execution via 'orchagent run'.`
          )
        }
      }
      throw err
    }
  }

  // Fallback to authenticated endpoint for private skills
  if (!config.apiKey) {
    throw new ApiError(`Skill '${org}/${skill}@${version}' not found`, 404)
  }

  const userOrg = await getOrg(config, workspaceId)
  if (userOrg.slug !== org) {
    throw new ApiError(`Skill '${org}/${skill}@${version}' not found`, 404)
  }

  // Find skill in user's list
  const agents = await listMyAgents(config, workspaceId)
  const matching = agents.filter(a => a.name === skill && a.type === 'skill')
  if (matching.length === 0) {
    throw new ApiError(`Skill '${org}/${skill}@${version}' not found`, 404)
  }

  let targetAgent: Agent
  if (version === 'latest') {
    // For 'latest', get most recently created
    targetAgent = matching.sort((a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )[0]
  } else {
    // For any explicit version (v1, v2, etc.), find exact match
    const found = matching.find(a => a.version === version)
    if (!found) {
      throw new ApiError(`Skill '${org}/${skill}@${version}' not found`, 404)
    }
    targetAgent = found
  }

  // Verify it's a skill type
  if (targetAgent.type !== 'skill') {
    throw new CliError(
      `${org}/${skill} is not a skill (type: ${targetAgent.type || 'prompt'})`
    )
  }

  // Convert Agent to SkillDownload format
  return {
    type: targetAgent.type,
    name: targetAgent.name,
    version: targetAgent.version,
    description: targetAgent.description,
    prompt: targetAgent.prompt,
  }
}

export function registerSkillCommand(program: Command): void {
  const skill = program.command('skill').description('Manage and install skills')
  skill.action(() => { skill.help() })

  // orch skill list
  skill
    .command('list')
    .description('List your published and installed skills')
    .option('--json', 'Output raw JSON')
    .action(async (options: { json?: boolean }) => {
      const config = await getResolvedConfig()
      const jsonMode = options.json === true

      // Fetch published skills (only if authenticated)
      let publishedSkills: Agent[] = []
      if (config.apiKey) {
        const configFile = await loadConfig()
        const orgSlug = configFile.workspace ?? config.defaultOrg
        const workspaceId = orgSlug ? await resolveWorkspaceIdForOrg(config, orgSlug) : undefined
        const allAgents = await listMyAgents(config, workspaceId)
        publishedSkills = allAgents.filter(a => a.type === 'skill')
      }

      // Fetch locally installed skills
      const installed = await getInstalled()

      // JSON output
      if (jsonMode) {
        const { agents: latestSkills } = latestOnly(publishedSkills)
        process.stdout.write(JSON.stringify({
          published: latestSkills,
          installed,
        }, null, 2) + '\n')
        return
      }

      // Empty state
      if (publishedSkills.length === 0 && installed.length === 0) {
        process.stdout.write(
          'No skills found.\n\n' +
          'Install a skill:\n' +
          '  orch skill install <org>/<skill-name>\n\n' +
          'Create a skill:\n' +
          '  orch skill create <name>\n'
        )
        return
      }

      // Published skills table
      if (publishedSkills.length > 0) {
        const { agents: latestSkills, versionCounts } = latestOnly(publishedSkills)
        const Table = (await import('cli-table3')).default
        const table = new Table({
          head: [
            chalk.bold('Skill'),
            chalk.bold('Version'),
            chalk.bold('Description'),
          ],
        })

        for (const skill of latestSkills) {
          const desc = skill.description
            ? skill.description.length > 60
              ? skill.description.slice(0, 57) + '...'
              : skill.description
            : '-'
          let version = skill.version
          const count = versionCounts.get(skill.name) ?? 1
          if (count > 1) {
            version = `${skill.version} (${count} total)`
          }
          table.push([skill.name, version, desc])
        }

        process.stdout.write(`Published Skills\n${table.toString()}\n`)
        process.stdout.write(`\n${latestSkills.length} skill${latestSkills.length === 1 ? '' : 's'}`)
        if (publishedSkills.length > latestSkills.length) {
          process.stdout.write(` (${publishedSkills.length} versions total)`)
        }
        process.stdout.write('\n')
      }

      // Installed skills table
      if (installed.length > 0) {
        const Table = (await import('cli-table3')).default
        const table = new Table({
          head: [
            chalk.bold('Skill'),
            chalk.bold('Version'),
            chalk.bold('Tool'),
            chalk.bold('Scope'),
          ],
        })

        for (const entry of installed) {
          table.push([entry.agent, entry.version, entry.format, entry.scope])
        }

        if (publishedSkills.length > 0) process.stdout.write('\n')
        process.stdout.write(`Installed Skills\n${table.toString()}\n`)
      }
    })

  // orch skill create [name]
  skill
    .command('create [name]')
    .description('Create a new skill from template')
    .action(async (name?: string) => {
      const cwd = process.cwd()
      const skillName = name || path.basename(cwd)
      const skillPath = path.join(cwd, 'SKILL.md')

      // Check if SKILL.md already exists
      try {
        await fs.access(skillPath)
        throw new CliError('SKILL.md already exists')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }

      const template = `---
name: ${skillName}
description: When to use this skill
license: MIT
---

# ${skillName}

Instructions and guidance for AI agents...
`
      await fs.writeFile(skillPath, template)
      await track('cli_skill_create', { name: skillName })

      process.stdout.write(`Created skill: ${skillPath}\n`)
      process.stdout.write(`\nNext steps:\n`)
      process.stdout.write(`  1. Edit SKILL.md with your skill content\n`)
      process.stdout.write(`  2. Run: orchagent publish\n`)
    })

  // orch skill install <skill>
  skill
    .command('install <skill>')
    .description('Install skill to local AI tool directories (Claude Code, Cursor, etc.)')
    .option('--global', 'Install to home directory (default: current directory)')
    .option('--scope <scope>', 'Install scope: user or project')
    .option('--dry-run', 'Show what would be installed without making changes')
    .option('--format <formats>', 'Comma-separated format IDs (e.g., claude-code,cursor)')
    .option('--all-formats', 'Install to all supported AI tool directories')
    .option('--json', 'Output result as JSON (for automation/tooling)')
    .action(
      async (
        skillRef: string,
        options: {
          global?: boolean
          scope?: 'user' | 'project'
          dryRun?: boolean
          format?: string
          allFormats?: boolean
          json?: boolean
        }
      ) => {
        const jsonMode = options.json === true
        const log = (msg: string) => { if (!jsonMode) process.stdout.write(msg) }
        const logErr = (msg: string) => { if (!jsonMode) process.stderr.write(msg) }

        // Result tracking for JSON output
        const result: {
          success: boolean
          skill: string
          version: string
          scope: string
          tools: string[]
          files: { path: string; tool: string }[]
          warnings: string[]
          errors: string[]
        } = {
          success: false,
          skill: '',
          version: '',
          scope: '',
          tools: [],
          files: [],
          warnings: [],
          errors: [],
        }
        const resolved = await getResolvedConfig()

        // Determine target formats
        let targetFormats: FormatId[] = []
        if (options.format) {
          targetFormats = options.format.split(',').map((f: string) => f.trim()) as FormatId[]
          // Validate format IDs
          const invalid = targetFormats.filter(f => !VALID_FORMAT_IDS.includes(f))
          if (invalid.length > 0) {
            const errMsg = `Invalid format ID(s): ${invalid.join(', ')}. Valid: ${VALID_FORMAT_IDS.join(', ')}`
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
            // Filter to formats that have skill directories
            targetFormats = defaults.filter(f => VALID_FORMAT_IDS.includes(f as FormatId)) as FormatId[]
            const skipped = defaults.filter(f => !VALID_FORMAT_IDS.includes(f as FormatId))
            if (skipped.length > 0) {
              const warn = `Skipping ${skipped.join(', ')} (no skill directory)`
              result.warnings.push(warn)
              logErr(`Note: ${warn}\n`)
            }
          }
        }

        // If --all-formats explicitly requested, use all formats
        if (options.allFormats) {
          targetFormats = VALID_FORMAT_IDS.slice() as FormatId[]
        }

        // If no formats configured, prompt user (TTY) or use default (non-TTY)
        if (targetFormats.length === 0) {
          if (process.stdout.isTTY && !jsonMode) {
            // Interactive prompt using readline
            const readline = await import('readline/promises')
            const rl = readline.createInterface({
              input: process.stdin,
              output: process.stdout,
            })

            log('Which AI tools do you use?\n')
            VALID_FORMAT_IDS.forEach((f, i) => {
              log(`  ${i + 1}. ${FORMAT_SKILL_DIRS[f].name}\n`)
            })
            log('\nEnter numbers separated by commas (e.g., 1,2) or "all": ')

            const answer = await rl.question('')
            rl.close()

            if (answer.toLowerCase() === 'all') {
              targetFormats = VALID_FORMAT_IDS.slice() as FormatId[]
            } else {
              const indices = answer.split(',').map(s => parseInt(s.trim(), 10) - 1)
              const validIndices = indices.filter(i => i >= 0 && i < VALID_FORMAT_IDS.length)
              if (validIndices.length === 0) {
                throw new CliError('No valid tools selected. Please run the command again.')
              }
              targetFormats = validIndices.map(i => VALID_FORMAT_IDS[i]) as FormatId[]
            }

            // Save as default for future
            await setDefaultFormats(targetFormats)
            log(`\nSaved as your default formats for future installs.\n\n`)
          } else {
            // Non-TTY fallback
            targetFormats = ['claude-code'] as FormatId[]
            log('Note: No default formats configured. Installing to Claude Code only.\n')
            log('Run "orchagent config set default-format <ids>" to configure defaults.\n\n')
          }
        }

        const parsed = parseSkillRef(skillRef)
        const configFile = await loadConfig()
        const org = parsed.org ?? configFile.workspace ?? resolved.defaultOrg
        if (!org) {
          const errMsg = 'Missing org. Use org/skill or set default org.'
          if (jsonMode) {
            result.errors.push(errMsg)
            process.stdout.write(JSON.stringify(result, null, 2) + '\n')
            process.exit(ExitCodes.INVALID_INPUT)
          }
          throw new CliError(errMsg)
        }

        result.skill = `${org}/${parsed.skill}`
        result.version = parsed.version

        // Resolve workspace context for the target org
        const workspaceId = await resolveWorkspaceIdForOrg(resolved, org)

        // Download skill (tries public first, falls back to authenticated for private)
        let skillData: SkillDownload
        try {
          skillData = await downloadSkillWithFallback(
            resolved,
            org,
            parsed.skill,
            parsed.version,
            workspaceId
          )
        } catch (err) {
          if (jsonMode) {
            result.errors.push(err instanceof Error ? err.message : String(err))
            process.stdout.write(JSON.stringify(result, null, 2) + '\n')
            process.exit(ExitCodes.NOT_FOUND)
          }
          throw err
        }

        if (!skillData.prompt) {
          const errMsg = 'Skill has no content. The skill exists but has an empty prompt.'
          if (jsonMode) {
            result.errors.push(errMsg)
            process.stdout.write(JSON.stringify(result, null, 2) + '\n')
            process.exit(ExitCodes.INVALID_INPUT)
          }
          throw new CliError(
            'Skill has no content.\n\n' +
            'The skill exists but has an empty prompt. This may be a publishing issue.\n' +
            'Try re-publishing the skill or contact the skill author.'
          )
        }

        // Determine scope (--global is legacy alias for --scope user; then config default; then 'project')
        const scope = options.global ? 'user' : (options.scope || await getDefaultScope() || 'project')
        result.scope = scope

        // Strip existing YAML frontmatter from the prompt to avoid duplication
        const cleanPrompt = stripFrontmatter(skillData.prompt)

        // Build skill content with header
        const skillContent = `# ${skillData.name}

${skillData.description || ''}

---

${cleanPrompt}
`

        // Dry run - show what would be installed
        if (options.dryRun) {
          log(`Would install ${org}/${parsed.skill}@${parsed.version}\n\n`)
          log(`Target directories (scope: ${scope}):\n`)
          for (const formatId of targetFormats) {
            const tool = FORMAT_SKILL_DIRS[formatId]
            const baseDir = scope === 'user' ? os.homedir() : process.cwd()
            const toolPath = scope === 'user' ? tool.userPath : tool.projectPath
            const skillDir = path.join(baseDir, toolPath)
            const skillFile = path.join(skillDir, `${parsed.skill}.md`)
            result.files.push({ path: skillFile, tool: tool.name })
            log(`  - ${tool.name}: ${skillFile}\n`)
          }
          log(`\nNo changes made (dry run)\n`)
          result.success = true
          if (jsonMode) {
            process.stdout.write(JSON.stringify(result, null, 2) + '\n')
          }
          return
        }

        // Install to target AI tool directories
        const installed: string[] = []
        for (const formatId of targetFormats) {
          const tool = FORMAT_SKILL_DIRS[formatId]
          const baseDir = scope === 'user' ? os.homedir() : process.cwd()
          const toolPath = scope === 'user' ? tool.userPath : tool.projectPath
          const skillDir = path.join(baseDir, toolPath)
          const skillFile = path.join(skillDir, `${parsed.skill}.md`)

          try {
            await fs.mkdir(skillDir, { recursive: true })
            await fs.writeFile(skillFile, skillContent)
            installed.push(tool.name)
            result.files.push({ path: skillFile, tool: tool.name })

            // Track the installation
            const installedEntry: InstalledAgent = {
              agent: `${org}/${parsed.skill}`,
              version: skillData.version,
              format: formatId,
              scope: scope as 'user' | 'project',
              path: skillFile,
              installedAt: new Date().toISOString(),
              adapterVersion: packageJson.version,
              contentHash: computeHash(skillContent),
            }
            await trackInstall(installedEntry)
          } catch (err) {
            // Skip if we can't write (e.g., permission issues)
            const warn = `Could not install to ${toolPath}: ${(err as Error).message}`
            result.warnings.push(warn)
            logErr(`Warning: ${warn}\n`)
          }
        }

        if (installed.length === 0) {
          const errMsg = 'Failed to install skill to any directory'
          if (jsonMode) {
            result.errors.push(errMsg)
            process.stdout.write(JSON.stringify(result, null, 2) + '\n')
            process.exit(ExitCodes.GENERAL_ERROR)
          }
          throw new CliError(errMsg)
        }

        result.tools = installed
        result.success = true

        await track('cli_skill_install', {
          skill: `${org}/${parsed.skill}`,
          scope,
        })

        // Report authenticated install to backend (fire-and-forget)
        // This tracks unique installers for manipulation-resistant metrics
        if (resolved.apiKey) {
          reportInstall(resolved, org, parsed.skill, parsed.version, packageJson.version).catch(() => {})
        }

        if (jsonMode) {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n')
        } else {
          log(`Installed ${org}/${parsed.skill}@${parsed.version}\n`)
          log(`\nAvailable for:\n`)
          for (const tool of installed) {
            log(`  - ${tool}\n`)
          }
          log(`\nLocations:\n`)
          for (const file of result.files) {
            log(`  - ${file.tool}: ${file.path}\n`)
          }
        }
      }
    )

  // orch skill uninstall <skill>
  skill
    .command('uninstall <skill>')
    .description('Uninstall skill from local AI tool directories')
    .option('--global', 'Uninstall from home directory (default: current directory)')
    .option('--scope <scope>', 'Uninstall scope: user or project')
    .option('--json', 'Output result as JSON')
    .action(async (skillRef: string, options: { global?: boolean; scope?: 'user' | 'project'; json?: boolean }) => {
      const jsonMode = options.json === true
      const log = (msg: string) => { if (!jsonMode) process.stdout.write(msg) }

      const result: {
        success: boolean
        skill: string
        scope: string
        removed: { path: string; tool: string }[]
        errors: string[]
      } = {
        success: false,
        skill: '',
        scope: '',
        removed: [],
        errors: [],
      }

      const resolved = await getResolvedConfig()
      const parsed = parseSkillRef(skillRef)
      const configFile = await loadConfig()
      const org = parsed.org ?? configFile.workspace ?? resolved.defaultOrg
      if (!org) {
        const errMsg = 'Missing org. Use org/skill or set default org.'
        if (jsonMode) {
          result.errors.push(errMsg)
          process.stdout.write(JSON.stringify(result, null, 2) + '\n')
          process.exit(ExitCodes.INVALID_INPUT)
        }
        throw new CliError(errMsg)
      }

      result.skill = `${org}/${parsed.skill}`

      // Determine scope (--global is legacy alias for --scope user; then config default; then 'project')
      const scope = options.global ? 'user' : (options.scope || await getDefaultScope() || 'project')
      result.scope = scope

      // Remove from all AI tool directories
      for (const formatId of VALID_FORMAT_IDS) {
        const tool = FORMAT_SKILL_DIRS[formatId]
        const baseDir = scope === 'user' ? os.homedir() : process.cwd()
        const toolPath = scope === 'user' ? tool.userPath : tool.projectPath
        const skillFile = path.join(baseDir, toolPath, `${parsed.skill}.md`)

        try {
          await fs.unlink(skillFile)
          result.removed.push({ path: skillFile, tool: tool.name })
          // Untrack from installed.json
          await untrackInstall(`${org}/${parsed.skill}`, formatId, skillFile)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            result.errors.push(`Failed to remove ${skillFile}: ${(err as Error).message}`)
          }
          // ENOENT is fine - file doesn't exist
        }
      }

      if (result.removed.length === 0) {
        const errMsg = `Skill '${org}/${parsed.skill}' not found in ${scope === 'user' ? 'home' : 'project'} directory`
        if (jsonMode) {
          result.errors.push(errMsg)
          process.stdout.write(JSON.stringify(result, null, 2) + '\n')
          process.exit(ExitCodes.NOT_FOUND)
        }
        throw new CliError(errMsg)
      }

      result.success = true

      await track('cli_skill_uninstall', {
        skill: `${org}/${parsed.skill}`,
        scope,
      })

      if (jsonMode) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n')
      } else {
        log(`Uninstalled ${org}/${parsed.skill}\n`)
        log(`\nRemoved from:\n`)
        for (const item of result.removed) {
          log(`  - ${item.tool}\n`)
        }
      }
    })
}
