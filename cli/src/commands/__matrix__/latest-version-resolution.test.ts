import { describe, it, expect } from 'vitest'

import { parseAgentRef } from '../../lib/agent-ref'

describe('latest-version resolution matrix', () => {
  it('defaults to latest for agent-only refs', () => {
    expect(parseAgentRef('scanner')).toEqual({ org: undefined, agent: 'scanner', version: 'latest' })
  })

  it('defaults to latest for org/agent refs', () => {
    expect(parseAgentRef('acme/scanner')).toEqual({ org: 'acme', agent: 'scanner', version: 'latest' })
  })

  it('preserves explicit pinned versions', () => {
    expect(parseAgentRef('acme/scanner@v2')).toEqual({ org: 'acme', agent: 'scanner', version: 'v2' })
  })

  it('does not strip malformed double-at refs automatically', () => {
    // This captures current parser behavior; command-level validation should reject later.
    expect(parseAgentRef('acme/scanner@@v2')).toEqual({ org: 'acme', agent: 'scanner', version: 'latest' })
  })
})
