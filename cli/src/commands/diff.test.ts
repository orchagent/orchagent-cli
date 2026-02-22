/**
 * Tests for the diff command (IDEA-008).
 *
 * Covers: happy path, version shorthand, JSON output, identical versions,
 * error handling, prompt diff, schema diff, array diff, edge cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

vi.mock('../lib/config', () => ({
  getResolvedConfig: vi.fn(),
}))
vi.mock('../lib/api', () => {
  const ApiError = class extends Error {
    status: number
    payload: unknown
    constructor(message: string, status: number) {
      super(message)
      this.status = status
    }
  }
  return {
    ApiError,
    getOrg: vi.fn(),
    listMyAgents: vi.fn(),
    getPublicAgent: vi.fn(),
    resolveWorkspaceIdForOrg: vi.fn().mockResolvedValue(undefined),
  }
})
vi.mock('../lib/spinner', () => ({
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
}))

import { registerDiffCommand, computeDiffs } from './diff'
import { getResolvedConfig } from '../lib/config'
import { getPublicAgent, listMyAgents, getOrg, resolveWorkspaceIdForOrg } from '../lib/api'

const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockGetPublicAgent = vi.mocked(getPublicAgent)
const mockListMyAgents = vi.mocked(listMyAgents)
const mockGetOrg = vi.mocked(getOrg)
const mockResolveWorkspaceIdForOrg = vi.mocked(resolveWorkspaceIdForOrg)

function makePublicAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-1',
    org_name: 'TestOrg',
    org_slug: 'testorg',
    name: 'my-agent',
    version: 'v1',
    type: 'prompt',
    description: 'A test agent',
    callable: false,
    supported_providers: ['any'],
    tags: [],
    input_schema: undefined,
    output_schema: undefined,
    ...overrides,
  } as any
}

describe('orch diff command', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerDiffCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'testorg',
    })
    mockResolveWorkspaceIdForOrg.mockResolvedValue(undefined)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  // ── Happy path ──

  it('shows differences between two versions', async () => {
    mockGetPublicAgent
      .mockResolvedValueOnce(makePublicAgent({
        version: 'v1',
        description: 'Version 1',
        type: 'prompt',
      }))
      .mockResolvedValueOnce(makePublicAgent({
        version: 'v2',
        description: 'Version 2',
        type: 'agent',
      }))

    await program.parseAsync(['node', 'test', 'diff', 'testorg/my-agent@v1', 'v2'])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain('v1')
    expect(output).toContain('v2')
    expect(output).toContain('description')
    expect(output).toContain('type')
  })

  it('shows no differences for identical versions', async () => {
    const agent = makePublicAgent({ version: 'v1' })
    mockGetPublicAgent
      .mockResolvedValueOnce(agent)
      .mockResolvedValueOnce(makePublicAgent({ ...agent, version: 'v2' }))

    await program.parseAsync(['node', 'test', 'diff', 'testorg/my-agent@v1', 'v2'])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain('No differences found')
  })

  it('supports full ref for second argument', async () => {
    mockGetPublicAgent
      .mockResolvedValueOnce(makePublicAgent({ version: 'v1' }))
      .mockResolvedValueOnce(makePublicAgent({
        version: 'v1',
        org_slug: 'other',
        name: 'other-agent',
      }))

    await program.parseAsync(['node', 'test', 'diff', 'testorg/my-agent@v1', 'other/other-agent@v1'])

    expect(mockGetPublicAgent).toHaveBeenCalledTimes(2)
    expect(mockGetPublicAgent).toHaveBeenCalledWith(
      expect.any(Object), 'testorg', 'my-agent', 'v1'
    )
    expect(mockGetPublicAgent).toHaveBeenCalledWith(
      expect.any(Object), 'other', 'other-agent', 'v1'
    )
  })

  it('defaults second ref to latest when only one ref given', async () => {
    mockGetPublicAgent
      .mockResolvedValueOnce(makePublicAgent({ version: 'v1' }))
      .mockResolvedValueOnce(makePublicAgent({ version: 'v3' }))

    await program.parseAsync(['node', 'test', 'diff', 'testorg/my-agent@v1'])

    expect(mockGetPublicAgent).toHaveBeenCalledWith(
      expect.any(Object), 'testorg', 'my-agent', 'latest'
    )
  })

  // ── JSON output ──

  it('outputs JSON with --json flag', async () => {
    mockGetPublicAgent
      .mockResolvedValueOnce(makePublicAgent({
        version: 'v1',
        type: 'prompt',
      }))
      .mockResolvedValueOnce(makePublicAgent({
        version: 'v2',
        type: 'agent',
      }))

    await program.parseAsync(['node', 'test', 'diff', 'testorg/my-agent@v1', 'v2', '--json'])

    const jsonCall = stdoutSpy.mock.calls.find(c =>
      c[0].toString().includes('"from"')
    )
    expect(jsonCall).toBeTruthy()
    const parsed = JSON.parse(jsonCall![0] as string)
    expect(parsed.from).toBe('testorg/my-agent@v1')
    expect(parsed.to).toBe('testorg/my-agent@v2')
    expect(parsed.identical).toBe(false)
    expect(parsed.changes).toBeInstanceOf(Array)
    expect(parsed.changes.length).toBeGreaterThan(0)
  })

  it('outputs identical=true in JSON when no changes', async () => {
    const agent = makePublicAgent({ version: 'v1' })
    mockGetPublicAgent
      .mockResolvedValueOnce(agent)
      .mockResolvedValueOnce(makePublicAgent({ ...agent, version: 'v2' }))

    await program.parseAsync(['node', 'test', 'diff', 'testorg/my-agent@v1', 'v2', '--json'])

    const jsonCall = stdoutSpy.mock.calls.find(c =>
      c[0].toString().includes('"identical"')
    )
    const parsed = JSON.parse(jsonCall![0] as string)
    expect(parsed.identical).toBe(true)
    expect(parsed.changes).toEqual([])
  })

  // ── Error handling ──

  it('errors when single ref has no version', async () => {
    await expect(
      program.parseAsync(['node', 'test', 'diff', 'testorg/my-agent'])
    ).rejects.toThrow('Two versions are required')
  })

  it('falls back to authenticated endpoint for private agents', async () => {
    const { ApiError } = await import('../lib/api')
    mockGetPublicAgent.mockRejectedValue(new ApiError('Not found', 404))
    mockGetOrg.mockResolvedValue({
      id: 'org-1',
      name: 'TestOrg',
      slug: 'testorg',
      created_at: '2024-01-01',
    })
    mockListMyAgents.mockResolvedValue([
      {
        id: 'a1',
        name: 'my-agent',
        version: 'v1',
        type: 'prompt',
        created_at: '2024-01-01',
        description: 'Private v1',
        callable: false,
        supported_providers: ['any'],
        tags: [],
        prompt: 'Hello v1',
      } as any,
      {
        id: 'a2',
        name: 'my-agent',
        version: 'v2',
        type: 'prompt',
        created_at: '2024-01-02',
        description: 'Private v2',
        callable: true,
        supported_providers: ['any'],
        tags: [],
        prompt: 'Hello v2',
      } as any,
    ])

    await program.parseAsync(['node', 'test', 'diff', 'testorg/my-agent@v1', 'v2'])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain('description')
    expect(output).toContain('callable')
    expect(output).toContain('prompt')
  })
})

// ── Unit tests for computeDiffs ──

describe('computeDiffs', () => {
  function makeSnapshot(overrides: Record<string, unknown> = {}) {
    return {
      org: 'testorg',
      name: 'my-agent',
      version: 'v1',
      type: 'prompt',
      description: 'A test agent',
      callable: false,
      run_mode: null,
      execution_engine: null,
      supported_providers: ['any'],
      tags: [],
      input_schema: undefined,
      output_schema: undefined,
      dependencies: [],
      default_skills: [],
      custom_tools: [],
      required_secrets: [],
      ...overrides,
    } as any
  }

  it('returns empty array for identical snapshots', () => {
    const a = makeSnapshot()
    const b = makeSnapshot({ version: 'v2' })
    expect(computeDiffs(a, b)).toEqual([])
  })

  it('detects type change', () => {
    const a = makeSnapshot({ type: 'prompt' })
    const b = makeSnapshot({ type: 'agent' })
    const diffs = computeDiffs(a, b)
    expect(diffs).toHaveLength(1)
    expect(diffs[0]).toEqual({ field: 'type', kind: 'changed', old: 'prompt', new: 'agent' })
  })

  it('detects description change', () => {
    const a = makeSnapshot({ description: 'old desc' })
    const b = makeSnapshot({ description: 'new desc' })
    const diffs = computeDiffs(a, b)
    expect(diffs.find(d => d.field === 'description')).toEqual({
      field: 'description', kind: 'changed', old: 'old desc', new: 'new desc',
    })
  })

  it('detects description added', () => {
    const a = makeSnapshot({ description: undefined })
    const b = makeSnapshot({ description: 'added desc' })
    const diffs = computeDiffs(a, b)
    expect(diffs.find(d => d.field === 'description')).toEqual({
      field: 'description', kind: 'added', new: 'added desc',
    })
  })

  it('detects description removed', () => {
    const a = makeSnapshot({ description: 'removed desc' })
    const b = makeSnapshot({ description: undefined })
    const diffs = computeDiffs(a, b)
    expect(diffs.find(d => d.field === 'description')).toEqual({
      field: 'description', kind: 'removed', old: 'removed desc',
    })
  })

  it('detects callable change', () => {
    const a = makeSnapshot({ callable: false })
    const b = makeSnapshot({ callable: true })
    const diffs = computeDiffs(a, b)
    expect(diffs.find(d => d.field === 'callable')).toEqual({
      field: 'callable', kind: 'changed', old: false, new: true,
    })
  })

  it('detects supported_providers change', () => {
    const a = makeSnapshot({ supported_providers: ['any'] })
    const b = makeSnapshot({ supported_providers: ['openai', 'anthropic'] })
    const diffs = computeDiffs(a, b)
    expect(diffs.find(d => d.field === 'supported_providers')).toEqual({
      field: 'supported_providers', kind: 'changed',
      old: ['any'], new: ['openai', 'anthropic'],
    })
  })

  it('detects tags added', () => {
    const a = makeSnapshot({ tags: [] })
    const b = makeSnapshot({ tags: ['security', 'tool'] })
    const diffs = computeDiffs(a, b)
    expect(diffs.find(d => d.field === 'tags')).toEqual({
      field: 'tags', kind: 'added', new: ['security', 'tool'],
    })
  })

  it('detects input_schema change', () => {
    const oldSchema = {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    }
    const newSchema = {
      type: 'object',
      properties: { url: { type: 'string' }, depth: { type: 'number' } },
      required: ['url'],
    }
    const a = makeSnapshot({ input_schema: oldSchema })
    const b = makeSnapshot({ input_schema: newSchema })
    const diffs = computeDiffs(a, b)
    expect(diffs.find(d => d.field === 'input_schema')).toBeTruthy()
    expect(diffs.find(d => d.field === 'input_schema')!.kind).toBe('changed')
  })

  it('detects dependencies change', () => {
    const a = makeSnapshot({ dependencies: [{ id: 'joe/scanner', version: 'v1' }] })
    const b = makeSnapshot({ dependencies: [{ id: 'joe/scanner', version: 'v2' }] })
    const diffs = computeDiffs(a, b)
    expect(diffs.find(d => d.field === 'dependencies')).toEqual({
      field: 'dependencies', kind: 'changed',
      old: [{ id: 'joe/scanner', version: 'v1' }],
      new: [{ id: 'joe/scanner', version: 'v2' }],
    })
  })

  it('detects custom_tools added', () => {
    const a = makeSnapshot({ custom_tools: [] })
    const b = makeSnapshot({ custom_tools: [{ name: 'scan', description: 'Run scan', command: './scan.sh' }] })
    const diffs = computeDiffs(a, b)
    expect(diffs.find(d => d.field === 'custom_tools')).toEqual({
      field: 'custom_tools', kind: 'added',
      new: [{ name: 'scan', description: 'Run scan', command: './scan.sh' }],
    })
  })

  it('detects prompt change', () => {
    const a = makeSnapshot({ prompt: 'You are a helpful assistant.' })
    const b = makeSnapshot({ prompt: 'You are a security scanner.' })
    const diffs = computeDiffs(a, b)
    expect(diffs.find(d => d.field === 'prompt')).toEqual({
      field: 'prompt', kind: 'changed',
      old: 'You are a helpful assistant.',
      new: 'You are a security scanner.',
    })
  })

  it('does not diff prompt when both are undefined (public agents)', () => {
    const a = makeSnapshot({ prompt: undefined })
    const b = makeSnapshot({ prompt: undefined })
    const diffs = computeDiffs(a, b)
    expect(diffs.find(d => d.field === 'prompt')).toBeUndefined()
  })

  it('detects multiple changes at once', () => {
    const a = makeSnapshot({
      type: 'prompt',
      description: 'Old',
      callable: false,
      supported_providers: ['any'],
    })
    const b = makeSnapshot({
      type: 'agent',
      description: 'New',
      callable: true,
      supported_providers: ['openai'],
    })
    const diffs = computeDiffs(a, b)
    expect(diffs.length).toBe(4) // type, description, callable, supported_providers
  })

  it('detects run_mode change', () => {
    const a = makeSnapshot({ run_mode: null })
    const b = makeSnapshot({ run_mode: 'always_on' })
    const diffs = computeDiffs(a, b)
    expect(diffs.find(d => d.field === 'run_mode')).toEqual({
      field: 'run_mode', kind: 'added', new: 'always_on',
    })
  })

  it('detects execution_engine change', () => {
    const a = makeSnapshot({ execution_engine: 'direct_llm' })
    const b = makeSnapshot({ execution_engine: 'managed_loop' })
    const diffs = computeDiffs(a, b)
    expect(diffs.find(d => d.field === 'execution_engine')).toEqual({
      field: 'execution_engine', kind: 'changed',
      old: 'direct_llm', new: 'managed_loop',
    })
  })

  it('detects required_secrets change', () => {
    const a = makeSnapshot({ required_secrets: [] })
    const b = makeSnapshot({ required_secrets: ['GITHUB_TOKEN', 'OPENAI_KEY'] })
    const diffs = computeDiffs(a, b)
    expect(diffs.find(d => d.field === 'required_secrets')).toEqual({
      field: 'required_secrets', kind: 'added',
      new: ['GITHUB_TOKEN', 'OPENAI_KEY'],
    })
  })

  it('detects default_skills removed', () => {
    const a = makeSnapshot({ default_skills: ['joe/scan-rules'] })
    const b = makeSnapshot({ default_skills: [] })
    const diffs = computeDiffs(a, b)
    expect(diffs.find(d => d.field === 'default_skills')).toEqual({
      field: 'default_skills', kind: 'removed',
      old: ['joe/scan-rules'],
    })
  })

  it('detects timeout_seconds change', () => {
    const a = makeSnapshot({ timeout_seconds: 60 })
    const b = makeSnapshot({ timeout_seconds: 120 })
    const diffs = computeDiffs(a, b)
    expect(diffs.find(d => d.field === 'timeout_seconds')).toEqual({
      field: 'timeout_seconds', kind: 'changed', old: 60, new: 120,
    })
  })

  it('detects max_turns change', () => {
    const a = makeSnapshot({ max_turns: undefined })
    const b = makeSnapshot({ max_turns: 10 })
    const diffs = computeDiffs(a, b)
    expect(diffs.find(d => d.field === 'max_turns')).toEqual({
      field: 'max_turns', kind: 'added', new: 10,
    })
  })

  it('detects output_schema added', () => {
    const schema = {
      type: 'object',
      properties: { result: { type: 'string' } },
    }
    const a = makeSnapshot({ output_schema: undefined })
    const b = makeSnapshot({ output_schema: schema })
    const diffs = computeDiffs(a, b)
    expect(diffs.find(d => d.field === 'output_schema')).toEqual({
      field: 'output_schema', kind: 'added', new: schema,
    })
  })

  it('detects default_models change', () => {
    const a = makeSnapshot({ default_models: { openai: 'gpt-4o' } })
    const b = makeSnapshot({ default_models: { openai: 'gpt-4o', anthropic: 'claude-sonnet-4-6' } })
    const diffs = computeDiffs(a, b)
    expect(diffs.find(d => d.field === 'default_models')).toBeTruthy()
    expect(diffs.find(d => d.field === 'default_models')!.kind).toBe('changed')
  })
})
