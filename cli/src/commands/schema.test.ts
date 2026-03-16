import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

vi.mock('../lib/config', () => ({
  getResolvedConfig: vi.fn(),
  loadConfig: vi.fn().mockResolvedValue({}),
}))
vi.mock('../lib/api', () => {
  const ApiError = class extends Error {
    status: number
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

import { registerSchemaCommand } from './schema'
import { getResolvedConfig, loadConfig } from '../lib/config'
import { getPublicAgent } from '../lib/api'

const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockGetPublicAgent = vi.mocked(getPublicAgent)
const mockLoadConfig = vi.mocked(loadConfig)

function parseStdout(spy: ReturnType<typeof vi.spyOn>): unknown {
  const raw = spy.mock.calls.map(c => c[0]).join('')
  return JSON.parse(raw)
}

describe('orch schema command', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerSchemaCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockLoadConfig.mockResolvedValue({})
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'test-org',
    })
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  const agentWithSchemas = {
    id: 'agent-1',
    org_name: 'Joe',
    org_slug: 'joe',
    name: 'scanner',
    version: 'v3',
    type: 'agent',
    description: 'Security scanner',
    supported_providers: ['anthropic'],
    callable: true,
    input_schema: {
      type: 'object',
      properties: {
        repo_url: { type: 'string', description: 'GitHub repo to scan' },
      },
      required: ['repo_url'],
    },
    output_schema: {
      type: 'object',
      properties: {
        findings: { type: 'array' },
        summary: { type: 'object' },
      },
    },
    required_secrets: ['GITHUB_TOKEN'],
    optional_secrets: ['SLACK_WEBHOOK'],
    default_skills: ['joe/vuln-db@v1'],
    manifest: {
      dependencies: [{ id: 'joe/sub-tool', version: 'v2' }],
      custom_tools: [{ name: 'run_scan', description: 'Run security scan' }],
      environment: { python_version: '3.12' },
    },
  } as any

  it('outputs both schemas by default', async () => {
    mockGetPublicAgent.mockResolvedValue(agentWithSchemas)

    await program.parseAsync(['node', 'test', 'schema', 'joe/scanner@v3'])

    const result = parseStdout(stdoutSpy) as any
    expect(result.agent).toBe('joe/scanner@v3')
    expect(result.type).toBe('agent')
    expect(result.input_schema.properties.repo_url).toBeDefined()
    expect(result.output_schema.properties.findings).toBeDefined()
  })

  it('outputs only input schema with --input-only', async () => {
    mockGetPublicAgent.mockResolvedValue(agentWithSchemas)

    await program.parseAsync(['node', 'test', 'schema', 'joe/scanner@v3', '--input-only'])

    const result = parseStdout(stdoutSpy) as any
    expect(result.properties.repo_url).toBeDefined()
    expect(result.required).toEqual(['repo_url'])
    // Should not have agent/type wrapper
    expect(result.agent).toBeUndefined()
  })

  it('outputs only output schema with --output-only', async () => {
    mockGetPublicAgent.mockResolvedValue(agentWithSchemas)

    await program.parseAsync(['node', 'test', 'schema', 'joe/scanner@v3', '--output-only'])

    const result = parseStdout(stdoutSpy) as any
    expect(result.properties.findings).toBeDefined()
    expect(result.properties.summary).toBeDefined()
    expect(result.agent).toBeUndefined()
  })

  it('outputs full spec with --full', async () => {
    mockGetPublicAgent.mockResolvedValue(agentWithSchemas)

    await program.parseAsync(['node', 'test', 'schema', 'joe/scanner@v3', '--full'])

    const result = parseStdout(stdoutSpy) as any
    expect(result.agent).toBe('joe/scanner@v3')
    expect(result.type).toBe('agent')
    expect(result.callable).toBe(true)
    expect(result.supported_providers).toEqual(['anthropic'])
    expect(result.description).toBe('Security scanner')
    expect(result.input_schema.properties.repo_url).toBeDefined()
    expect(result.output_schema.properties.findings).toBeDefined()
    expect(result.required_secrets).toEqual(['GITHUB_TOKEN'])
    expect(result.optional_secrets).toEqual(['SLACK_WEBHOOK'])
    expect(result.dependencies).toEqual([{ id: 'joe/sub-tool', version: 'v2' }])
    expect(result.default_skills).toEqual(['joe/vuln-db@v1'])
    expect(result.custom_tools).toEqual([{ name: 'run_scan', description: 'Run security scan' }])
    expect(result.environment).toEqual({ python_version: '3.12' })
  })

  it('returns empty objects when schemas are missing', async () => {
    mockGetPublicAgent.mockResolvedValue({
      id: 'agent-2',
      org_name: 'Joe',
      org_slug: 'joe',
      name: 'simple',
      version: 'v1',
      type: 'prompt',
      supported_providers: ['any'],
    } as any)

    await program.parseAsync(['node', 'test', 'schema', 'joe/simple'])

    const result = parseStdout(stdoutSpy) as any
    expect(result.agent).toBe('joe/simple@v1')
    expect(result.input_schema).toEqual({})
    expect(result.output_schema).toEqual({})
  })

  it('--input-only returns empty object when no schema', async () => {
    mockGetPublicAgent.mockResolvedValue({
      id: 'agent-3',
      org_name: 'Joe',
      org_slug: 'joe',
      name: 'no-schema',
      version: 'v1',
      type: 'prompt',
      supported_providers: ['any'],
    } as any)

    await program.parseAsync(['node', 'test', 'schema', 'joe/no-schema', '--input-only'])

    const result = parseStdout(stdoutSpy) as any
    expect(result).toEqual({})
  })

  it('--full omits empty optional fields', async () => {
    mockGetPublicAgent.mockResolvedValue({
      id: 'agent-4',
      org_name: 'Joe',
      org_slug: 'joe',
      name: 'minimal',
      version: 'v1',
      type: 'prompt',
      supported_providers: ['any'],
    } as any)

    await program.parseAsync(['node', 'test', 'schema', 'joe/minimal', '--full'])

    const result = parseStdout(stdoutSpy) as any
    expect(result.agent).toBe('joe/minimal@v1')
    expect(result.required_secrets).toBeUndefined()
    expect(result.optional_secrets).toBeUndefined()
    expect(result.dependencies).toBeUndefined()
    expect(result.default_skills).toBeUndefined()
    expect(result.custom_tools).toBeUndefined()
    expect(result.environment).toBeUndefined()
    expect(result.description).toBeUndefined()
  })

  it('resolves "latest" version from API response', async () => {
    mockGetPublicAgent.mockResolvedValue({
      id: 'agent-5',
      org_name: 'Joe',
      org_slug: 'joe',
      name: 'versioned',
      version: 'v7',
      type: 'tool',
      supported_providers: ['any'],
      input_schema: { type: 'object', properties: { url: { type: 'string' } } },
    } as any)

    await program.parseAsync(['node', 'test', 'schema', 'joe/versioned'])

    const result = parseStdout(stdoutSpy) as any
    expect(result.agent).toBe('joe/versioned@v7')
  })

  it('uses default org from config when not specified', async () => {
    mockGetPublicAgent.mockResolvedValue({
      id: 'agent-6',
      org_name: 'TestOrg',
      org_slug: 'test-org',
      name: 'my-agent',
      version: 'v1',
      type: 'prompt',
      supported_providers: ['any'],
    } as any)

    await program.parseAsync(['node', 'test', 'schema', 'my-agent'])

    expect(mockGetPublicAgent).toHaveBeenCalledWith(
      expect.any(Object),
      'test-org',
      'my-agent',
      'latest'
    )
  })

  it('output is valid JSON (parseable by agents)', async () => {
    mockGetPublicAgent.mockResolvedValue(agentWithSchemas)

    await program.parseAsync(['node', 'test', 'schema', 'joe/scanner@v3'])

    const raw = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(() => JSON.parse(raw)).not.toThrow()
  })
})
