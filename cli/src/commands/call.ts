import { Command } from 'commander'

/**
 * Deprecated: The 'call' command has been merged into 'run'.
 * Cloud execution is now the default behavior of 'orch run'.
 * This file provides a thin alias that prints a deprecation notice and exits.
 */
export function registerCallCommand(program: Command): void {
  program
    .command('call')
    .description('Deprecated: use "orch run" instead')
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      process.stderr.write(
        `The 'call' command has been merged into 'run'.\n\n` +
        `Cloud execution is now the default behavior of 'orch run':\n` +
        `  orch run <agent> --data '{...}'      # runs on server (cloud)\n` +
        `  orch run <agent> --local --data '...' # runs locally\n\n` +
        `Replace 'orch call' with 'orch run' in your commands.\n`
      )
      process.exit(1)
    })
}
