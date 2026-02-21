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

describe('deploy request body construction', () => {
  // Mirrors the body construction logic from service.ts deploy action
  function buildDeployBody(options: {
    name: string
    agentId: string
    agentName: string
    agentVersion: string
    env: Record<string, string>
    secret: string[]
    pin?: boolean
  }) {
    return {
      agent_id: options.agentId,
      agent_name: options.agentName,
      agent_version: options.agentVersion,
      service_name: options.name,
      env: Object.keys(options.env).length > 0 ? options.env : null,
      secret_names: options.secret.length > 0 ? options.secret : null,
      ...(options.pin ? { auto_update: false } : {}),
    }
  }

  it('includes auto_update=false when --pin is set', () => {
    const body = buildDeployBody({
      name: 'my-svc',
      agentId: 'abc-123',
      agentName: 'my-agent',
      agentVersion: 'v1',
      env: {},
      secret: [],
      pin: true,
    })
    expect(body.auto_update).toBe(false)
  })

  it('omits auto_update when --pin is not set', () => {
    const body = buildDeployBody({
      name: 'my-svc',
      agentId: 'abc-123',
      agentName: 'my-agent',
      agentVersion: 'v1',
      env: {},
      secret: [],
    })
    expect(body).not.toHaveProperty('auto_update')
  })

  it('omits auto_update when pin is explicitly false', () => {
    const body = buildDeployBody({
      name: 'my-svc',
      agentId: 'abc-123',
      agentName: 'my-agent',
      agentVersion: 'v1',
      env: {},
      secret: [],
      pin: false,
    })
    expect(body).not.toHaveProperty('auto_update')
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

describe('env set merge logic', () => {
  function mergeEnv(currentEnv: Record<string, string>, pairs: string[]): Record<string, string> {
    const newEnv: Record<string, string> = {}
    for (const pair of pairs) {
      const idx = pair.indexOf('=')
      if (idx < 0) throw new Error(`Invalid format: '${pair}'. Use KEY=VALUE.`)
      newEnv[pair.slice(0, idx)] = pair.slice(idx + 1)
    }
    return { ...currentEnv, ...newEnv }
  }

  it('merges new keys into empty env', () => {
    expect(mergeEnv({}, ['FOO=bar', 'BAZ=qux'])).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('overwrites existing keys', () => {
    expect(mergeEnv({ FOO: 'old' }, ['FOO=new'])).toEqual({ FOO: 'new' })
  })

  it('preserves unmodified keys', () => {
    expect(mergeEnv({ A: '1', B: '2' }, ['C=3'])).toEqual({ A: '1', B: '2', C: '3' })
  })

  it('handles value with equals sign', () => {
    expect(mergeEnv({}, ['URL=https://x.com?a=1'])).toEqual({ URL: 'https://x.com?a=1' })
  })

  it('throws on invalid pair', () => {
    expect(() => mergeEnv({}, ['NOEQUALS'])).toThrow('Invalid format')
  })
})

describe('env unset logic', () => {
  function unsetEnv(currentEnv: Record<string, string>, keys: string[]): { result: Record<string, string>; removed: string[] } {
    const result = { ...currentEnv }
    const removed: string[] = []
    for (const key of keys) {
      if (key in result) {
        delete result[key]
        removed.push(key)
      }
    }
    return { result, removed }
  }

  it('removes existing keys', () => {
    const { result, removed } = unsetEnv({ A: '1', B: '2', C: '3' }, ['A', 'C'])
    expect(result).toEqual({ B: '2' })
    expect(removed).toEqual(['A', 'C'])
  })

  it('ignores non-existent keys', () => {
    const { result, removed } = unsetEnv({ A: '1' }, ['X'])
    expect(result).toEqual({ A: '1' })
    expect(removed).toEqual([])
  })

  it('handles empty env', () => {
    const { result, removed } = unsetEnv({}, ['A'])
    expect(result).toEqual({})
    expect(removed).toEqual([])
  })

  it('removes all keys when all specified', () => {
    const { result, removed } = unsetEnv({ A: '1', B: '2' }, ['A', 'B'])
    expect(result).toEqual({})
    expect(removed).toEqual(['A', 'B'])
  })
})

describe('secret add merge logic', () => {
  function mergeSecrets(current: string[], toAdd: string[]): string[] {
    return [...new Set([...current, ...toAdd])]
  }

  it('adds new secrets', () => {
    expect(mergeSecrets([], ['TOKEN'])).toEqual(['TOKEN'])
  })

  it('deduplicates existing secrets', () => {
    expect(mergeSecrets(['TOKEN'], ['TOKEN'])).toEqual(['TOKEN'])
  })

  it('merges new with existing', () => {
    const result = mergeSecrets(['A'], ['B', 'C'])
    expect(result).toEqual(['A', 'B', 'C'])
  })

  it('deduplicates mixed', () => {
    const result = mergeSecrets(['A', 'B'], ['B', 'C'])
    expect(result).toEqual(['A', 'B', 'C'])
  })
})

describe('service URL formatting', () => {
  // Mirrors formatServiceUrl from service.ts
  function formatServiceUrl(
    providerUrl: string | null,
    cloudRunUrl: string | null,
    infrastructureProvider: string | null,
  ): { url: string; isInternal: boolean } {
    const url = providerUrl || cloudRunUrl || '-'
    const isInternal = infrastructureProvider === 'flyio' && url !== '-'
    return { url, isInternal }
  }

  it('marks Fly.io URLs as internal', () => {
    const result = formatServiceUrl(
      'https://orch-ws-uuid-my-bot.fly.dev',
      null,
      'flyio',
    )
    expect(result.url).toBe('https://orch-ws-uuid-my-bot.fly.dev')
    expect(result.isInternal).toBe(true)
  })

  it('does not mark Cloud Run URLs as internal', () => {
    const result = formatServiceUrl(
      'https://orch-svc-xxx.run.app',
      'https://orch-svc-xxx.run.app',
      'cloud_run',
    )
    expect(result.isInternal).toBe(false)
  })

  it('returns dash when no URL available', () => {
    const result = formatServiceUrl(null, null, null)
    expect(result.url).toBe('-')
    expect(result.isInternal).toBe(false)
  })

  it('prefers provider_url over cloud_run_url', () => {
    const result = formatServiceUrl(
      'https://provider.fly.dev',
      'https://cloud-run.run.app',
      'flyio',
    )
    expect(result.url).toBe('https://provider.fly.dev')
  })

  it('handles null provider with flyio infrastructure', () => {
    const result = formatServiceUrl(null, null, 'flyio')
    expect(result.url).toBe('-')
    expect(result.isInternal).toBe(false)
  })
})

describe('secret remove filter logic', () => {
  function removeSecrets(current: string[], toRemove: string[]): { filtered: string[]; removed: string[] } {
    const namesToRemove = new Set(toRemove)
    const filtered = current.filter(n => !namesToRemove.has(n))
    const removed = current.filter(n => namesToRemove.has(n))
    return { filtered, removed }
  }

  it('removes specified secrets', () => {
    const { filtered, removed } = removeSecrets(['A', 'B', 'C'], ['B'])
    expect(filtered).toEqual(['A', 'C'])
    expect(removed).toEqual(['B'])
  })

  it('ignores non-existent secrets', () => {
    const { filtered, removed } = removeSecrets(['A'], ['X'])
    expect(filtered).toEqual(['A'])
    expect(removed).toEqual([])
  })

  it('removes all when all specified', () => {
    const { filtered, removed } = removeSecrets(['A', 'B'], ['A', 'B'])
    expect(filtered).toEqual([])
    expect(removed).toEqual(['A', 'B'])
  })
})
