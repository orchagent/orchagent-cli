/**
 * Tests for the info command.
 *
 * Bug 5: Verify that orch info works for server-only agents
 * by using public metadata endpoint instead of /download.
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
vi.mock('../lib/pricing', () => ({
  isPaidAgent: vi.fn().mockReturnValue(false),
  formatPrice: vi.fn().mockReturnValue('FREE'),
}))

import { registerInfoCommand } from './info'
import { getResolvedConfig } from '../lib/config'
import { getPublicAgent } from '../lib/api'

const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockGetPublicAgent = vi.mocked(getPublicAgent)

describe('Bug 5: orch info for server-only agents', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerInfoCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
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

  it('uses public metadata endpoint (not /download) for agent info', async () => {
    mockGetPublicAgent.mockResolvedValue({
      id: 'agent-123',
      org_name: 'OrchAgent',
      org_slug: 'orchagent',
      name: 'leak-finder',
      version: 'v1',
      type: 'tool',
      description: 'Finds API key leaks',
      supported_providers: ['any'],
      is_public: true,
      input_schema: {
        properties: { repo_url: { type: 'string', description: 'Repository URL' } },
        required: ['repo_url'],
      },
    } as any)

    await program.parseAsync(['node', 'test', 'info', 'orchagent/leak-finder'])

    // Should call getPublicAgent (metadata endpoint), NOT download endpoint
    expect(mockGetPublicAgent).toHaveBeenCalledWith(
      expect.any(Object),
      'orchagent',
      'leak-finder',
      'latest'
    )

    // Should display agent info
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('leak-finder'))
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Finds API key leaks'))
  })

  it('works for server-only agents (allow_local_download=false)', async () => {
    mockGetPublicAgent.mockResolvedValue({
      id: 'agent-456',
      org_name: 'OrchAgent',
      org_slug: 'orchagent',
      name: 'server-only-agent',
      version: 'v1',
      type: 'tool',
      description: 'A server-only agent',
      supported_providers: ['openai'],
      is_public: true,
      allow_local_download: false,
      pricing_mode: 'per_call',
      price_per_call_cents: 50,
    } as any)

    // Should NOT throw — previously this would fail with 403
    await program.parseAsync(['node', 'test', 'info', 'orchagent/server-only-agent'])

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('server-only-agent'))
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('A server-only agent'))
  })

  it('outputs JSON when --json is specified', async () => {
    mockGetPublicAgent.mockResolvedValue({
      id: 'agent-789',
      org_name: 'TestOrg',
      org_slug: 'testorg',
      name: 'json-agent',
      version: 'v1',
      type: 'prompt',
      description: 'A test agent',
      supported_providers: ['any'],
      is_public: true,
    } as any)

    await program.parseAsync(['node', 'test', 'info', 'testorg/json-agent', '--json'])

    // Should output valid JSON
    const jsonOutput = stdoutSpy.mock.calls.find(call =>
      call[0].toString().includes('"name"')
    )
    expect(jsonOutput).toBeTruthy()
    const parsed = JSON.parse(jsonOutput![0] as string)
    expect(parsed.name).toBe('json-agent')
    expect(parsed.type).toBe('prompt')
  })
})
