/**
 * Tests for tree command — T12-04: orch tree 404 on cross-context agent lookups.
 *
 * Fix: public-first fallback pattern. Try public tree endpoint first (works
 * for any public agent regardless of caller context), then fall back to
 * authenticated endpoint with workspace header for private agents.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

vi.mock('../lib/config', () => ({
  getResolvedConfig: vi.fn(),
  loadConfig: vi.fn().mockResolvedValue({}),
}))
vi.mock('../lib/api', () => ({
  request: vi.fn(),
  publicRequest: vi.fn(),
  resolveWorkspaceIdForOrg: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.status = status
      this.name = 'ApiError'
    }
  },
}))

import { registerTreeCommand } from './tree'
import { getResolvedConfig, loadConfig } from '../lib/config'
import { request, publicRequest, resolveWorkspaceIdForOrg, ApiError } from '../lib/api'

const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockLoadConfig = vi.mocked(loadConfig)
const mockRequest = vi.mocked(request)
const mockPublicRequest = vi.mocked(publicRequest)
const mockResolveWorkspaceIdForOrg = vi.mocked(resolveWorkspaceIdForOrg)

const treeResponse = {
  agent: 'team-org/my-agent@v1',
  type: 'agent' as const,
  skills: [],
  skills_locked: false,
  dependencies: [],
  summary: {
    total_agents: 1,
    total_skills: 0,
    max_depth: 1,
    has_locked_skills: false,
  },
}

describe('orch tree', () => {
  let program: Command
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerTreeCommand(program)
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'test-org',
    })
    mockLoadConfig.mockResolvedValue({} as any)
    // Default: public succeeds (most common path)
    mockPublicRequest.mockResolvedValue(treeResponse)
  })

  afterEach(() => {
    consoleSpy.mockRestore()
    vi.restoreAllMocks()
  })

  // ------------------------------------------------------------------
  // Public-first fallback pattern (T12-04)
  // ------------------------------------------------------------------

  it('tries public endpoint first for cross-context public agents', async () => {
    mockPublicRequest.mockResolvedValue(treeResponse)

    await program.parseAsync(['node', 'test', 'tree', 'other-org/public-agent@v1'])

    expect(mockPublicRequest).toHaveBeenCalledWith(
      expect.any(Object),
      '/public/agents/other-org/public-agent/v1/tree',
    )
    // Authenticated endpoint should NOT be called when public succeeds
    expect(mockRequest).not.toHaveBeenCalled()
  })

  it('falls back to authenticated endpoint when public returns 404 (private agent)', async () => {
    mockPublicRequest.mockRejectedValue(new ApiError('Not found', 404))
    mockResolveWorkspaceIdForOrg.mockResolvedValue('ws-team-123')
    mockRequest.mockResolvedValue(treeResponse)

    await program.parseAsync(['node', 'test', 'tree', 'team-org/my-agent@v1'])

    // Public was tried first
    expect(mockPublicRequest).toHaveBeenCalledWith(
      expect.any(Object),
      '/public/agents/team-org/my-agent/v1/tree',
    )
    // Then authenticated with workspace header
    expect(mockResolveWorkspaceIdForOrg).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk_test_123' }),
      'team-org'
    )
    expect(mockRequest).toHaveBeenCalledWith(
      expect.any(Object),
      'GET',
      '/agents/team-org/my-agent/v1/tree',
      { headers: { 'X-Workspace-Id': 'ws-team-123' } }
    )
  })

  it('sends X-Workspace-Id header in fallback when org resolves to a workspace', async () => {
    mockPublicRequest.mockRejectedValue(new ApiError('Not found', 404))
    mockResolveWorkspaceIdForOrg.mockResolvedValue('ws-team-123')
    mockRequest.mockResolvedValue(treeResponse)

    await program.parseAsync(['node', 'test', 'tree', 'team-org/my-agent@v1'])

    expect(mockRequest).toHaveBeenCalledWith(
      expect.any(Object),
      'GET',
      '/agents/team-org/my-agent/v1/tree',
      { headers: { 'X-Workspace-Id': 'ws-team-123' } }
    )
  })

  it('does not send X-Workspace-Id for personal orgs in fallback', async () => {
    mockPublicRequest.mockRejectedValue(new ApiError('Not found', 404))
    mockResolveWorkspaceIdForOrg.mockResolvedValue(undefined)
    mockRequest.mockResolvedValue(treeResponse)

    await program.parseAsync(['node', 'test', 'tree', 'personal-org/my-agent@v1'])

    expect(mockRequest).toHaveBeenCalledWith(
      expect.any(Object),
      'GET',
      '/agents/personal-org/my-agent/v1/tree',
      undefined,
    )
  })

  it('propagates non-404 errors from public endpoint', async () => {
    mockPublicRequest.mockRejectedValue(new ApiError('Server error', 500))

    await expect(
      program.parseAsync(['node', 'test', 'tree', 'team-org/my-agent@v1'])
    ).rejects.toThrow('Server error')

    // Should NOT fall through to authenticated endpoint on 500
    expect(mockRequest).not.toHaveBeenCalled()
  })

  // ------------------------------------------------------------------
  // Display and formatting tests
  // ------------------------------------------------------------------

  it('displays tree output correctly', async () => {
    mockPublicRequest.mockResolvedValue({
      ...treeResponse,
      dependencies: [
        {
          agent: 'team-org/dep-tool@v2',
          accessible: true,
          type: 'tool',
          skills: [],
          skills_locked: false,
          dependencies: [],
        },
      ],
      summary: { total_agents: 2, total_skills: 0, max_depth: 2, has_locked_skills: false },
    })

    await program.parseAsync(['node', 'test', 'tree', 'team-org/my-agent@v1'])

    const output = consoleSpy.mock.calls.map(c => String(c[0] ?? '')).join('\n')
    expect(output).toContain('team-org/my-agent@v1')
    expect(output).toContain('team-org/dep-tool@v2')
    expect(output).toContain('2 agents')
  })

  it('outputs JSON when --json is specified', async () => {
    mockPublicRequest.mockResolvedValue(treeResponse)

    await program.parseAsync(['node', 'test', 'tree', 'team-org/my-agent@v1', '--json'])

    const jsonCall = consoleSpy.mock.calls.find(c => {
      try { JSON.parse(String(c[0])); return true } catch { return false }
    })
    expect(jsonCall).toBeDefined()
    const parsed = JSON.parse(String(jsonCall![0]))
    expect(parsed.agent).toBe('team-org/my-agent@v1')
    expect(parsed.summary.total_agents).toBe(1)
  })

  it('defaults version to latest when not specified', async () => {
    mockPublicRequest.mockResolvedValue(treeResponse)

    await program.parseAsync(['node', 'test', 'tree', 'team-org/my-agent'])

    expect(mockPublicRequest).toHaveBeenCalledWith(
      expect.any(Object),
      '/public/agents/team-org/my-agent/latest/tree',
    )
  })
})
