/**
 * Tests for diff-format.ts — colorized diff output for `orch diff`.
 *
 * Tests individual formatters and the full printDiffs integration.
 * Uses chalk.level to detect ANSI codes in output.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import chalk from 'chalk'

import {
  formatValuePlain,
  formatPromptDiff,
  formatSchemaDiff,
  formatStringArrayDiff,
  formatDependencyDiff,
  formatCustomToolDiff,
  formatModelsDiff,
  printDiffs,
} from './diff-format'
import type { FieldDiff } from './diff'

// Force chalk colors on in test environment
chalk.level = 3

/** Strip ANSI escape codes for text-content assertions. */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '')
}

// ── formatValuePlain ──────────────────────────────────────────

describe('formatValuePlain', () => {
  it('formats null as (none)', () => {
    expect(formatValuePlain(null)).toBe('(none)')
  })

  it('formats undefined as (none)', () => {
    expect(formatValuePlain(undefined)).toBe('(none)')
  })

  it('formats booleans as strings', () => {
    expect(formatValuePlain(true)).toBe('true')
    expect(formatValuePlain(false)).toBe('false')
  })

  it('formats short strings as-is', () => {
    expect(formatValuePlain('hello')).toBe('hello')
  })

  it('truncates long strings at 120 chars', () => {
    const long = 'x'.repeat(200)
    const result = formatValuePlain(long)
    expect(result).toHaveLength(120)
    expect(result.endsWith('...')).toBe(true)
  })

  it('formats empty array as []', () => {
    expect(formatValuePlain([])).toBe('[]')
  })

  it('formats string array as comma-separated', () => {
    expect(formatValuePlain(['a', 'b', 'c'])).toBe('a, b, c')
  })

  it('formats object array as indented JSON', () => {
    const result = formatValuePlain([{ id: 'x' }])
    expect(result).toContain('"id"')
    expect(result).toContain('\n')
  })

  it('formats objects as indented JSON', () => {
    const result = formatValuePlain({ key: 'val' })
    expect(result).toContain('"key"')
  })

  it('formats numbers as strings', () => {
    expect(formatValuePlain(42)).toBe('42')
  })
})

// ── formatPromptDiff ──────────────────────────────────────────

describe('formatPromptDiff', () => {
  it('shows removed lines in red and added lines in green', () => {
    const result = formatPromptDiff('line one\nline two', 'line one\nline three')
    expect(result).toContain('line two')
    expect(result).toContain('line three')
    // Red for removed
    expect(result).toContain('\x1b[31m')
    // Green for added
    expect(result).toContain('\x1b[32m')
  })

  it('shows (line order changed) when same lines in different order', () => {
    const result = formatPromptDiff('a\nb', 'b\na')
    expect(result).toContain('line order changed')
  })

  it('handles undefined old prompt', () => {
    const result = formatPromptDiff(undefined, 'new prompt')
    expect(result).toContain('new prompt')
    expect(result).toContain('\x1b[32m')
  })

  it('handles undefined new prompt', () => {
    const result = formatPromptDiff('old prompt', undefined)
    expect(result).toContain('old prompt')
    expect(result).toContain('\x1b[31m')
  })

  it('truncates at 40 lines with summary', () => {
    const oldLines = Array.from({ length: 50 }, (_, i) => `old-${i}`).join('\n')
    const newLines = Array.from({ length: 50 }, (_, i) => `new-${i}`).join('\n')
    const result = formatPromptDiff(oldLines, newLines)
    expect(result).toContain('more lines')
  })
})

// ── formatSchemaDiff ──────────────────────────────────────────

describe('formatSchemaDiff', () => {
  it('shows added properties in green', () => {
    const result = formatSchemaDiff(
      'input_schema',
      { type: 'object', properties: {} },
      { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
    )
    expect(result).toContain('+ url: string')
    expect(result).toContain('\x1b[32m')
  })

  it('shows removed properties in red', () => {
    const result = formatSchemaDiff(
      'input_schema',
      { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      { type: 'object', properties: {} }
    )
    expect(result).toContain('- url: string')
    expect(result).toContain('\x1b[31m')
  })

  it('shows type changes as remove+add', () => {
    const result = formatSchemaDiff(
      'input_schema',
      { type: 'object', properties: { count: { type: 'number' } } },
      { type: 'object', properties: { count: { type: 'string' } } }
    )
    expect(result).toContain('- count')
    expect(result).toContain('number')
    expect(result).toContain('+ count')
    expect(result).toContain('string')
  })

  it('marks optional properties with ?', () => {
    const result = formatSchemaDiff(
      'input_schema',
      { type: 'object', properties: {} },
      { type: 'object', properties: { hint: { type: 'string' } } }
    )
    expect(result).toContain('hint?')
  })

  it('shows required→optional change', () => {
    const result = formatSchemaDiff(
      'input_schema',
      { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      { type: 'object', properties: { name: { type: 'string' } } }
    )
    expect(result).toContain('- name: string')
    expect(result).toContain('+ name?: string')
  })
})

// ── formatStringArrayDiff ─────────────────────────────────────

describe('formatStringArrayDiff', () => {
  it('shows added items in green', () => {
    const result = formatStringArrayDiff(['a'], ['a', 'b', 'c'])
    expect(result).toContain('+ b')
    expect(result).toContain('+ c')
    expect(result).toContain('\x1b[32m')
  })

  it('shows removed items in red', () => {
    const result = formatStringArrayDiff(['a', 'b', 'c'], ['a'])
    expect(result).toContain('- b')
    expect(result).toContain('- c')
    expect(result).toContain('\x1b[31m')
  })

  it('shows unchanged items dimmed', () => {
    const result = formatStringArrayDiff(['a', 'b'], ['a', 'c'])
    expect(result).toContain('- b')
    expect(result).toContain('+ c')
    // 'a' should be present as unchanged
    expect(result).toContain('a')
  })

  it('handles complete replacement', () => {
    const result = formatStringArrayDiff(['x', 'y'], ['a', 'b'])
    expect(result).toContain('- x')
    expect(result).toContain('- y')
    expect(result).toContain('+ a')
    expect(result).toContain('+ b')
  })

  it('handles empty old array', () => {
    const result = formatStringArrayDiff([], ['new-item'])
    expect(result).toContain('+ new-item')
  })

  it('handles empty new array', () => {
    const result = formatStringArrayDiff(['old-item'], [])
    expect(result).toContain('- old-item')
  })
})

// ── formatDependencyDiff ──────────────────────────────────────

describe('formatDependencyDiff', () => {
  it('shows added dependencies in green', () => {
    const result = formatDependencyDiff(
      [],
      [{ id: 'joe/scanner', version: 'v1' }]
    )
    expect(result).toContain('+ joe/scanner@v1')
    expect(result).toContain('\x1b[32m')
  })

  it('shows removed dependencies in red', () => {
    const result = formatDependencyDiff(
      [{ id: 'joe/scanner', version: 'v1' }],
      []
    )
    expect(result).toContain('- joe/scanner@v1')
    expect(result).toContain('\x1b[31m')
  })

  it('shows version changes inline', () => {
    const result = formatDependencyDiff(
      [{ id: 'joe/scanner', version: 'v1' }],
      [{ id: 'joe/scanner', version: 'v2' }]
    )
    expect(result).toContain('joe/scanner')
    expect(result).toContain('v1')
    expect(result).toContain('v2')
    // Arrow between versions
    expect(result).toContain('\u2192')
  })

  it('shows unchanged deps dimmed', () => {
    const result = formatDependencyDiff(
      [{ id: 'joe/scanner', version: 'v1' }, { id: 'joe/auditor', version: 'v1' }],
      [{ id: 'joe/scanner', version: 'v2' }, { id: 'joe/auditor', version: 'v1' }]
    )
    // auditor unchanged
    expect(result).toContain('joe/auditor@v1')
    // scanner changed
    expect(result).toContain('joe/scanner')
  })

  it('handles mixed add/remove/change', () => {
    const result = formatDependencyDiff(
      [{ id: 'joe/old-dep', version: 'v1' }, { id: 'joe/shared', version: 'v1' }],
      [{ id: 'joe/new-dep', version: 'v1' }, { id: 'joe/shared', version: 'v2' }]
    )
    expect(result).toContain('- joe/old-dep@v1')
    expect(result).toContain('+ joe/new-dep@v1')
    expect(result).toContain('joe/shared')
  })
})

// ── formatCustomToolDiff ──────────────────────────────────────

describe('formatCustomToolDiff', () => {
  it('shows added tools in green', () => {
    const result = formatCustomToolDiff(
      [],
      [{ name: 'scan', description: 'Run security scan' }]
    )
    expect(result).toContain('+ scan')
    expect(result).toContain('Run security scan')
    expect(result).toContain('\x1b[32m')
  })

  it('shows removed tools in red', () => {
    const result = formatCustomToolDiff(
      [{ name: 'old-tool' }],
      []
    )
    expect(result).toContain('- old-tool')
    expect(result).toContain('\x1b[31m')
  })

  it('shows property changes for modified tools', () => {
    const result = formatCustomToolDiff(
      [{ name: 'scan', description: 'Old desc', command: './old.sh' }],
      [{ name: 'scan', description: 'New desc', command: './new.sh' }]
    )
    const plain = stripAnsi(result)
    expect(plain).toContain('~ scan')
    expect(plain).toContain('Old desc')
    expect(plain).toContain('New desc')
    expect(plain).toContain('./old.sh')
    expect(plain).toContain('./new.sh')
  })

  it('shows unchanged tools dimmed', () => {
    const result = formatCustomToolDiff(
      [{ name: 'unchanged-tool', description: 'Same' }],
      [{ name: 'unchanged-tool', description: 'Same' }]
    )
    expect(result).toContain('unchanged-tool')
    // Should be dimmed (not red or green)
    expect(result).toContain('\x1b[2m')
  })

  it('handles tool with no description', () => {
    const result = formatCustomToolDiff(
      [],
      [{ name: 'bare-tool' }]
    )
    expect(result).toContain('+ bare-tool')
    // No description line
    expect(result.split('\n')).toHaveLength(1)
  })
})

// ── formatModelsDiff ──────────────────────────────────────────

describe('formatModelsDiff', () => {
  it('shows added providers in green', () => {
    const result = formatModelsDiff(
      { openai: 'gpt-4o' },
      { openai: 'gpt-4o', anthropic: 'claude-sonnet-4-6' }
    )
    expect(result).toContain('+ anthropic: claude-sonnet-4-6')
    expect(result).toContain('\x1b[32m')
  })

  it('shows removed providers in red', () => {
    const result = formatModelsDiff(
      { openai: 'gpt-4o', gemini: 'gemini-pro' },
      { openai: 'gpt-4o' }
    )
    expect(result).toContain('- gemini: gemini-pro')
    expect(result).toContain('\x1b[31m')
  })

  it('shows model changes inline', () => {
    const result = formatModelsDiff(
      { openai: 'gpt-4o' },
      { openai: 'gpt-5.2' }
    )
    expect(result).toContain('openai')
    expect(result).toContain('gpt-4o')
    expect(result).toContain('gpt-5.2')
    expect(result).toContain('\u2192')
  })

  it('handles undefined old', () => {
    const result = formatModelsDiff(undefined, { openai: 'gpt-4o' })
    expect(result).toContain('+ openai: gpt-4o')
  })

  it('handles undefined new', () => {
    const result = formatModelsDiff({ openai: 'gpt-4o' }, undefined)
    expect(result).toContain('- openai: gpt-4o')
  })
})

// ── printDiffs (integration) ──────────────────────────────────

describe('printDiffs', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
  })

  function getOutput(): string {
    return stdoutSpy.mock.calls.map(c => c[0]).join('')
  }

  it('shows header with arrow and thin separator', () => {
    printDiffs('org/agent@v1', 'org/agent@v2', [])
    const output = getOutput()
    expect(output).toContain('org/agent@v1')
    expect(output).toContain('org/agent@v2')
    expect(output).toContain('\u2192')
    // Thin line separator (not =====)
    expect(output).toContain('\u2500')
  })

  it('shows "No differences found" in green for identical versions', () => {
    printDiffs('org/agent@v1', 'org/agent@v2', [])
    const output = getOutput()
    expect(output).toContain('No differences found')
    expect(output).toContain('\x1b[32m')
  })

  it('shows change count', () => {
    const diffs: FieldDiff[] = [
      { field: 'type', kind: 'changed', old: 'prompt', new: 'agent' },
      { field: 'callable', kind: 'changed', old: false, new: true },
    ]
    printDiffs('org/agent@v1', 'org/agent@v2', diffs)
    expect(stripAnsi(getOutput())).toContain('2 changes')
  })

  it('shows singular "change" for 1 diff', () => {
    const diffs: FieldDiff[] = [
      { field: 'type', kind: 'changed', old: 'prompt', new: 'agent' },
    ]
    printDiffs('org/agent@v1', 'org/agent@v2', diffs)
    expect(stripAnsi(getOutput())).toContain('1 change')
    expect(stripAnsi(getOutput())).not.toContain('1 changes')
  })

  // ── Added fields: entire line green ──

  it('colors added scalar fields entirely green', () => {
    const diffs: FieldDiff[] = [
      { field: 'run_mode', kind: 'added', new: 'always_on' },
    ]
    printDiffs('org/agent@v1', 'org/agent@v2', diffs)
    const output = getOutput()
    expect(output).toContain('run_mode')
    expect(output).toContain('always_on')
    // Green ANSI
    expect(output).toContain('\x1b[32m')
  })

  // ── Removed fields: entire line red ──

  it('colors removed scalar fields entirely red', () => {
    const diffs: FieldDiff[] = [
      { field: 'source_url', kind: 'removed', old: 'https://example.com' },
    ]
    printDiffs('org/agent@v1', 'org/agent@v2', diffs)
    const output = getOutput()
    expect(output).toContain('source_url')
    expect(output).toContain('https://example.com')
    expect(output).toContain('\x1b[31m')
  })

  // ── Changed fields: red old, green new ──

  it('colors changed field with red old value and green new value', () => {
    const diffs: FieldDiff[] = [
      { field: 'type', kind: 'changed', old: 'prompt', new: 'agent' },
    ]
    printDiffs('org/agent@v1', 'org/agent@v2', diffs)
    const output = getOutput()
    expect(output).toContain('type')
    // Both values present
    expect(output).toContain('prompt')
    expect(output).toContain('agent')
    // Red and green ANSI codes
    expect(output).toContain('\x1b[31m')
    expect(output).toContain('\x1b[32m')
  })

  // ── String array diff uses item-level formatting ──

  it('uses item-level diff for string array changes', () => {
    const diffs: FieldDiff[] = [
      { field: 'tags', kind: 'changed', old: ['security', 'old'], new: ['security', 'new'] },
    ]
    printDiffs('org/agent@v1', 'org/agent@v2', diffs)
    const output = getOutput()
    expect(output).toContain('~ tags')
    expect(output).toContain('- old')
    expect(output).toContain('+ new')
  })

  // ── Dependency diff uses item-level formatting ──

  it('uses item-level diff for dependency changes', () => {
    const diffs: FieldDiff[] = [
      {
        field: 'dependencies',
        kind: 'changed',
        old: [{ id: 'joe/scanner', version: 'v1' }],
        new: [{ id: 'joe/scanner', version: 'v2' }],
      },
    ]
    printDiffs('org/agent@v1', 'org/agent@v2', diffs)
    const output = getOutput()
    expect(output).toContain('~ dependencies')
    expect(output).toContain('joe/scanner')
    expect(output).toContain('v1')
    expect(output).toContain('v2')
  })

  // ── Custom tools diff uses item-level formatting ──

  it('uses item-level diff for custom_tools changes', () => {
    const diffs: FieldDiff[] = [
      {
        field: 'custom_tools',
        kind: 'changed',
        old: [{ name: 'old-tool' }],
        new: [{ name: 'new-tool', description: 'A new tool' }],
      },
    ]
    printDiffs('org/agent@v1', 'org/agent@v2', diffs)
    const output = getOutput()
    expect(output).toContain('~ custom_tools')
    expect(output).toContain('- old-tool')
    expect(output).toContain('+ new-tool')
  })

  // ── Default models diff uses key-level formatting ──

  it('uses key-level diff for default_models changes', () => {
    const diffs: FieldDiff[] = [
      {
        field: 'default_models',
        kind: 'changed',
        old: { openai: 'gpt-4o' },
        new: { openai: 'gpt-5.2' },
      },
    ]
    printDiffs('org/agent@v1', 'org/agent@v2', diffs)
    const output = getOutput()
    expect(output).toContain('~ default_models')
    expect(output).toContain('openai')
    expect(output).toContain('gpt-4o')
    expect(output).toContain('gpt-5.2')
  })

  // ── Schema diff uses property-level formatting ──

  it('uses property-level diff for schema changes', () => {
    const diffs: FieldDiff[] = [
      {
        field: 'input_schema',
        kind: 'changed',
        old: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
        new: { type: 'object', properties: { url: { type: 'string' }, depth: { type: 'number' } }, required: ['url'] },
      },
    ]
    printDiffs('org/agent@v1', 'org/agent@v2', diffs)
    const output = getOutput()
    expect(output).toContain('~ input_schema')
    expect(output).toContain('+ depth')
  })

  // ── Prompt diff uses line-level formatting ──

  it('uses line-level diff for prompt changes', () => {
    const diffs: FieldDiff[] = [
      {
        field: 'prompt',
        kind: 'changed',
        old: 'You are a helper.\nBe concise.',
        new: 'You are a scanner.\nBe concise.',
      },
    ]
    printDiffs('org/agent@v1', 'org/agent@v2', diffs)
    const output = getOutput()
    expect(output).toContain('~ prompt')
    expect(output).toContain('- You are a helper.')
    expect(output).toContain('+ You are a scanner.')
  })

  // ── Multi-line values for added/removed ──

  it('colors each line of multi-line added values green', () => {
    const diffs: FieldDiff[] = [
      {
        field: 'dependencies',
        kind: 'added',
        new: [{ id: 'joe/scanner', version: 'v1' }],
      },
    ]
    printDiffs('org/agent@v1', 'org/agent@v2', diffs)
    const output = getOutput()
    expect(output).toContain('dependencies')
    expect(output).toContain('\x1b[32m')
  })

  it('colors each line of multi-line removed values red', () => {
    const diffs: FieldDiff[] = [
      {
        field: 'custom_tools',
        kind: 'removed',
        old: [{ name: 'scan', command: './scan.sh' }],
      },
    ]
    printDiffs('org/agent@v1', 'org/agent@v2', diffs)
    const output = getOutput()
    expect(output).toContain('custom_tools')
    expect(output).toContain('\x1b[31m')
  })

  // ── Mixed diffs ──

  it('handles mixed add/remove/change in a single diff output', () => {
    const diffs: FieldDiff[] = [
      { field: 'type', kind: 'changed', old: 'prompt', new: 'agent' },
      { field: 'run_mode', kind: 'added', new: 'always_on' },
      { field: 'source_url', kind: 'removed', old: 'https://old.com' },
      { field: 'tags', kind: 'changed', old: ['security'], new: ['security', 'tool'] },
    ]
    printDiffs('org/agent@v1', 'org/agent@v2', diffs)
    const output = getOutput()
    const plain = stripAnsi(output)
    expect(plain).toContain('4 changes')
    expect(plain).toContain('type')
    expect(plain).toContain('run_mode')
    expect(plain).toContain('source_url')
    expect(plain).toContain('tags')
  })
})
