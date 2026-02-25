/**
 * Tests for the logs command.
 *
 * Covers: BUG-1 (short run IDs), BUG-2 (org prefix stripping)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

vi.mock('../lib/config')
vi.mock('../lib/api', () => ({
  request: vi.fn(),
}))
vi.mock('../lib/output', () => ({
  printJson: vi.fn(),
}))

import { registerLogsCommand } from './logs'
import { getResolvedConfig, loadConfig } from '../lib/config'
import { request } from '../lib/api'

const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockLoadConfig = vi.mocked(loadConfig)
const mockRequest = vi.mocked(request)

const WORKSPACE_ID = 'ws-123'

function makeRunsResponse(runs: Array<Record<string, unknown>> = []) {
  return { runs, total: runs.length }
}

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    agent_name: 'test-agent',
    agent_version: 'v1',
    status: 'completed',
    error_message: null,
    duration_ms: 1500,
    trigger_source: 'cli',
    started_at: '2026-02-21T10:00:00Z',
    created_at: '2026-02-21T10:00:00Z',
    ...overrides,
  }
}

function makeRunLogsResponse(overrides: Record<string, unknown> = {}) {
  return {
    run_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    agent_name: 'test-agent',
    agent_version: 'v1',
    run_status: 'completed',
    error_message: null,
    has_execution_log: true,
    stdout: 'hello world',
    stderr: null,
    exit_code: 0,
    execution_time_ms: 1500,
    ...overrides,
  }
}

describe('logs command', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()

    program = new Command()
    program.exitOverride()
    registerLogsCommand(program)

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'joe',
    })

    mockLoadConfig.mockResolvedValue({ workspace: 'joe' })

    // Default: workspace resolution
    mockRequest.mockImplementation(async (_config, method, path) => {
      if (path === '/workspaces') {
        return { workspaces: [{ id: WORKSPACE_ID, name: 'Joe', slug: 'joe' }] }
      }
      return {}
    })
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  // ─── BUG-1: Short run ID resolution ────────────────────────────────────────

  it('resolves a short run ID prefix to full UUID and shows detail', async () => {
    const fullId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'

    mockRequest.mockImplementation(async (_config, method, path) => {
      if (path === '/workspaces') {
        return { workspaces: [{ id: WORKSPACE_ID, name: 'Joe', slug: 'joe' }] }
      }
      // Short ID resolution: list runs to find matching full ID
      if (typeof path === 'string' && path.includes('/runs?')) {
        return makeRunsResponse([makeRun({ id: fullId })])
      }
      // Detail fetch
      if (typeof path === 'string' && path.includes(`/runs/${fullId}/logs`)) {
        return makeRunLogsResponse({ run_id: fullId })
      }
      return {}
    })

    await program.parseAsync(['node', 'test', 'logs', 'a1b2c3d4'])

    // Should have fetched run detail (not treated as agent name)
    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain(`Run ${fullId}`)
    expect(output).toContain('test-agent')
  })

  it('errors when short run ID matches multiple runs', async () => {
    mockRequest.mockImplementation(async (_config, method, path) => {
      if (path === '/workspaces') {
        return { workspaces: [{ id: WORKSPACE_ID, name: 'Joe', slug: 'joe' }] }
      }
      if (typeof path === 'string' && path.includes('/runs?')) {
        return makeRunsResponse([
          makeRun({ id: 'aabbccdd-1111-2222-3333-444455556666' }),
          makeRun({ id: 'aabbccdd-9999-8888-7777-666655554444' }),
        ])
      }
      return {}
    })

    await expect(
      program.parseAsync(['node', 'test', 'logs', 'aabbccdd'])
    ).rejects.toThrow('Ambiguous')
  })

  it('errors when short run ID matches no runs', async () => {
    mockRequest.mockImplementation(async (_config, method, path) => {
      if (path === '/workspaces') {
        return { workspaces: [{ id: WORKSPACE_ID, name: 'Joe', slug: 'joe' }] }
      }
      if (typeof path === 'string' && path.includes('/runs?')) {
        return makeRunsResponse([])
      }
      return {}
    })

    await expect(
      program.parseAsync(['node', 'test', 'logs', 'deadbeef'])
    ).rejects.toThrow("No run found matching 'deadbeef'")
  })

  it('still handles full UUID directly without list lookup', async () => {
    const fullId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'

    mockRequest.mockImplementation(async (_config, method, path) => {
      if (path === '/workspaces') {
        return { workspaces: [{ id: WORKSPACE_ID, name: 'Joe', slug: 'joe' }] }
      }
      if (typeof path === 'string' && path.includes(`/runs/${fullId}/logs`)) {
        return makeRunLogsResponse({ run_id: fullId })
      }
      return {}
    })

    await program.parseAsync(['node', 'test', 'logs', fullId])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain(`Run ${fullId}`)
  })

  // ─── BUG-12: Server-side short ID resolution ─────────────────────────────

  it('sends run_id_prefix to server for short ID resolution instead of client-side filtering', async () => {
    const fullId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
    let resolveUrl: string | null = null

    mockRequest.mockImplementation(async (_config, method, path) => {
      if (path === '/workspaces') {
        return { workspaces: [{ id: WORKSPACE_ID, name: 'Joe', slug: 'joe' }] }
      }
      // Capture the URL used for short ID resolution
      if (typeof path === 'string' && path.includes('/runs?') && path.includes('run_id_prefix')) {
        resolveUrl = path
        return makeRunsResponse([makeRun({ id: fullId })])
      }
      if (typeof path === 'string' && path.includes('/runs?') && !path.includes('run_id_prefix')) {
        resolveUrl = path
        return makeRunsResponse([makeRun({ id: fullId })])
      }
      // Detail fetch
      if (typeof path === 'string' && path.includes(`/runs/${fullId}/logs`)) {
        return makeRunLogsResponse({ run_id: fullId })
      }
      return {}
    })

    await program.parseAsync(['node', 'test', 'logs', 'a1b2c3d4'])

    // The CLI should send run_id_prefix to the server, not just fetch all 200 and filter
    expect(resolveUrl).not.toBeNull()
    const url = new URL(`https://test${resolveUrl}`)
    expect(url.searchParams.get('run_id_prefix')).toBe('a1b2c3d4')
  })

  // ─── BUG-2: Org prefix stripping ──────────────────────────────────────────

  it('strips org prefix from agent name filter', async () => {
    mockRequest.mockImplementation(async (_config, method, path) => {
      if (path === '/workspaces') {
        return { workspaces: [{ id: WORKSPACE_ID, name: 'Joe', slug: 'joe' }] }
      }
      if (typeof path === 'string' && path.includes('/runs?')) {
        // Verify the agent_name param does NOT include the org prefix
        const url = new URL(`https://test${path}`)
        const agentName = url.searchParams.get('agent_name')
        expect(agentName).toBe('test-agent') // NOT 'joe/test-agent'
        return makeRunsResponse([makeRun()])
      }
      return {}
    })

    await program.parseAsync(['node', 'test', 'logs', 'joe/test-agent'])
  })

  it('works without org prefix (unchanged behavior)', async () => {
    mockRequest.mockImplementation(async (_config, method, path) => {
      if (path === '/workspaces') {
        return { workspaces: [{ id: WORKSPACE_ID, name: 'Joe', slug: 'joe' }] }
      }
      if (typeof path === 'string' && path.includes('/runs?')) {
        const url = new URL(`https://test${path}`)
        const agentName = url.searchParams.get('agent_name')
        expect(agentName).toBe('test-agent')
        return makeRunsResponse([makeRun()])
      }
      return {}
    })

    await program.parseAsync(['node', 'test', 'logs', 'test-agent'])
  })

  // ─── BUG-B: Auto-select workspace for single-workspace users ────────────

  it('auto-selects workspace when user has exactly one and none is configured', async () => {
    // No workspace in config
    mockLoadConfig.mockResolvedValue({})

    mockRequest.mockImplementation(async (_config, method, path) => {
      if (path === '/workspaces') {
        return { workspaces: [{ id: WORKSPACE_ID, name: 'Joe', slug: 'joe' }] }
      }
      if (typeof path === 'string' && path.includes('/runs?')) {
        // Verify it used the auto-selected workspace ID in the URL
        expect(path).toContain(`/workspaces/${WORKSPACE_ID}/runs`)
        return makeRunsResponse([makeRun()])
      }
      return {}
    })

    // Should NOT throw — should auto-select the only workspace
    await program.parseAsync(['node', 'test', 'logs'])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain('test-agent')
  })

  it('errors with workspace list when user has multiple workspaces and none is configured', async () => {
    // No workspace in config
    mockLoadConfig.mockResolvedValue({})

    mockRequest.mockImplementation(async (_config, method, path) => {
      if (path === '/workspaces') {
        return {
          workspaces: [
            { id: 'ws-1', name: 'Personal', slug: 'joe' },
            { id: 'ws-2', name: 'Team Alpha', slug: 'team-alpha' },
          ],
        }
      }
      return {}
    })

    // Should throw with helpful message listing available workspaces
    await expect(
      program.parseAsync(['node', 'test', 'logs'])
    ).rejects.toThrow('workspace')
  })

  it('errors when user has no workspaces and none is configured', async () => {
    // No workspace in config
    mockLoadConfig.mockResolvedValue({})

    mockRequest.mockImplementation(async (_config, method, path) => {
      if (path === '/workspaces') {
        return { workspaces: [] }
      }
      return {}
    })

    await expect(
      program.parseAsync(['node', 'test', 'logs'])
    ).rejects.toThrow('No workspaces found')
  })

  it('still uses configured workspace when set (existing behavior)', async () => {
    // Workspace IS in config
    mockLoadConfig.mockResolvedValue({ workspace: 'joe' })

    mockRequest.mockImplementation(async (_config, method, path) => {
      if (path === '/workspaces') {
        return {
          workspaces: [
            { id: 'ws-1', name: 'Personal', slug: 'joe' },
            { id: 'ws-2', name: 'Team Alpha', slug: 'team-alpha' },
          ],
        }
      }
      if (typeof path === 'string' && path.includes('/runs?')) {
        // Should use ws-1 (the 'joe' workspace), not ws-2
        expect(path).toContain('/workspaces/ws-1/runs')
        return makeRunsResponse([makeRun()])
      }
      return {}
    })

    await program.parseAsync(['node', 'test', 'logs'])
  })

  it('still uses --workspace flag when provided (existing behavior)', async () => {
    // No workspace in config
    mockLoadConfig.mockResolvedValue({})

    mockRequest.mockImplementation(async (_config, method, path) => {
      if (path === '/workspaces') {
        return {
          workspaces: [
            { id: 'ws-1', name: 'Personal', slug: 'joe' },
            { id: 'ws-2', name: 'Team Alpha', slug: 'team-alpha' },
          ],
        }
      }
      if (typeof path === 'string' && path.includes('/runs?')) {
        expect(path).toContain('/workspaces/ws-2/runs')
        return makeRunsResponse([makeRun()])
      }
      return {}
    })

    await program.parseAsync(['node', 'test', 'logs', '--workspace', 'team-alpha'])
  })

  // ─── UX-1: Smart workspace defaulting ─────────────────────────────────────

  it('defaults to personal workspace when multiple are available', async () => {
    // No workspace in config
    mockLoadConfig.mockResolvedValue({})

    mockRequest.mockImplementation(async (_config, method, path) => {
      if (path === '/workspaces') {
        return {
          workspaces: [
            { id: 'ws-1', name: 'Personal', slug: 'joe', type: 'personal' },
            { id: 'ws-2', name: 'Team Alpha', slug: 'team-alpha', type: 'team' },
            { id: 'ws-3', name: 'Team Beta', slug: 'team-beta', type: 'team' },
          ],
        }
      }
      if (typeof path === 'string' && path.includes('/runs?')) {
        // Should default to personal workspace (ws-1), not require explicit --workspace
        expect(path).toContain('/workspaces/ws-1/runs')
        return makeRunsResponse([makeRun()])
      }
      return {}
    })

    // Should NOT throw — should auto-select the personal workspace
    await program.parseAsync(['node', 'test', 'logs'])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain('test-agent')
  })

  it('still errors when multiple workspaces but no personal type available', async () => {
    // No workspace in config
    mockLoadConfig.mockResolvedValue({})

    mockRequest.mockImplementation(async (_config, method, path) => {
      if (path === '/workspaces') {
        return {
          workspaces: [
            { id: 'ws-1', name: 'Team Alpha', slug: 'team-alpha', type: 'team' },
            { id: 'ws-2', name: 'Team Beta', slug: 'team-beta', type: 'team' },
          ],
        }
      }
      return {}
    })

    // Should throw because no personal workspace to default to
    await expect(
      program.parseAsync(['node', 'test', 'logs'])
    ).rejects.toThrow('Multiple workspaces available')
  })

  it('respects personal workspace type even when not first in list', async () => {
    mockLoadConfig.mockResolvedValue({})

    mockRequest.mockImplementation(async (_config, method, path) => {
      if (path === '/workspaces') {
        return {
          workspaces: [
            { id: 'ws-1', name: 'Team Alpha', slug: 'team-alpha', type: 'team' },
            { id: 'ws-2', name: 'Team Beta', slug: 'team-beta', type: 'team' },
            { id: 'ws-3', name: 'Personal', slug: 'joe', type: 'personal' },
          ],
        }
      }
      if (typeof path === 'string' && path.includes('/runs?')) {
        // Should default to personal workspace (ws-3), not the first one (ws-1)
        expect(path).toContain('/workspaces/ws-3/runs')
        return makeRunsResponse([makeRun()])
      }
      return {}
    })

    await program.parseAsync(['node', 'test', 'logs'])
  })

  it('explicit --workspace overrides personal defaulting', async () => {
    mockLoadConfig.mockResolvedValue({})

    mockRequest.mockImplementation(async (_config, method, path) => {
      if (path === '/workspaces') {
        return {
          workspaces: [
            { id: 'ws-1', name: 'Personal', slug: 'joe', type: 'personal' },
            { id: 'ws-2', name: 'Team Alpha', slug: 'team-alpha', type: 'team' },
          ],
        }
      }
      if (typeof path === 'string' && path.includes('/runs?')) {
        // Should use team-alpha (explicit choice), not personal workspace
        expect(path).toContain('/workspaces/ws-2/runs')
        return makeRunsResponse([makeRun()])
      }
      return {}
    })

    await program.parseAsync(['node', 'test', 'logs', '--workspace', 'team-alpha'])
  })

  it('configured workspace takes precedence over personal defaulting', async () => {
    mockLoadConfig.mockResolvedValue({ workspace: 'team-alpha' })

    mockRequest.mockImplementation(async (_config, method, path) => {
      if (path === '/workspaces') {
        return {
          workspaces: [
            { id: 'ws-1', name: 'Personal', slug: 'joe', type: 'personal' },
            { id: 'ws-2', name: 'Team Alpha', slug: 'team-alpha', type: 'team' },
          ],
        }
      }
      if (typeof path === 'string' && path.includes('/runs?')) {
        // Should use configured workspace (team-alpha), not personal
        expect(path).toContain('/workspaces/ws-2/runs')
        return makeRunsResponse([makeRun()])
      }
      return {}
    })

    await program.parseAsync(['node', 'test', 'logs'])
  })
})
