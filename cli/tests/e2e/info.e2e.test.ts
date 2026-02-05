/**
 * E2E Tests for Info Command
 *
 * Tests the `orch info` command with real API calls.
 */

import { describe, it, expect } from 'vitest'
import { runOrch, outputContains } from './setup'

describe('info command', () => {
  it('shows agent details for a valid agent', async () => {
    const result = await runOrch(['info', 'orchagent/leak-finder'])

    expect(result.code).toBe(0)
    // Should show agent description mentioning secrets/security
    expect(outputContains(result.stdout + result.stderr, 'secret', 'leak', 'security', 'scan')).toBe(
      true
    )
  })

  it('shows error for nonexistent agent', async () => {
    const result = await runOrch(['info', 'nonexistent/totallynotreal'])

    // Should fail with non-zero exit code
    expect(result.code).not.toBe(0)
    // Should show helpful error message
    expect(outputContains(result.stdout + result.stderr, 'not found', 'error', '404')).toBe(true)
  })

  it('shows version information', async () => {
    const result = await runOrch(['info', 'orchagent/leak-finder@v1'])

    expect(result.code).toBe(0)
    // Should show version info
    expect(outputContains(result.stdout + result.stderr, 'v1', 'version')).toBe(true)
  })
})
