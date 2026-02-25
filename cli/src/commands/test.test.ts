/**
 * Tests for `orch test` command.
 * Covers: validation, --validate-only flag, and help text updates.
 */

import { describe, it, expect } from 'vitest'
import { Command } from 'commander'
import { registerTestCommand } from './test'

describe('orch test command', () => {
  it('test command is registered with updated description', () => {
    const program = new Command()
    registerTestCommand(program)

    const testCmd = program.commands.find((cmd: any) => cmd.name() === 'test')
    expect(testCmd).toBeDefined()
    expect(testCmd?.description()).toContain('Validate configuration and run test suite')
    expect(testCmd?.description()).toContain('fixtures + unit tests')
  })

  it('test command has --validate-only option', () => {
    const program = new Command()
    registerTestCommand(program)

    const testCmd = program.commands.find((cmd: any) => cmd.name() === 'test')
    const opts = testCmd?.options || []
    const validateOnlyOpt = opts.find((opt: any) => opt.long === '--validate-only')
    expect(validateOnlyOpt).toBeDefined()
  })

  it('test command help text shows --validate-only option', () => {
    const program = new Command()
    registerTestCommand(program)

    const testCmd = program.commands.find((cmd: any) => cmd.name() === 'test')
    const helpText = testCmd?.helpInformation() || ''

    // Should show --validate-only option
    expect(helpText).toContain('--validate-only')
    expect(helpText).toContain('Run validation only')
  })
})
