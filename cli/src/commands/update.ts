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
          process.stdout.write('No agents installed. Use "orch install <agent>" to install agents.\n')
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

        process.stdout.write(`Checking ${toCheck.length} installed agent(s) for updates...\n\n`)

        let updatesAvailable = 0
        let updatesApplied = 0
        let skippedModified = 0
        let skippedMissing = 0

        for (const item of toCheck) {
          // Check if file was modified locally or is missing
          const fileStatus: FileStatus = await checkModified(item)

          // Fetch latest version
          const latest = await fetchLatestAgent(resolved, item.agent)
          if (!latest) {
            process.stdout.write(`  ${chalk.yellow('?')} ${item.agent} - could not fetch latest\n`)
            continue
          }

          const hasUpdate = latest.latestVersion !== item.version

          if (!hasUpdate && !fileStatus.modified && !fileStatus.missing) {
            process.stdout.write(`  ${chalk.green('✓')} ${item.agent}@${item.version} - up to date\n`)
            continue
          }

          // Handle missing file without --force
          if (fileStatus.missing && !options.force) {
            process.stdout.write(`  ${chalk.yellow('!')} ${item.agent} - file missing (use --force to reinstall)\n`)
            skippedMissing++
            continue
          }

          // Handle modified file without --force
          if (fileStatus.modified && !options.force) {
            process.stdout.write(`  ${chalk.yellow('!')} ${item.agent} - local modifications (use --force to overwrite)\n`)
            skippedModified++
            continue
          }

          if (hasUpdate || fileStatus.missing) {
            if (hasUpdate) {
              updatesAvailable++
            }
            process.stdout.write(`  ${chalk.blue('↑')} ${item.agent}@${item.version} → ${latest.latestVersion}`)
            if (fileStatus.modified) {
              process.stdout.write(` ${chalk.yellow('(modified)')}`)
            }
            if (fileStatus.missing) {
              process.stdout.write(` ${chalk.yellow('(reinstalling)')}`)
            }
            process.stdout.write('\n')

            if (options.check) {
              continue
            }

            // Apply update
            const adapter = adapterRegistry.get(item.format)
            if (!adapter) {
              process.stderr.write(`    Skipped: Unknown format "${item.format}"\n`)
              continue
            }

            const checkResult = adapter.canConvert(latest.agent)
            if (!checkResult.canConvert) {
              process.stderr.write(`    Skipped: ${checkResult.errors.join(', ')}\n`)
              continue
            }

            const files = adapter.convert(latest.agent)
            if (files.length > 1) {
              process.stderr.write(`    Skipped: Multi-file adapters not supported for update. Reinstall instead.\n`)
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
                process.stderr.write(`    Error: ${(err as Error).message}\n`)
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
          process.stdout.write('Run "orch update" without --check to apply updates.\n')
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
