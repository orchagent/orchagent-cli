/**
 * E2E Tests for Search Command
 *
 * Tests the `orch search` command with real API calls.
 */

import { describe, it, expect } from 'vitest'
import { runOrch, outputContains } from './setup'

describe('search command', () => {
  it('finds agents matching a query', async () => {
    const result = await runOrch(['search', 'security'])

    // Should find at least one agent
    expect(result.code).toBe(0)
    expect(outputContains(result.stdout + result.stderr, 'leak-finder', 'security', 'agent')).toBe(
      true
    )
  })

  it('handles queries with no results gracefully', async () => {
    const result = await runOrch(['search', 'xyznonexistentquery12345randomstring'])

    // Should not crash - either shows "no results" or empty list
    expect(result.code).toBeLessThanOrEqual(1)
    // Should not show a stack trace or internal error
    expect(outputContains(result.stdout + result.stderr, 'Error:', 'at Object')).toBe(false)
  })

  it('shows agent names in search results', async () => {
    const result = await runOrch(['search', 'leak'])

    expect(result.code).toBe(0)
    // Should show leak-finder in results
    expect(outputContains(result.stdout, 'leak-finder', 'leak')).toBe(true)
  })
})
