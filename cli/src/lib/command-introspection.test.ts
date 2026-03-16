import { describe, it, expect } from 'vitest'
import { Command } from 'commander'

import {
  buildCliCommandMetadata,
  collectFlagNames,
  findCommandMetadata,
  tokenizeCommandQuery,
} from './command-introspection'

function createProgram(): Command {
  const program = new Command()
  program.version('1.2.3')

  program
    .command('run <agent> [file]')
    .description('Run an agent')
    .option('--data <json>', 'JSON payload')
    .option('--input <json>', 'Alias for --data')
    .option('--json', 'Output JSON')
    .addHelpText(
      'after',
      `
Examples:
  orch run acme/security --data @input.json
`
    )

  const schedule = program.command('schedule').description('Manage schedules')
  schedule
    .command('create <agent>')
    .description('Create a scheduled run')
    .option('--cron <expr>', 'Cron expression')
    .option('--dry-run', 'Validate without creating')
  schedule
    .command('list')
    .description('List schedules')
    .option('--json', 'Output JSON')

  return program
}

describe('command introspection', () => {
  it('builds metadata with flags, arguments, and examples', () => {
    const commands = buildCliCommandMetadata(createProgram())
    const run = commands.find((command) => command.name === 'run')

    expect(run).toBeDefined()
    expect(run!.arguments[0]).toMatchObject({
      name: 'agent',
      required: true,
      format: 'org/name[@version]',
    })

    const dataFlag = run!.flags.find((flag) => flag.name === '--data')
    expect(dataFlag).toMatchObject({
      alias: '--input',
      type: 'string',
    })
    expect(run!.flags.some((flag) => flag.name === '--input')).toBe(false)
    expect(run!.examples).toContain('orch run acme/security --data @input.json')
    expect(run!.mutations).toBe(false)
    expect(run!.dryRun).toBe(false)
  })

  it('inherits mutation and dry-run markers from subcommands', () => {
    const commands = buildCliCommandMetadata(createProgram())
    const schedule = commands.find((command) => command.name === 'schedule')

    expect(schedule).toBeDefined()
    expect(schedule!.mutations).toBe(true)
    expect(schedule!.dryRun).toBe(true)
    expect(collectFlagNames(schedule!)).toEqual(['--cron', '--dry-run', '--json'])
  })

  it('finds command metadata using tokenized paths', () => {
    const commands = buildCliCommandMetadata(createProgram())
    expect(tokenizeCommandQuery(['schedule:create'])).toEqual(['schedule', 'create'])

    const create = findCommandMetadata(commands, ['schedule:create'])
    expect(create).toBeDefined()
    expect(create!.path).toBe('schedule create')
    expect(create!.mutations).toBe(true)
  })
})

