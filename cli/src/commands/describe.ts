import { Command } from 'commander'

import {
  buildCliCommandMetadata,
  CommandMetadata,
  findCommandMetadata,
} from '../lib/command-introspection'
import { CliError, ErrorCodes, ExitCodes } from '../lib/errors'
import { printJson } from '../lib/output'

interface DescribeOptions {
  json?: boolean
  markdown?: boolean
}

interface DescribeFlagOutput {
  name: string
  type: string
  required: boolean
  value_required?: boolean
  description: string
  short?: string
  alias?: string
  choices?: readonly string[]
  default?: unknown
}

interface DescribeArgumentOutput {
  name: string
  required: boolean
  variadic: boolean
  format: string
  description?: string
}

interface DescribeCommandOutput {
  command: string
  description: string
  usage: string
  arguments: DescribeArgumentOutput[]
  flags: DescribeFlagOutput[]
  mutations: boolean
  dry_run: boolean
  examples: string[]
  aliases: string[]
  subcommands?: Array<{
    command: string
    description: string
    usage: string
    mutations: boolean
    dry_run: boolean
  }>
}

function toDescribeOutput(command: CommandMetadata): DescribeCommandOutput {
  return {
    command: command.path,
    description: command.description,
    usage: `orch ${command.usage}`,
    arguments: command.arguments.map((argument) => ({
      name: argument.name,
      required: argument.required,
      variadic: argument.variadic,
      format: argument.format,
      ...(argument.description ? { description: argument.description } : {}),
    })),
    flags: command.flags.map((flag) => ({
      name: flag.name,
      type: flag.type,
      required: flag.required,
      ...(flag.valueRequired ? { value_required: true } : {}),
      description: flag.description,
      ...(flag.short ? { short: flag.short } : {}),
      ...(flag.alias ? { alias: flag.alias } : {}),
      ...(flag.choices ? { choices: flag.choices } : {}),
      ...(flag.defaultValue !== undefined ? { default: flag.defaultValue } : {}),
    })),
    mutations: command.mutations,
    dry_run: command.dryRun,
    examples: command.examples,
    aliases: command.aliases,
    ...(command.subcommands.length > 0
      ? {
          subcommands: command.subcommands.map((subcommand) => ({
            command: subcommand.path,
            description: subcommand.description,
            usage: `orch ${subcommand.usage}`,
            mutations: subcommand.mutations,
            dry_run: subcommand.dryRun,
          })),
        }
      : {}),
  }
}

function renderMarkdown(command: CommandMetadata): string {
  const argumentLines = command.arguments.length > 0
    ? command.arguments
      .map(
        (argument) =>
          `- \`${argument.name}\` (${argument.required ? 'required' : 'optional'}, ${argument.format})${argument.description ? ` - ${argument.description}` : ''}`
      )
      .join('\n')
    : '- None'

  const flagLines = command.flags.length > 0
    ? command.flags
      .map((flag) => {
        const parts: string[] = [`\`${flag.name}\``]
        if (flag.alias) parts.push(`alias: \`${flag.alias}\``)
        if (flag.short) parts.push(`short: \`${flag.short}\``)
        parts.push(`type: ${flag.type}`)
        return `- ${parts.join(', ')} - ${flag.description}`
      })
      .join('\n')
    : '- None'

  const subcommandLines = command.subcommands.length > 0
    ? command.subcommands
      .map((subcommand) => `- \`${subcommand.path}\` - ${subcommand.description}`)
      .join('\n')
    : '- None'

  const exampleLines = command.examples.length > 0
    ? command.examples.map((example) => `- \`${example}\``).join('\n')
    : '- None'

  return `# orch describe: ${command.path}

## Description
${command.description || 'No description available'}

## Usage
\`orch ${command.usage}\`

## Mutations
${command.mutations ? 'Yes' : 'No'}

## Dry Run
${command.dryRun ? 'Supported' : 'Not supported'}

## Arguments
${argumentLines}

## Flags
${flagLines}

## Subcommands
${subcommandLines}

## Examples
${exampleLines}
`
}

function resolveCommand(program: Command, commandPath: readonly string[]): CommandMetadata {
  const allCommands = buildCliCommandMetadata(program)
  const match = findCommandMetadata(allCommands, commandPath)
  if (match) return match

  const query = commandPath.join(' ')
  const err = new CliError(`Unknown command "${query}"`, ExitCodes.NOT_FOUND)
  err.code = ErrorCodes.NOT_FOUND
  err.hint = 'Run "orch context" to list available commands.'
  throw err
}

export function registerDescribeCommand(program: Command): void {
  program
    .command('describe <command...>')
    .description('Show machine-readable metadata for a single command')
    .option('--json', 'Output machine-readable JSON (default)')
    .option('--markdown', 'Output markdown instead of JSON')
    .addHelpText(
      'after',
      `
Examples:
  orch describe run --json
  orch describe schedule create --json
`
    )
    .action((commandPath: string[], options: DescribeOptions) => {
      const command = resolveCommand(program, commandPath)

      if (options.markdown) {
        process.stdout.write(renderMarkdown(command))
        return
      }

      printJson(toDescribeOutput(command))
    })
}
