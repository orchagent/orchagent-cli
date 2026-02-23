import { describe, it, expect } from 'vitest'
import { parseAgentRef } from './agent-ref'

describe('parseAgentRef', () => {
  it('parses org/agent format', () => {
    expect(parseAgentRef('myorg/my-agent')).toEqual({
      org: 'myorg',
      agent: 'my-agent',
      version: 'latest',
    })
  })

  it('parses org/agent@version format', () => {
    expect(parseAgentRef('myorg/my-agent@v2')).toEqual({
      org: 'myorg',
      agent: 'my-agent',
      version: 'v2',
    })
  })

  it('uses custom default version', () => {
    expect(parseAgentRef('myorg/my-agent', 'v1')).toEqual({
      org: 'myorg',
      agent: 'my-agent',
      version: 'v1',
    })
  })

  // BUG-A: single-segment ref should return org as undefined, not throw
  it('accepts single-segment ref (agent name only)', () => {
    const result = parseAgentRef('my-agent')
    expect(result).toEqual({
      org: undefined,
      agent: 'my-agent',
      version: 'latest',
    })
  })

  it('accepts single-segment ref with version', () => {
    const result = parseAgentRef('my-agent@v3')
    expect(result).toEqual({
      org: undefined,
      agent: 'my-agent',
      version: 'v3',
    })
  })

  it('throws on too many segments', () => {
    expect(() => parseAgentRef('a/b/c')).toThrow()
  })
})
