/**
 * Tests for `orch test` command.
 * Covers: validation, --validate-only flag, help text updates,
 * and BUG-11-08 (vault limitation error message).
 */

import { describe, it, expect } from 'vitest'
import { Command } from 'commander'
import { registerTestCommand, NO_LLM_KEY_FIXTURE_MESSAGE } from './test'

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

/**
 * BUG-11-08: Error message when no LLM key is found for fixture tests
 * should explain that vault keys can't be used (tests run locally)
 * and suggest alternatives.
 */
describe('BUG-11-08: fixture test LLM key error message', () => {
  it('explains that fixture tests run locally', () => {
    expect(NO_LLM_KEY_FIXTURE_MESSAGE).toContain('run locally')
  })

  it('explains that vault keys cannot be used', () => {
    expect(NO_LLM_KEY_FIXTURE_MESSAGE).toContain('vault')
  })

  it('suggests setting local environment variables', () => {
    expect(NO_LLM_KEY_FIXTURE_MESSAGE).toContain('OPENAI_API_KEY')
    expect(NO_LLM_KEY_FIXTURE_MESSAGE).toContain('ANTHROPIC_API_KEY')
    expect(NO_LLM_KEY_FIXTURE_MESSAGE).toContain('GEMINI_API_KEY')
  })

  it('suggests .env file as alternative', () => {
    expect(NO_LLM_KEY_FIXTURE_MESSAGE).toContain('.env')
  })

  it('suggests orch run --cloud for vault key usage', () => {
    expect(NO_LLM_KEY_FIXTURE_MESSAGE).toContain('orch run --cloud')
  })

  it('does NOT suggest orch secrets set (misleading for local tests)', () => {
    expect(NO_LLM_KEY_FIXTURE_MESSAGE).not.toContain('orch secrets set')
  })
})
