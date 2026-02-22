/**
 * BUG-16: Deprecation/error messages must go to stderr only, never stdout.
 *
 * These tests verify that all deprecated command stubs and error messages
 * output exclusively to stderr and never leak to stdout. This prevents
 * breaking scripts that pipe stdout (e.g., `orch run agent | jq`).
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../lib/analytics', () => ({
  track: vi.fn().mockResolvedValue(undefined),
  shutdownPostHog: vi.fn().mockResolvedValue(undefined),
  initPostHog: vi.fn(),
}))

describe('BUG-16: error messages go to stderr only', () => {
  it('jsonInputError content only appears on stderr via exitWithError', async () => {
    // Import dynamically to avoid circular dependency issues
    const { jsonInputError, exitWithError } = await import('../lib/errors')

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as any)

    try {
      const err = jsonInputError('data')
      await exitWithError(err)
    } catch {
      // Expected: process.exit mock throws
    }

    // stderr MUST contain the error message
    const stderrOutput = stderrSpy.mock.calls.map(c => String(c[0])).join('')
    expect(stderrOutput).toContain('Invalid JSON')
    expect(stderrOutput).toContain('--data')

    // stdout MUST be empty
    const stdoutOutput = stdoutSpy.mock.calls.map(c => String(c[0])).join('')
    expect(stdoutOutput).toBe('')

    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    exitSpy.mockRestore()
  })

  it('CliError messages only appear on stderr via exitWithError', async () => {
    const { CliError, exitWithError } = await import('../lib/errors')

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as any)

    try {
      await exitWithError(new CliError('Something went wrong', 1))
    } catch {
      // Expected
    }

    const stderrOutput = stderrSpy.mock.calls.map(c => String(c[0])).join('')
    expect(stderrOutput).toContain('Something went wrong')

    const stdoutOutput = stdoutSpy.mock.calls.map(c => String(c[0])).join('')
    expect(stdoutOutput).toBe('')

    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    exitSpy.mockRestore()
  })

  it('displayed errors are not printed again', async () => {
    const { CliError, exitWithError } = await import('../lib/errors')

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as any)

    try {
      const err = new CliError('Already shown error')
      err.displayed = true
      await exitWithError(err)
    } catch {
      // Expected
    }

    // stderr should NOT contain the message (it was already displayed)
    const stderrOutput = stderrSpy.mock.calls.map(c => String(c[0])).join('')
    expect(stderrOutput).not.toContain('Already shown error')

    // stdout should be empty
    const stdoutOutput = stdoutSpy.mock.calls.map(c => String(c[0])).join('')
    expect(stdoutOutput).toBe('')

    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    exitSpy.mockRestore()
  })
})
