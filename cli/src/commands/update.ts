import { Command } from 'commander'
import fs from 'fs/promises'
import path from 'path'
import chalk from 'chalk'

import { getResolvedConfig } from '../lib/config'
import { publicRequest, ApiError } from '../lib/api'
import { track } from '../lib/analytics'
import { adapterRegistry, type CanonicalAgent } from '../adapters'
import {
  getInstalled,
  trackInstall,
  checkModified,
  computeHash,
  type InstalledAgent,
  type FileStatus
} from '../lib/installed'
import { mergeAgentsMdContent } from '../lib/agents-md-utils'
import type { Agent, ResolvedConfig } from '../types'

async function fetchLatestAgent(
  config: ResolvedConfig,
  agentRef: string
): Promise<{ agent: CanonicalAgent; latestVersion: string } | null> {
  const [org, name] = agentRef.split('/')
  if (!org || !name) return null

  try {
    // Try to get latest version
    const agent = await publicRequest<Agent>(
      config,
      `/public/agents/${org}/${name}/latest`
    )
    return {
      agent: { ...agent, org_slug: org },
      latestVersion: agent.version
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return null
    }
    throw err
  }
}

export function registerUpdateCommand(program: Command): void {
  program
    .command('update [agent]')
    .description('Update installed agents to latest versions')
    .option('--check', 'Check for updates without installing')
    .option('--force', 'Force update even if file was modified locally')
    .action(
      async (
        agentRef: string | undefined,
        options: {
          check?: boolean
          force?: boolean
        }
      ) => {
        const resolved = await getResolvedConfig()
        const installed = await getInstalled()

        if (installed.length === 0) {
          process.stdout.write('No agents installed. Use "orchagent install <agent>" to install agents.\n')
          return
        }

        // Filter to specific agent if provided
        const toCheck = agentRef
          ? installed.filter(i => i.agent === agentRef)
          : installed

        if (toCheck.length === 0) {
          process.stdout.write(`Agent "${agentRef}" is not installed.\n`)
          return
        }

        // Group installed entries by agent name to avoid duplicates
        // (same agent installed to multiple formats shows once)
        const grouped = new Map<string, InstalledAgent[]>()
        for (const item of toCheck) {
          const existing = grouped.get(item.agent)
          if (existing) {
            existing.push(item)
          } else {
            grouped.set(item.agent, [item])
          }
        }

        process.stdout.write(`Checking ${grouped.size} installed agent(s) for updates...\n\n`)

        let updatesAvailable = 0
        let updatesApplied = 0
        let skippedModified = 0
        let skippedMissing = 0

        for (const [agentName, entries] of grouped) {
          // Check file status for all entries in this group
          const fileStatuses: { item: InstalledAgent; status: FileStatus }[] = []
          for (const item of entries) {
            fileStatuses.push({ item, status: await checkModified(item) })
          }

          // Fetch latest version once per agent
          const latest = await fetchLatestAgent(resolved, agentName)
          if (!latest) {
            process.stdout.write(`  ${chalk.yellow('?')} ${agentName} - could not fetch latest\n`)
            continue
          }

          // Use the version from the first entry (all entries for the same
          // agent should share the same version after install/update)
          const installedVersion = entries[0].version
          const hasUpdate = latest.latestVersion !== installedVersion

          const anyMissing = fileStatuses.some(f => f.status.missing)
          const anyModified = fileStatuses.some(f => f.status.modified)

          if (!hasUpdate && !anyModified && !anyMissing) {
            const formatSuffix = entries.length > 1
              ? ` ${chalk.dim(`(${entries.map(e => e.format).join(', ')})`)}`
              : ''
            process.stdout.write(`  ${chalk.green('✓')} ${agentName}@${installedVersion} - up to date${formatSuffix}\n`)
            continue
          }

          // Handle missing files without --force
          if (anyMissing && !hasUpdate && !options.force) {
            const missingFormats = fileStatuses.filter(f => f.status.missing).map(f => f.item.format)
            process.stdout.write(`  ${chalk.yellow('!')} ${agentName} - file missing [${missingFormats.join(', ')}] (use --force to reinstall)\n`)
            skippedMissing++
            continue
          }

          // Handle modified files without --force
          if (anyModified && !hasUpdate && !options.force) {
            const modifiedFormats = fileStatuses.filter(f => f.status.modified).map(f => f.item.format)
            process.stdout.write(`  ${chalk.yellow('!')} ${agentName} - local modifications [${modifiedFormats.join(', ')}] (use --force to overwrite)\n`)
            skippedModified++
            continue
          }

          if (hasUpdate || anyMissing) {
            if (hasUpdate) {
              updatesAvailable++
            }
            process.stdout.write(`  ${chalk.blue('↑')} ${agentName}@${installedVersion} → ${latest.latestVersion}`)
            if (anyModified) {
              process.stdout.write(` ${chalk.yellow('(modified)')}`)
            }
            if (anyMissing) {
              process.stdout.write(` ${chalk.yellow('(reinstalling)')}`)
            }
            process.stdout.write('\n')

            if (options.check) {
              continue
            }

            // Apply update to each format entry
            for (const { item, status: fileStatus } of fileStatuses) {
              // Skip unmodified and non-missing entries if no version update
              if (!hasUpdate && !fileStatus.missing) continue

              // Skip modified entries without --force
              if (fileStatus.modified && !options.force) {
                process.stderr.write(`    Skipped ${item.format}: local modifications (use --force)\n`)
                continue
              }

              const adapter = adapterRegistry.get(item.format)
              if (!adapter) {
                process.stderr.write(`    Skipped ${item.format}: unknown format\n`)
                continue
              }

              const checkResult = adapter.canConvert(latest.agent)
              if (!checkResult.canConvert) {
                process.stderr.write(`    Skipped ${item.format}: ${checkResult.errors.join(', ')}\n`)
                continue
              }

              const files = adapter.convert(latest.agent)
              if (files.length > 1) {
                process.stderr.write(`    Skipped ${item.format}: multi-file adapters not supported for update. Reinstall instead.\n`)
                continue
              }
              for (const file of files) {
                // Use the original path from tracking
                const fullPath = item.path

                try {
                  const dir = path.dirname(fullPath)
                  await fs.mkdir(dir, { recursive: true })

                  // Special handling for AGENTS.md - append/replace instead of overwrite
                  if (file.filename === 'AGENTS.md') {
                    let existingContent = ''
                    try {
                      existingContent = await fs.readFile(fullPath, 'utf-8')
                    } catch {
                      // File doesn't exist, will create new
                    }
                    file.content = mergeAgentsMdContent(existingContent, file.content, item.agent)
                  }

                  await fs.writeFile(fullPath, file.content)

                  // Update tracking
                  const updatedItem: InstalledAgent = {
                    ...item,
                    version: latest.latestVersion,
                    installedAt: new Date().toISOString(),
                    adapterVersion: adapter.version,
                    contentHash: computeHash(file.content),
                  }
                  await trackInstall(updatedItem)

                  process.stdout.write(`    Updated: ${fullPath}\n`)
                  updatesApplied++
                } catch (err) {
                  process.stderr.write(`    Error (${item.format}): ${(err as Error).message}\n`)
                }
              }
            }
          }
        }

        process.stdout.write('\n')
        if (options.check) {
          process.stdout.write(`Found ${updatesAvailable} update(s) available.\n`)
          if (skippedModified > 0) {
            process.stdout.write(`${skippedModified} agent(s) have local modifications.\n`)
          }
          if (skippedMissing > 0) {
            process.stdout.write(`${skippedMissing} agent(s) have missing files.\n`)
          }
          process.stdout.write('Run "orchagent update" without --check to apply updates.\n')
        } else {
          process.stdout.write(`Applied ${updatesApplied} update(s).\n`)
          if (skippedModified > 0) {
            process.stdout.write(`Skipped ${skippedModified} modified agent(s). Use --force to overwrite.\n`)
          }
          if (skippedMissing > 0) {
            process.stdout.write(`Skipped ${skippedMissing} missing agent(s). Use --force to reinstall.\n`)
          }
        }

        await track('cli_agent_update', {
          checked: toCheck.length,
          updatesAvailable,
          updatesApplied,
          skippedModified,
          skippedMissing,
        })
      }
    )
}
