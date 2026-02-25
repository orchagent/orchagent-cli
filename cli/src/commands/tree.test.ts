/**
 * Tests for tree command — BUG-11-03: orch tree 404 in team workspaces.
 *
 * Root cause: tree.ts didn't pass X-Workspace-Id header to request(),
 * so gateway used caller's personal org instead of workspace org for
 * agent lookup, returning 404 for agents in team workspaces.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

vi.mock('../lib/config', () => ({
  getResolvedConfig: vi.fn(),
  loadConfig: vi.fn().mockResolvedValue({}),
}))
vi.mock('../lib/api', () => ({
  request: vi.fn(),
  resolveWorkspaceIdForOrg: vi.fn(),
}))

import { registerTreeCommand } from './tree'
import { getResolvedConfig, loadConfig } from '../lib/config'
import { request, resolveWorkspaceIdForOrg } from '../lib/api'

const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockLoadConfig = vi.mocked(loadConfig)
const mockRequest = vi.mocked(request)
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
    mockRequest.mockResolvedValue(treeResponse)
  })

  afterEach(() => {
    consoleSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('sends X-Workspace-Id header when org resolves to a workspace', async () => {
    mockResolveWorkspaceIdForOrg.mockResolvedValue('ws-team-123')

    await program.parseAsync(['node', 'test', 'tree', 'team-org/my-agent@v1'])

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

  it('does not send X-Workspace-Id header for personal orgs', async () => {
    mockResolveWorkspaceIdForOrg.mockResolvedValue(undefined)

    await program.parseAsync(['node', 'test', 'tree', 'personal-org/my-agent@v1'])

    // When no workspace, request is called without an options argument
    expect(mockRequest).toHaveBeenCalledWith(
      expect.any(Object),
      'GET',
      '/agents/personal-org/my-agent/v1/tree',
    )
  })

  it('displays tree output correctly', async () => {
    mockResolveWorkspaceIdForOrg.mockResolvedValue(undefined)
    mockRequest.mockResolvedValue({
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
    mockResolveWorkspaceIdForOrg.mockResolvedValue(undefined)

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
    mockResolveWorkspaceIdForOrg.mockResolvedValue(undefined)

    await program.parseAsync(['node', 'test', 'tree', 'team-org/my-agent'])

    expect(mockRequest).toHaveBeenCalledWith(
      expect.any(Object),
      'GET',
      '/agents/team-org/my-agent/latest/tree',
    )
  })
})
