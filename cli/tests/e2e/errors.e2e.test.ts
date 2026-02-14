/**
 * E2E Tests for Error Message Quality
 *
 * Tests that error messages are helpful and actionable.
 * Includes regression test for Bug #1: Empty error messages.
 */

import { describe, it, expect } from 'vitest'
import { runOrch, outputContains } from './setup'

const describeLive = process.env.ORCH_E2E_SKIP_LIVE === '1' ? describe.skip : describe

describeLive('error message quality', () => {
  describe('Bug #1 regression: errors must be descriptive', () => {
    it('shows descriptive error when run is missing input', async () => {
      const result = await runOrch(['run', 'orchagent/leak-finder'], {
        timeout: 120000,
      })

      const combined = result.stdout + result.stderr

      // Should NOT show only "exit code 1" with no explanation
      const emptyError =
        outputContains(combined, 'exit code 1') &&
        !outputContains(combined, 'missing', 'required', 'input', 'error', 'usage', 'directory', 'path', 'repo')

      expect(emptyError).toBe(false)

      // If it errors, should show helpful message
      if (result.code !== 0) {
        expect(
          outputContains(combined, 'missing', 'required', 'input', 'usage', 'error', 'directory', 'path')
        ).toBe(true)
      }
    })

    it('shows actual error message, not just exit code', async () => {
      // Force an error by providing invalid input
      const result = await runOrch(['run', 'orchagent/leak-finder', '--input', 'not-valid-json'], {
        timeout: 120000,
      })

      const combined = result.stdout + result.stderr

      // Should show actual error about JSON, not just "exit code 1"
      expect(outputContains(combined, 'json', 'invalid', 'parse', 'error')).toBe(true)
    })
  })

  describe('error handling for invalid commands', () => {
    it('shows error for invalid agent reference format', async () => {
      const result = await runOrch(['run', 'a/b/c/d/e'])

      expect(result.code).not.toBe(0)
      expect(outputContains(result.stdout + result.stderr, 'invalid', 'format', 'error')).toBe(true)
    })

    it('shows helpful message for missing org', async () => {
      // Run with just agent name when no default org is set
      // This may or may not fail depending on config
      const result = await runOrch(['run', 'some-agent'])

      // If it fails, should mention org
      if (result.code !== 0) {
        expect(outputContains(result.stdout + result.stderr, 'org', 'not found', 'error')).toBe(true)
      }
    })
  })

  describe('error handling for API errors', () => {
    it('shows not found error for nonexistent agent', async () => {
      const result = await runOrch(['info', 'nonexistent/totallynotreal12345'])

      expect(result.code).not.toBe(0)
      const combined = result.stdout + result.stderr
      expect(outputContains(combined, 'not found', '404', 'error', 'does not exist')).toBe(true)
    })

    it('does not show stack traces in normal operation', async () => {
      const result = await runOrch(['info', 'nonexistent/totallynotreal12345'])

      const combined = result.stdout + result.stderr

      // Should NOT show internal stack traces
      expect(outputContains(combined, 'at Object.', 'at Module.', 'at Function.')).toBe(false)
      expect(outputContains(combined, '.ts:', '.js:')).toBe(false)
    })
  })

  describe('call command errors', () => {
    it('shows error for invalid JSON in --data', async () => {
      const result = await runOrch(['call', 'orchagent/leak-finder', '--data', 'not-json'])

      expect(result.code).not.toBe(0)
      expect(outputContains(result.stdout + result.stderr, 'json', 'invalid', 'parse', 'error')).toBe(
        true
      )
    })

    it('shows helpful error when --data is missing required fields', async () => {
      const result = await runOrch(['call', 'orchagent/leak-finder', '--data', '{}'], {
        timeout: 60000,
      })

      // May or may not error depending on agent requirements
      // But if it errors, should be helpful
      if (result.code !== 0) {
        expect(
          outputContains(result.stdout + result.stderr, 'missing', 'required', 'field', 'input', 'error')
        ).toBe(true)
      }
    })
  })
})
