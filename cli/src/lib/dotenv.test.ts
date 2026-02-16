import { describe, it, expect } from 'vitest'
import { parseDotEnv, mergeEnv } from './dotenv'

describe('parseDotEnv', () => {
  it('parses basic KEY=VALUE pairs', () => {
    const result = parseDotEnv('FOO=bar\nBAZ=qux')
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('skips comments and blank lines', () => {
    const result = parseDotEnv('# comment\n\nFOO=bar\n  # indented comment\n')
    expect(result).toEqual({ FOO: 'bar' })
  })

  it('handles double-quoted values', () => {
    const result = parseDotEnv('KEY="hello world"')
    expect(result).toEqual({ KEY: 'hello world' })
  })

  it('handles single-quoted values', () => {
    const result = parseDotEnv("KEY='hello world'")
    expect(result).toEqual({ KEY: 'hello world' })
  })

  it('handles empty values', () => {
    const result = parseDotEnv('KEY=')
    expect(result).toEqual({ KEY: '' })
  })

  it('handles values with equals signs', () => {
    const result = parseDotEnv('URL=https://example.com?foo=bar&baz=1')
    expect(result).toEqual({ URL: 'https://example.com?foo=bar&baz=1' })
  })

  it('trims whitespace around keys and values', () => {
    const result = parseDotEnv('  FOO  =  bar  ')
    expect(result).toEqual({ FOO: 'bar' })
  })

  it('skips lines without equals sign', () => {
    const result = parseDotEnv('NOEQ\nFOO=bar')
    expect(result).toEqual({ FOO: 'bar' })
  })

  it('returns empty object for empty input', () => {
    expect(parseDotEnv('')).toEqual({})
  })
})

describe('mergeEnv', () => {
  it('adds .env vars to base', () => {
    const base = { EXISTING: 'yes' } as Record<string, string | undefined>
    const dotenv = { NEW_VAR: 'hello' }
    const result = mergeEnv(base, dotenv)
    expect(result.EXISTING).toBe('yes')
    expect(result.NEW_VAR).toBe('hello')
  })

  it('does not override existing values', () => {
    const base = { KEY: 'original' } as Record<string, string | undefined>
    const dotenv = { KEY: 'from-dotenv' }
    const result = mergeEnv(base, dotenv)
    expect(result.KEY).toBe('original')
  })

  it('overrides undefined values', () => {
    const base = { KEY: undefined } as Record<string, string | undefined>
    const dotenv = { KEY: 'from-dotenv' }
    const result = mergeEnv(base, dotenv)
    expect(result.KEY).toBe('from-dotenv')
  })
})
