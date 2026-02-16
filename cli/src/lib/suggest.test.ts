import { describe, it, expect } from 'vitest'
import { Command } from 'commander'
import { editDistance, findBestMatch, enhanceUnknownOptionSuggestions } from './suggest'

describe('editDistance', () => {
  it('returns 0 for identical strings', () => {
    expect(editDistance('abc', 'abc')).toBe(0)
  })

  it('returns length for empty vs non-empty', () => {
    expect(editDistance('', 'abc')).toBe(3)
    expect(editDistance('abc', '')).toBe(3)
  })

  it('handles single substitution', () => {
    expect(editDistance('cat', 'bat')).toBe(1)
  })

  it('handles single insertion', () => {
    expect(editDistance('strem', 'stream')).toBe(1)
  })

  it('handles single deletion', () => {
    expect(editDistance('stream', 'strem')).toBe(1)
  })

  it('handles transposition', () => {
    expect(editDistance('josn', 'json')).toBe(1)
  })

  it('handles multiple edits', () => {
    expect(editDistance('abc', 'xyz')).toBe(3)
  })
})

describe('findBestMatch', () => {
  const runFlags = [
    '--local', '--data', '--input', '--json', '--provider',
    '--model', '--key', '--skills', '--skills-only',
    '--no-skills', '--no-stream', '--endpoint', '--tenant',
    '--output', '--file', '--file-field', '--mount',
    '--metadata', '--download-only', '--with-deps', '--here',
    '--path',
  ]

  it('matches simple typos', () => {
    expect(findBestMatch('--dat', runFlags)).toBe('--data')
    expect(findBestMatch('--josn', runFlags)).toBe('--json')
    expect(findBestMatch('--loca', runFlags)).toBe('--local')
    expect(findBestMatch('--provdr', runFlags)).toBe('--provider')
    expect(findBestMatch('--outpt', runFlags)).toBe('--output')
  })

  it('matches negation-unaware typos to --no-X options', () => {
    // "strem" is close to "stream" (base of "no-stream")
    expect(findBestMatch('--strem', runFlags)).toBe('--no-stream')
    expect(findBestMatch('--streem', runFlags)).toBe('--no-stream')
  })

  it('returns null for completely unrelated flags', () => {
    expect(findBestMatch('--verbose', runFlags)).toBeNull()
    expect(findBestMatch('--debug', runFlags)).toBeNull()
    expect(findBestMatch('--cloud', runFlags)).toBeNull()
  })

  it('returns null for empty candidates', () => {
    expect(findBestMatch('--data', [])).toBeNull()
  })

  it('handles short flags without crashing', () => {
    expect(findBestMatch('-x', runFlags)).toBeNull()
  })
})

describe('enhanceUnknownOptionSuggestions', () => {
  function createTestProgram(): Command {
    const program = new Command()
    program.exitOverride()

    const run = program
      .command('run')
      .argument('[agent]')
      .option('--local', 'Run locally')
      .option('--data <json>', 'JSON payload')
      .option('--json', 'Output raw JSON')
      .option('--no-stream', 'Disable streaming')
      .action(() => {})

    enhanceUnknownOptionSuggestions(program)
    return program
  }

  it('shows context hint for --cloud on run', () => {
    const program = createTestProgram()
    expect(() => program.parse(['node', 'test', 'run', 'myagent', '--cloud']))
      .toThrow(/Cloud execution is the default/)
  })

  it('suggests --no-stream for --strem', () => {
    const program = createTestProgram()
    expect(() => program.parse(['node', 'test', 'run', 'myagent', '--strem']))
      .toThrow(/Did you mean --no-stream/)
  })

  it('suggests --data for --dat', () => {
    const program = createTestProgram()
    expect(() => program.parse(['node', 'test', 'run', 'myagent', '--dat', '{}']))
      .toThrow(/Did you mean --data/)
  })

  it('gives bare error for completely unknown flag', () => {
    const program = createTestProgram()
    try {
      program.parse(['node', 'test', 'run', 'myagent', '--verbose'])
      expect.unreachable()
    } catch (err: any) {
      expect(err.message).toContain("unknown option '--verbose'")
      expect(err.message).not.toContain('Did you mean')
      expect(err.message).not.toContain('Hint')
    }
  })

  it('does not show --cloud hint on non-run commands', () => {
    const program = new Command()
    program.exitOverride()
    program
      .command('publish')
      .option('--local-download', 'Allow local download')
      .action(() => {})
    enhanceUnknownOptionSuggestions(program)

    try {
      program.parse(['node', 'test', 'publish', '--cloud'])
      expect.unreachable()
    } catch (err: any) {
      expect(err.message).not.toContain('Cloud execution')
    }
  })
})
