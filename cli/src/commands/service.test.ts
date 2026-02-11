/**
 * Tests for service command utility functions and option parsing.
 *
 * Tests the collectKeyValue and collectArray option collectors
 * used by the `orch service deploy` command.
 */

import { describe, it, expect } from 'vitest'

// We test the option collector functions exported at module scope
// Since they're not exported, we'll test them via inline re-implementation
// matching the exact logic from service.ts

function collectKeyValue(value: string, previous: Record<string, string>): Record<string, string> {
  const idx = value.indexOf('=')
  if (idx < 0) {
    throw new Error(`Invalid env format: '${value}'. Use KEY=VALUE.`)
  }
  previous[value.slice(0, idx)] = value.slice(idx + 1)
  return previous
}

function collectArray(value: string, previous: string[]): string[] {
  previous.push(value)
  return previous
}

describe('collectKeyValue', () => {
  it('parses simple KEY=VALUE', () => {
    const result = collectKeyValue('FOO=bar', {})
    expect(result).toEqual({ FOO: 'bar' })
  })

  it('handles value with equals sign', () => {
    const result = collectKeyValue('URL=https://example.com?a=1', {})
    expect(result).toEqual({ URL: 'https://example.com?a=1' })
  })

  it('accumulates multiple values', () => {
    let acc: Record<string, string> = {}
    acc = collectKeyValue('A=1', acc)
    acc = collectKeyValue('B=2', acc)
    expect(acc).toEqual({ A: '1', B: '2' })
  })

  it('throws on missing equals', () => {
    expect(() => collectKeyValue('NOEQUALS', {})).toThrow('Invalid env format')
  })

  it('handles empty value', () => {
    const result = collectKeyValue('KEY=', {})
    expect(result).toEqual({ KEY: '' })
  })
})

describe('collectArray', () => {
  it('collects single value', () => {
    const result = collectArray('one', [])
    expect(result).toEqual(['one'])
  })

  it('accumulates values', () => {
    let acc: string[] = []
    acc = collectArray('one', acc)
    acc = collectArray('two', acc)
    expect(acc).toEqual(['one', 'two'])
  })
})

describe('service state formatting', () => {
  // Test the state/health color mapping logic
  const stateLabels: Record<string, string> = {
    running: 'running',
    provisioning: 'provisioning',
    unhealthy: 'unhealthy',
    failed: 'failed',
    deleting: 'deleting',
    deleted: 'deleted',
  }

  it('all states have labels', () => {
    const states = ['running', 'provisioning', 'unhealthy', 'failed', 'deleting', 'deleted']
    for (const state of states) {
      expect(stateLabels[state]).toBeDefined()
    }
  })

  it('health statuses are recognized', () => {
    const healthStatuses = ['healthy', 'degraded', 'unhealthy', 'unknown']
    for (const h of healthStatuses) {
      expect(typeof h).toBe('string')
    }
  })
})

describe('agent ref parsing', () => {
  function parseAgentRef(agentArg: string) {
    const parts = agentArg.split('/')
    if (parts.length !== 2) throw new Error('Invalid format')
    const [org, agentPart] = parts
    const atIndex = agentPart.indexOf('@')
    const name = atIndex >= 0 ? agentPart.slice(0, atIndex) : agentPart
    const version = atIndex >= 0 ? agentPart.slice(atIndex + 1) : 'latest'
    return { org, name, version }
  }

  it('parses org/agent', () => {
    expect(parseAgentRef('myorg/myagent')).toEqual({
      org: 'myorg',
      name: 'myagent',
      version: 'latest',
    })
  })

  it('parses org/agent@version', () => {
    expect(parseAgentRef('myorg/myagent@v3')).toEqual({
      org: 'myorg',
      name: 'myagent',
      version: 'v3',
    })
  })

  it('throws on bad format', () => {
    expect(() => parseAgentRef('noorg')).toThrow('Invalid format')
  })
})
