import { Command } from 'commander'

import {
  runAllChecks,
  calculateSummary,
  printHumanOutput,
  formatJsonOutput,
} from '../lib/doctor'
import { printJson } from '../lib/output'

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Diagnose setup issues with orchagent CLI')
    .option('-v, --verbose', 'Show detailed output for each check')
    .option('--json', 'Output results as JSON')
    .action(async (options: { verbose?: boolean; json?: boolean }) => {
      const results = await runAllChecks()
      const summary = calculateSummary(results)

      if (options.json) {
        printJson(formatJsonOutput(results, summary))
      } else {
        printHumanOutput(results, summary, options.verbose ?? false)
      }

      // Exit with code 1 only if there are errors (not warnings)
      if (summary.errors > 0) {
        process.exit(1)
      }
    })
}
