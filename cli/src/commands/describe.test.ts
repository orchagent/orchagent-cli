import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { Command } from 'commander'

import { registerDescribeCommand } from './describe'

function parseStdout(spy: ReturnType<typeof vi.spyOn>): any {
  const raw = spy.mock.calls.map((call) => call[0]).join('')
  return JSON.parse(raw)
}

describe('describe command', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    program = new Command()
    program.exitOverride()

    program
      .command('run <agent>')
      .description('Execute an agent and return results')
      .option('--data <json>', 'JSON input')
      .option('--input <json>', 'Alias for --data')
      .option('--json', 'Output raw JSON')
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
      .option('--dry-run', 'Validate only')

    registerDescribeCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('outputs structured JSON for top-level commands', async () => {
    await program.parseAsync(['node', 'test', 'describe', 'run', '--json'])

    const result = parseStdout(stdoutSpy)
    expect(result.command).toBe('run')
    expect(result.description).toBe('Execute an agent and return results')
    expect(result.arguments).toEqual([
      {
        name: 'agent',
        required: true,
        variadic: false,
        format: 'org/name[@version]',
      },
    ])

    const dataFlag = result.flags.find((flag: any) => flag.name === '--data')
    expect(dataFlag).toMatchObject({
      name: '--data',
      type: 'string',
      alias: '--input',
    })
    expect(result.mutations).toBe(false)
    expect(result.examples).toContain('orch run acme/security --data @input.json')
  })

  it('supports subcommand paths', async () => {
    await program.parseAsync(['node', 'test', 'describe', 'schedule', 'create', '--json'])

    const result = parseStdout(stdoutSpy)
    expect(result.command).toBe('schedule create')
    expect(result.mutations).toBe(true)
    expect(result.dry_run).toBe(true)
    expect(result.flags.some((flag: any) => flag.name === '--dry-run')).toBe(true)
  })

  it('throws a not-found error for unknown command', async () => {
    await expect(
      program.parseAsync(['node', 'test', 'describe', 'missing', '--json'])
    ).rejects.toMatchObject({
      message: 'Unknown command "missing"',
      exitCode: 4,
      code: 'NOT_FOUND',
    })
  })
})

