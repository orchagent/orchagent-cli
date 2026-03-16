import { Command } from 'commander'
import yaml from 'yaml'

import packageJson from '../../package.json'
import { buildCliCommandMetadata, collectFlagNames } from '../lib/command-introspection'

interface ContextCommandEntry {
  name: string
  description: string
  flags: string[]
  mutations: boolean
  dry_run?: boolean
}

function toContextCommands(program: Command): ContextCommandEntry[] {
  return buildCliCommandMetadata(program).map((command) => ({
    name: command.name,
    description: command.description,
    flags: collectFlagNames(command),
    mutations: command.mutations,
    ...(command.dryRun ? { dry_run: true } : {}),
  }))
}

function buildGuideBody(commands: readonly ContextCommandEntry[]): string {
  const commandIndex = commands
    .map((command) => `- \`${command.name}\` - ${command.description || 'No description available'}`)
    .join('\n')

  const mutatingCommands = commands
    .filter((command) => command.mutations)
    .map((command) => `- \`${command.name}\`${command.dry_run ? ' (supports --dry-run)' : ''}`)
    .join('\n')

  return `# orchagent CLI - Agent Guide

## Authentication
Set \`ORCHAGENT_API_KEY\` in the environment. You can create a key with \`orch login\` or in the orchagent dashboard.

## Discovery
- Use \`orch context\` for a full command index plus machine-readable frontmatter.
- Use \`orch describe <command> --json\` for detailed metadata on one command.

## Output Conventions
- Prefer \`--json\` when your caller needs structured output.
- Commands that support \`--json\` automatically switch to JSON in non-TTY output.
- For JSON inputs, prefer \`--data @file.json\` or \`--data @-\` (stdin) over shell-escaped inline blobs.

## Common Patterns
- Use explicit agent references when possible: \`org/name@version\`.
- Use \`--dry-run\` before mutating operations whenever available.
- For large automation flows, inspect command contracts with \`orch describe\` before execution.

## Top-Level Commands
${commandIndex}

## Mutating Commands
${mutatingCommands || '- None detected'}
`
}

export function buildContextDocument(program: Command): string {
  const commands = toContextCommands(program)
  const version = program.version() || packageJson.version

  const frontmatter = {
    name: 'orchagent-cli',
    version,
    commands,
  }

  const body = buildGuideBody(commands).trim()
  return `---\n${yaml.stringify(frontmatter).trim()}\n---\n\n${body}\n`
}

export function registerContextCommand(program: Command): void {
  program
    .command('context')
    .description('Print an embedded CLI guide for AI agents (YAML frontmatter + markdown)')
    .addHelpText(
      'after',
      `
Examples:
  orch context
`
    )
    .action(() => {
      process.stdout.write(buildContextDocument(program))
    })
}

