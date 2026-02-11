/**
 * Tests for the transfer command.
 *
 * Tests cover:
 * - Agent name and workspace slug parsing
 * - Dry-run output without API calls
 * - Blocker handling (exit code 1)
 * - Confirmation prompt (name mismatch rejection)
 * - --yes flag skips confirmation
 * - --json outputs structured JSON
 * - Error handling for missing agent/workspace
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

vi.mock('../lib/config')
vi.mock('../lib/api')
vi.mock('../lib/analytics')
vi.mock('../lib/output')
vi.mock('readline/promises')

import { registerTransferCommand } from './transfer'
import { getResolvedConfig } from '../lib/config'
import { request, listMyAgents, checkAgentTransfer, transferAgent } from '../lib/api'
import { track } from '../lib/analytics'
import { printJson } from '../lib/output'
import readline from 'readline/promises'

const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockRequest = vi.mocked(request)
const mockListMyAgents = vi.mocked(listMyAgents)
const mockCheckAgentTransfer = vi.mocked(checkAgentTransfer)
const mockTransferAgent = vi.mocked(transferAgent)
const mockTrack = vi.mocked(track)
const mockPrintJson = vi.mocked(printJson)
const mockReadline = vi.mocked(readline)

const mockWorkspaces = {
  workspaces: [
    { id: 'ws-1', name: 'My Workspace', slug: 'my-ws', type: 'personal', role: 'owner', member_count: 1 },
    { id: 'ws-2', name: 'Team Workspace', slug: 'team-ws', type: 'team', role: 'member', member_count: 5 },
  ],
}

const mockAgents = [
  {
    id: 'agent-1',
    name: 'my-agent',
    version: 'v2',
    org_id: 'ws-1',
    created_at: '2026-02-10T00:00:00Z',
  },
  {
    id: 'agent-1-v1',
    name: 'my-agent',
    version: 'v1',
    org_id: 'ws-1',
    created_at: '2026-02-09T00:00:00Z',
  },
]

const mockCheckResult = {
  can_transfer: true,
  blockers: [],
  warnings: ['1 active grant(s) will be revoked'],
  details: {
    version_count: 2,
    grants_count: 1,
    keys_count: 0,
    schedules_count: 0,
  },
}

const mockTransferResult = {
  transfer_id: 'transfer-123',
  agent_name: 'my-agent',
  versions_transferred: 2,
  source_workspace: { id: 'ws-1', slug: 'my-ws', name: 'My Workspace' },
  target_workspace: { id: 'ws-2', slug: 'team-ws', name: 'Team Workspace' },
  cleanup: { grants_revoked: 1, keys_deleted: 0, schedules_disabled: 0 },
}

describe('transfer command', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()

    program = new Command()
    program.exitOverride()
    registerTransferCommand(program)

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as any)

    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
    })

    mockRequest.mockResolvedValue(mockWorkspaces)
    mockListMyAgents.mockResolvedValue(mockAgents as any)
    mockCheckAgentTransfer.mockResolvedValue(mockCheckResult as any)
    mockTransferAgent.mockResolvedValue(mockTransferResult as any)
    mockTrack.mockResolvedValue(undefined)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    exitSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('requires --to flag', async () => {
    await expect(
      program.parseAsync(['node', 'test', 'transfer', 'my-agent'])
    ).rejects.toThrow()
  })

  it('throws when not logged in', async () => {
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: '',
      apiUrl: 'https://api.test.com',
    })

    await expect(
      program.parseAsync(['node', 'test', 'transfer', 'my-agent', '--to', 'team-ws'])
    ).rejects.toThrow('Not logged in')
  })

  it('throws when target workspace not found', async () => {
    await expect(
      program.parseAsync(['node', 'test', 'transfer', 'my-agent', '--to', 'nonexistent-ws'])
    ).rejects.toThrow("Workspace 'nonexistent-ws' not found")
  })

  it('throws when agent not found', async () => {
    mockListMyAgents.mockResolvedValue([])

    await expect(
      program.parseAsync(['node', 'test', 'transfer', 'my-agent', '--to', 'team-ws'])
    ).rejects.toThrow("Agent 'my-agent' not found")
  })

  it('uses the most recent agent version', async () => {
    // Mock readline for confirmation
    const mockRl = { question: vi.fn().mockResolvedValue('my-agent'), close: vi.fn() }
    mockReadline.createInterface.mockReturnValue(mockRl as any)

    await program.parseAsync(['node', 'test', 'transfer', 'my-agent', '--to', 'team-ws'])

    // Should have used agent-1 (v2, more recent) not agent-1-v1 (v1)
    expect(mockCheckAgentTransfer).toHaveBeenCalledWith(
      expect.any(Object),
      'agent-1',
      'ws-2'
    )
  })

  describe('dry-run mode', () => {
    it('shows transfer preview without executing', async () => {
      await program.parseAsync(['node', 'test', 'transfer', 'my-agent', '--to', 'team-ws', '--dry-run'])

      // Should NOT have called transferAgent
      expect(mockTransferAgent).not.toHaveBeenCalled()

      // Should show dry-run output
      const output = stdoutSpy.mock.calls.map((c) => c[0]).join('')
      expect(output).toContain('DRY RUN')
      expect(output).toContain('my-agent')
      expect(output).toContain('2 version(s)')
    })

    it('still shows warnings in dry-run', async () => {
      await program.parseAsync(['node', 'test', 'transfer', 'my-agent', '--to', 'team-ws', '--dry-run'])

      const output = stdoutSpy.mock.calls.map((c) => c[0]).join('')
      expect(output).toContain('Warning')
      expect(output).toContain('grant')
    })
  })

  describe('blockers', () => {
    it('exits with code 1 when blockers present', async () => {
      mockCheckAgentTransfer.mockResolvedValue({
        can_transfer: false,
        blockers: ['Agent has public versions'],
        warnings: [],
        details: { version_count: 1, grants_count: 0, keys_count: 0, schedules_count: 0 },
      } as any)

      await expect(
        program.parseAsync(['node', 'test', 'transfer', 'my-agent', '--to', 'team-ws'])
      ).rejects.toThrow('process.exit called')

      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(mockTransferAgent).not.toHaveBeenCalled()
    })

    it('shows blocker messages', async () => {
      mockCheckAgentTransfer.mockResolvedValue({
        can_transfer: false,
        blockers: ['Agent has public versions', 'Name conflict in target'],
        warnings: [],
        details: { version_count: 1, grants_count: 0, keys_count: 0, schedules_count: 0 },
      } as any)

      await expect(
        program.parseAsync(['node', 'test', 'transfer', 'my-agent', '--to', 'team-ws'])
      ).rejects.toThrow()

      const output = stdoutSpy.mock.calls.map((c) => c[0]).join('')
      expect(output).toContain('Blocker')
      expect(output).toContain('public versions')
      expect(output).toContain('Name conflict')
    })
  })

  describe('confirmation prompt', () => {
    it('requires name confirmation', async () => {
      const mockRl = { question: vi.fn().mockResolvedValue('wrong-name'), close: vi.fn() }
      mockReadline.createInterface.mockReturnValue(mockRl as any)

      await expect(
        program.parseAsync(['node', 'test', 'transfer', 'my-agent', '--to', 'team-ws'])
      ).rejects.toThrow('process.exit called')

      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(mockTransferAgent).not.toHaveBeenCalled()
    })

    it('proceeds when name matches', async () => {
      const mockRl = { question: vi.fn().mockResolvedValue('my-agent'), close: vi.fn() }
      mockReadline.createInterface.mockReturnValue(mockRl as any)

      await program.parseAsync(['node', 'test', 'transfer', 'my-agent', '--to', 'team-ws'])

      expect(mockTransferAgent).toHaveBeenCalledWith(
        expect.any(Object),
        'agent-1',
        { target_workspace_id: 'ws-2', confirmation_name: 'my-agent' }
      )
    })
  })

  describe('--yes flag', () => {
    it('skips confirmation prompt', async () => {
      await program.parseAsync(['node', 'test', 'transfer', 'my-agent', '--to', 'team-ws', '--yes'])

      // readline should not be called
      expect(mockReadline.createInterface).not.toHaveBeenCalled()
      expect(mockTransferAgent).toHaveBeenCalled()
    })
  })

  describe('--json flag', () => {
    it('outputs structured JSON', async () => {
      const mockRl = { question: vi.fn().mockResolvedValue('my-agent'), close: vi.fn() }
      mockReadline.createInterface.mockReturnValue(mockRl as any)

      await program.parseAsync(['node', 'test', 'transfer', 'my-agent', '--to', 'team-ws', '--json'])

      expect(mockPrintJson).toHaveBeenCalledWith(mockTransferResult)
    })
  })

  describe('success output', () => {
    it('shows transfer summary', async () => {
      const mockRl = { question: vi.fn().mockResolvedValue('my-agent'), close: vi.fn() }
      mockReadline.createInterface.mockReturnValue(mockRl as any)

      await program.parseAsync(['node', 'test', 'transfer', 'my-agent', '--to', 'team-ws'])

      const output = stdoutSpy.mock.calls.map((c) => c[0]).join('')
      expect(output).toContain('Transferred my-agent')
      expect(output).toContain('2 version(s)')
      expect(output).toContain('my-ws')
      expect(output).toContain('team-ws')
    })

    it('shows cleanup stats when resources affected', async () => {
      const mockRl = { question: vi.fn().mockResolvedValue('my-agent'), close: vi.fn() }
      mockReadline.createInterface.mockReturnValue(mockRl as any)

      await program.parseAsync(['node', 'test', 'transfer', 'my-agent', '--to', 'team-ws'])

      const output = stdoutSpy.mock.calls.map((c) => c[0]).join('')
      expect(output).toContain('1 grant(s) revoked')
    })

    it('tracks analytics event', async () => {
      const mockRl = { question: vi.fn().mockResolvedValue('my-agent'), close: vi.fn() }
      mockReadline.createInterface.mockReturnValue(mockRl as any)

      await program.parseAsync(['node', 'test', 'transfer', 'my-agent', '--to', 'team-ws'])

      expect(mockTrack).toHaveBeenCalledWith('cli_transfer', {
        agent_name: 'my-agent',
        versions_transferred: 2,
        target_workspace: 'team-ws',
      })
    })
  })

  describe('fetches in parallel', () => {
    it('calls workspaces and agents simultaneously', async () => {
      const mockRl = { question: vi.fn().mockResolvedValue('my-agent'), close: vi.fn() }
      mockReadline.createInterface.mockReturnValue(mockRl as any)

      await program.parseAsync(['node', 'test', 'transfer', 'my-agent', '--to', 'team-ws'])

      // Both should have been called
      expect(mockRequest).toHaveBeenCalledWith(
        expect.any(Object),
        'GET',
        '/workspaces'
      )
      expect(mockListMyAgents).toHaveBeenCalledWith(expect.any(Object))
    })
  })
})
