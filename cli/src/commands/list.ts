import { Command } from 'commander'

import { verifyInstalled } from '../lib/installed'
import { printJson } from '../lib/output'

export function registerListCommand(program: Command): void {
  program
    .command('list')
    .alias('ls')
    .description('List installed agents and skills')
    .option('--json', 'Output as JSON')
    .option('-v, --verbose', 'Show format details for each installation')
    .option('--verify', 'Check tracked files exist and remove orphaned entries')
    .action(async (options: { json?: boolean; verbose?: boolean; verify?: boolean }) => {
      if (options.verify) {
        const { valid, orphaned } = await verifyInstalled(true)  // Remove orphaned entries

        if (orphaned.length === 0) {
          process.stdout.write('All tracked installations verified. No orphaned entries found.\n')
        } else {
          process.stdout.write(`Removed ${orphaned.length} orphaned entries:\n`)
          for (const entry of orphaned) {
            process.stdout.write(`  - ${entry.agent}@${entry.version} (${entry.format})\n`)
            process.stdout.write(`    Missing: ${entry.path}\n`)
          }
        }

        if (valid.length > 0) {
          process.stdout.write(`\n${valid.length} valid installations remain.\n`)
        }
        return
      }

      // Verify file existence without removing orphaned entries
      const { valid: installed, orphaned } = await verifyInstalled(false)

      if (options.json) {
        printJson(installed)
        return
      }

      if (installed.length === 0) {
        process.stdout.write('No agents installed.\n')
        process.stdout.write('Install agents with: orch install <agent>\n')
        return
      }

      if (options.verbose) {
        // Verbose mode: show all entries with format details
        process.stdout.write('Installed agents:\n\n')
        for (const agent of installed) {
          process.stdout.write(`  ${agent.agent}@${agent.version} (${agent.format}, ${agent.scope})\n`)
          process.stdout.write(`    Path: ${agent.path}\n`)
        }
      } else {
        // Default: deduplicate by agent@version
        const seen = new Map<string, typeof installed[0]>()
        for (const agent of installed) {
          const key = `${agent.agent}@${agent.version}`
          if (!seen.has(key)) {
            seen.set(key, agent)
          }
        }

        process.stdout.write('Installed agents:\n\n')
        for (const [, agent] of seen) {
          process.stdout.write(`  ${agent.agent}@${agent.version}\n`)
        }

        // Hint about verbose mode if there are duplicates
        if (installed.length > seen.size) {
          process.stdout.write(`\n(${installed.length - seen.size} format duplicates hidden, use --verbose to show)\n`)
        }
      }

      // Warn about orphaned entries if any exist
      if (orphaned.length > 0) {
        process.stdout.write(`\nWarning: ${orphaned.length} tracked installation(s) have missing files. Run 'orchagent list --verify' to clean up.\n`)
      }
    })
}
