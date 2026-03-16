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

  // DX-29: Input hardening
  describe('input hardening (DX-29)', () => {
    it('rejects control characters in agent name', () => {
      expect(() => parseAgentRef('my-agent\x00')).toThrow(/control character/)
    })

    it('rejects control characters in org name', () => {
      expect(() => parseAgentRef('my\x07org/agent')).toThrow(/control character/)
    })

    it('rejects control characters in version', () => {
      expect(() => parseAgentRef('org/agent@v1\x1B')).toThrow(/control character/)
    })

    it('rejects ? in agent ref (query param injection)', () => {
      expect(() => parseAgentRef('org/agent?foo=bar')).toThrow(/\?/)
    })

    it('rejects # in agent ref (fragment injection)', () => {
      expect(() => parseAgentRef('org/agent#section')).toThrow(/#/)
    })

    it('rejects % in agent ref (URL encoding)', () => {
      expect(() => parseAgentRef('org/agent%2F')).toThrow(/%/)
    })

    it('rejects & in agent ref (query param injection)', () => {
      expect(() => parseAgentRef('org/agent&x=1')).toThrow(/&/)
    })

    it('rejects double-encoded sequences', () => {
      expect(() => parseAgentRef('org/agent%252F')).toThrow(/%/)
    })

    it('rejects ? in version string', () => {
      expect(() => parseAgentRef('org/agent@v1?debug=true')).toThrow(/\?/)
    })
  })
})
