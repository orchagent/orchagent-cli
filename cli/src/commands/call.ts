import { Command } from 'commander'

/**
 * Deprecated: The 'call' command has been merged into 'run'.
 * Cloud execution is now the default behavior of 'orchagent run'.
 * This file provides a thin alias that prints a deprecation notice and exits.
 */
export function registerCallCommand(program: Command): void {
  program
    .command('call')
    .description('Deprecated: use "orchagent run" instead')
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      process.stderr.write(
        `The 'call' command has been merged into 'run'.\n\n` +
        `Cloud execution is now the default behavior of 'orchagent run':\n` +
        `  orchagent run <agent> --data '{...}'      # runs on server (cloud)\n` +
        `  orchagent run <agent> --local --data '...' # runs locally\n\n` +
        `Replace 'orchagent call' with 'orchagent run' in your commands.\n`
      )
      process.exit(1)
    })
}
