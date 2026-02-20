import { Command } from 'commander'
import chalk from 'chalk'

export function registerKeysCommand(program: Command): void {
  program
    .command('keys')
    .description('(Deprecated) Use "orch secrets" instead')
    .allowUnknownOption(true)
    .action(() => {
      process.stderr.write(
        chalk.yellow('\nThe `orch keys` command has been removed.\n\n') +
        `LLM API keys are now managed through the unified workspace secrets vault.\n` +
        `Use ${chalk.cyan('orch secrets')} instead:\n\n` +
        `  ${chalk.cyan('orch secrets set ANTHROPIC_API_KEY <key>')}   Add an LLM key\n` +
        `  ${chalk.cyan('orch secrets list')}                          List all secrets\n` +
        `  ${chalk.cyan('orch secrets delete ANTHROPIC_API_KEY')}      Remove a key\n\n`
      )
      process.exit(1)
    })
}
