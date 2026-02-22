/**
 * Tests for the mock orchestration test runner.
 *
 * IDEA-002: orch test with mocked sub-agent responses.
 * Tests cover fixture validation, mock map handling, and edge cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// We only need to test validateMockedFixture (pure function) and related logic.
// The full runMockedAgentFixtureTests requires a real Python runtime + LLM key,
// so it's tested via integration tests / manual QA.

import { validateMockedFixture, type MockMap } from './test-mock-runner'

describe('validateMockedFixture', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
  })

  const customToolNames = ['scan_secrets', 'scan_deps', 'run_audit']

  it('validates a well-formed mocked fixture', () => {
    const data = {
      input: { code: 'print("hello")' },
      mocks: {
        scan_secrets: { findings: [] },
        scan_deps: { vulnerabilities: [] },
      },
      expected_contains: ['result'],
      description: 'Basic test',
    }

    const result = validateMockedFixture(data, 'tests/fixture-mock-basic.json', customToolNames)
    expect(result.input).toEqual({ code: 'print("hello")' })
    expect(result.mocks).toEqual(data.mocks)
    expect(result.expected_contains).toEqual(['result'])
    expect(result.description).toBe('Basic test')
  })

  it('validates fixture with expected_output instead of expected_contains', () => {
    const data = {
      input: { task: 'review' },
      mocks: { scan_secrets: { findings: [] } },
      expected_output: { status: 'clean' },
    }

    const result = validateMockedFixture(data, 'tests/fixture-mock.json', customToolNames)
    expect(result.expected_output).toEqual({ status: 'clean' })
  })

  it('validates fixture with both expected_output and expected_contains', () => {
    const data = {
      input: { task: 'review' },
      mocks: { scan_secrets: { findings: [] } },
      expected_output: { status: 'clean' },
      expected_contains: ['clean'],
    }

    const result = validateMockedFixture(data, 'tests/fixture.json', customToolNames)
    expect(result.expected_output).toBeDefined()
    expect(result.expected_contains).toBeDefined()
  })

  it('rejects non-object data', () => {
    expect(() =>
      validateMockedFixture('not an object', 'tests/fixture.json', customToolNames)
    ).toThrow('must be a JSON object')

    expect(() =>
      validateMockedFixture(null, 'tests/fixture.json', customToolNames)
    ).toThrow('must be a JSON object')

    expect(() =>
      validateMockedFixture(42, 'tests/fixture.json', customToolNames)
    ).toThrow('must be a JSON object')
  })

  it('rejects fixture without input field', () => {
    const data = {
      mocks: { scan_secrets: {} },
      expected_contains: ['result'],
    }

    expect(() =>
      validateMockedFixture(data, 'tests/fixture.json', customToolNames)
    ).toThrow('missing required "input" field')
  })

  it('rejects fixture with non-object input', () => {
    const data = {
      input: 'not an object',
      mocks: { scan_secrets: {} },
      expected_contains: ['result'],
    }

    expect(() =>
      validateMockedFixture(data, 'tests/fixture.json', customToolNames)
    ).toThrow('missing required "input" field')
  })

  it('rejects fixture without mocks field', () => {
    const data = {
      input: { code: 'test' },
      expected_contains: ['result'],
    }

    expect(() =>
      validateMockedFixture(data, 'tests/fixture.json', customToolNames)
    ).toThrow('"mocks" must be an object')
  })

  it('rejects fixture with array mocks', () => {
    const data = {
      input: { code: 'test' },
      mocks: [{ scan_secrets: {} }],
      expected_contains: ['result'],
    }

    expect(() =>
      validateMockedFixture(data, 'tests/fixture.json', customToolNames)
    ).toThrow('"mocks" must be an object')
  })

  it('rejects fixture without expected_output or expected_contains', () => {
    const data = {
      input: { code: 'test' },
      mocks: { scan_secrets: {} },
    }

    expect(() =>
      validateMockedFixture(data, 'tests/fixture.json', customToolNames)
    ).toThrow('must have "expected_output" or "expected_contains"')
  })

  it('warns about mock keys not matching custom tool names', () => {
    const data = {
      input: { code: 'test' },
      mocks: {
        scan_secrets: { findings: [] },
        unknown_tool: { result: 'mock' },
        another_unknown: { data: 'test' },
      },
      expected_contains: ['result'],
    }

    validateMockedFixture(data, 'tests/fixture.json', customToolNames)

    const allOutput = stderrSpy.mock.calls.map(c => c[0]).join('')
    expect(allOutput).toContain('unknown_tool')
    expect(allOutput).toContain('another_unknown')
    expect(allOutput).not.toContain('scan_secrets')
  })

  it('does not warn when all mock keys match custom tools', () => {
    const data = {
      input: { code: 'test' },
      mocks: {
        scan_secrets: { findings: [] },
        scan_deps: { vulnerabilities: [] },
      },
      expected_contains: ['result'],
    }

    validateMockedFixture(data, 'tests/fixture.json', customToolNames)

    const allOutput = stderrSpy.mock.calls.map(c => c[0]).join('')
    expect(allOutput).not.toContain('Warning')
  })

  it('handles empty mocks object', () => {
    const data = {
      input: { code: 'test' },
      mocks: {},
      expected_contains: ['result'],
    }

    const result = validateMockedFixture(data, 'tests/fixture.json', customToolNames)
    expect(result.mocks).toEqual({})
  })

  it('handles mock values of different types', () => {
    const data = {
      input: { task: 'test' },
      mocks: {
        scan_secrets: { findings: [1, 2, 3] },
        scan_deps: 'plain string response',
        run_audit: { nested: { deep: { value: true } } },
      },
      expected_contains: ['result'],
    }

    const result = validateMockedFixture(data, 'tests/fixture.json', customToolNames)
    expect(result.mocks.scan_secrets).toEqual({ findings: [1, 2, 3] })
    expect(result.mocks.scan_deps).toBe('plain string response')
    expect(result.mocks.run_audit).toEqual({ nested: { deep: { value: true } } })
  })

  it('preserves description field', () => {
    const data = {
      description: 'Test orchestrator with mocked scanner',
      input: { code: 'test' },
      mocks: { scan_secrets: {} },
      expected_contains: ['done'],
    }

    const result = validateMockedFixture(data, 'tests/fixture.json', customToolNames)
    expect(result.description).toBe('Test orchestrator with mocked scanner')
  })

  it('handles empty custom tool names list', () => {
    const data = {
      input: { code: 'test' },
      mocks: { some_tool: { data: 'mock' } },
      expected_contains: ['result'],
    }

    // All mock keys will be flagged as unknown since no custom tools exist
    validateMockedFixture(data, 'tests/fixture.json', [])

    const allOutput = stderrSpy.mock.calls.map(c => c[0]).join('')
    expect(allOutput).toContain('some_tool')
  })
})

describe('MockMap type', () => {
  it('accepts string values', () => {
    const mocks: MockMap = {
      tool_a: 'raw string response',
    }
    expect(typeof mocks.tool_a).toBe('string')
  })

  it('accepts object values', () => {
    const mocks: MockMap = {
      tool_a: { findings: [], status: 'ok' },
    }
    expect(typeof mocks.tool_a).toBe('object')
  })

  it('accepts mixed value types', () => {
    const mocks: MockMap = {
      tool_a: 'string response',
      tool_b: { structured: 'response' },
      tool_c: [1, 2, 3],
      tool_d: null,
      tool_e: 42,
    }
    expect(Object.keys(mocks)).toHaveLength(5)
  })
})
