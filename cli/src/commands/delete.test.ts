/**
 * Tests for delete command.
 *
 * UX-11: Verify that dead marketplace references (stars, forks) are removed from output.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

vi.mock('../lib/config', () => ({
  getResolvedConfig: vi.fn().mockResolvedValue({
    apiKey: 'sk_test_123',
    apiUrl: 'https://api.test.com',
    defaultOrg: 'test-org',
  }),
  loadConfig: vi.fn().mockResolvedValue({}),
}))
vi.mock('../lib/api', () => ({
  listMyAgents: vi.fn(),
  checkAgentDelete: vi.fn(),
  deleteAgent: vi.fn(),
  resolveWorkspaceIdForOrg: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../lib/analytics', () => ({
  track: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../lib/agent-ref', () => ({
  parseAgentRef: vi.fn().mockReturnValue({ org: 'test-org', agent: 'my-agent', version: 'latest' }),
}))

import { registerDeleteCommand } from './delete'
import { listMyAgents, checkAgentDelete, deleteAgent, resolveWorkspaceIdForOrg } from '../lib/api'
import { getResolvedConfig } from '../lib/config'
import { parseAgentRef } from '../lib/agent-ref'

const mockListMyAgents = vi.mocked(listMyAgents)
const mockCheckAgentDelete = vi.mocked(checkAgentDelete)
const mockDeleteAgent = vi.mocked(deleteAgent)
const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockParseAgentRef = vi.mocked(parseAgentRef)
const mockResolveWorkspaceIdForOrg = vi.mocked(resolveWorkspaceIdForOrg)

describe('UX-11: Delete command — no marketplace references', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerDeleteCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })

    // Re-set mocks cleared by vi.clearAllMocks()
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'test-org',
    })
    mockParseAgentRef.mockReturnValue({ org: 'test-org', agent: 'my-agent', version: 'latest' })

    mockListMyAgents.mockResolvedValue([
      {
        id: 'agent-123',
        name: 'my-agent',
        version: 'v3',
        type: 'agent',
        created_at: '2026-02-01T00:00:00Z',
        org_slug: 'test-org',
      },
    ] as any)

    mockCheckAgentDelete.mockResolvedValue({
      agent_id: 'agent-123',
      agent_name: 'my-agent',
      requires_confirmation: false,
    } as any)

    mockDeleteAgent.mockResolvedValue({
      deleted: true,
      agent_id: 'agent-123',
      agent_name: 'my-agent',
    } as any)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    exitSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('does not display stars or forks in agent info output', async () => {
    // Even if the API returns stars_count/fork_count, CLI should not display them
    mockCheckAgentDelete.mockResolvedValue({
      agent_id: 'agent-123',
      agent_name: 'my-agent',
      stars_count: 5,
      fork_count: 3,
      requires_confirmation: false,
    } as any)

    await program.parseAsync(['node', 'test', 'delete', 'test-org/my-agent', '--yes'])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).not.toMatch(/[Ss]tars?:/)
    expect(output).not.toMatch(/[Ff]orks?:/)
  })

  it('does not display stars or forks in dry-run output', async () => {
    mockCheckAgentDelete.mockResolvedValue({
      agent_id: 'agent-123',
      agent_name: 'my-agent',
      stars_count: 10,
      fork_count: 7,
      requires_confirmation: false,
    } as any)

    await program.parseAsync(['node', 'test', 'delete', 'test-org/my-agent', '--dry-run'])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).not.toMatch(/[Ss]tars?/)
    expect(output).not.toMatch(/[Ff]orks?/)
  })

  it('still shows agent name and version in output', async () => {
    await program.parseAsync(['node', 'test', 'delete', 'test-org/my-agent', '--yes'])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain('my-agent')
    expect(output).toContain('v3')
  })

  it('still shows data retention notice in dry-run', async () => {
    await program.parseAsync(['node', 'test', 'delete', 'test-org/my-agent', '--dry-run'])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain('DRY RUN')
    expect(output).toContain('30 days')
  })
})

describe('BUG-9: Delete agent in team workspaces passes workspace header', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerDeleteCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })

    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'test-org',
    })
    mockParseAgentRef.mockReturnValue({ org: 'team-workspace', agent: 'my-agent', version: 'latest' })

    // Simulate team workspace resolution
    mockResolveWorkspaceIdForOrg.mockResolvedValue('ws_team_abc123')

    mockListMyAgents.mockResolvedValue([
      {
        id: 'agent-456',
        name: 'my-agent',
        version: 'v1',
        type: 'agent',
        created_at: '2026-02-20T00:00:00Z',
        org_slug: 'team-workspace',
      },
    ] as any)

    mockCheckAgentDelete.mockResolvedValue({
      agent_id: 'agent-456',
      agent_name: 'my-agent',
      requires_confirmation: false,
    } as any)

    mockDeleteAgent.mockResolvedValue({
      deleted: true,
      agent_id: 'agent-456',
      agent_name: 'my-agent',
    } as any)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    exitSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('passes workspaceId to checkAgentDelete', async () => {
    await program.parseAsync(['node', 'test', 'delete', 'team-workspace/my-agent', '--yes'])

    expect(mockCheckAgentDelete).toHaveBeenCalledWith(
      expect.anything(),
      'agent-456',
      'ws_team_abc123'
    )
  })

  it('passes workspaceId to deleteAgent', async () => {
    await program.parseAsync(['node', 'test', 'delete', 'team-workspace/my-agent', '--yes'])

    expect(mockDeleteAgent).toHaveBeenCalledWith(
      expect.anything(),
      'agent-456',
      undefined,
      'ws_team_abc123'
    )
  })

  it('passes workspaceId to listMyAgents', async () => {
    await program.parseAsync(['node', 'test', 'delete', 'team-workspace/my-agent', '--yes'])

    expect(mockListMyAgents).toHaveBeenCalledWith(
      expect.anything(),
      'ws_team_abc123'
    )
  })

  it('works without workspace (personal org)', async () => {
    mockResolveWorkspaceIdForOrg.mockResolvedValue(undefined)
    mockParseAgentRef.mockReturnValue({ org: 'test-org', agent: 'my-agent', version: 'latest' })
    mockListMyAgents.mockResolvedValue([
      {
        id: 'agent-789',
        name: 'my-agent',
        version: 'v2',
        type: 'agent',
        created_at: '2026-02-20T00:00:00Z',
        org_slug: 'test-org',
      },
    ] as any)
    mockCheckAgentDelete.mockResolvedValue({
      agent_id: 'agent-789',
      agent_name: 'my-agent',
      requires_confirmation: false,
    } as any)
    mockDeleteAgent.mockResolvedValue({
      deleted: true,
      agent_id: 'agent-789',
      agent_name: 'my-agent',
    } as any)

    await program.parseAsync(['node', 'test', 'delete', 'test-org/my-agent', '--yes'])

    // Without workspace, no workspaceId should be passed
    expect(mockCheckAgentDelete).toHaveBeenCalledWith(
      expect.anything(),
      'agent-789',
      undefined
    )
    expect(mockDeleteAgent).toHaveBeenCalledWith(
      expect.anything(),
      'agent-789',
      undefined,
      undefined
    )
  })
})
