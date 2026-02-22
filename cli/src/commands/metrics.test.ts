/**
 * Tests for the metrics command (IDEA-010: Metrics dashboard).
 *
 * Covers: overview display, per-agent table, empty workspace, --json output,
 * --days / --agent filtering, workspace resolution, error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

vi.mock('../lib/config')
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
    request: vi.fn(),
  }
})
vi.mock('../lib/output', () => ({
  printJson: vi.fn(),
}))

import { registerMetricsCommand } from './metrics'
import { getResolvedConfig, loadConfig } from '../lib/config'
import { request, ApiError } from '../lib/api'
import { printJson } from '../lib/output'

const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockLoadConfig = vi.mocked(loadConfig)
const mockRequest = vi.mocked(request)
const mockPrintJson = vi.mocked(printJson)

const WORKSPACE_ID = 'ws-metrics-123'

function allStdout(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((c) => c[0]).join('')
}

function allStderr(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((c) => c[0]).join('')
}

function setupDefaults() {
  mockGetResolvedConfig.mockResolvedValue({
    apiKey: 'sk_test_123',
    apiUrl: 'https://api.test.com',
    defaultOrg: 'test-org',
  })
  mockLoadConfig.mockResolvedValue({ workspace: 'my-workspace' })
}

function makeDashboardResponse(overrides: Record<string, unknown> = {}) {
  return {
    overview: {
      total_runs: 150,
      completed: 140,
      failed: 8,
      timeout: 2,
      success_rate: 93.3,
      error_rate: 6.7,
      p50_latency_ms: 1200,
      p95_latency_ms: 4500,
      avg_latency_ms: 1800,
      runs_per_day: 5,
    },
    agents: [
      {
        agent_name: 'scanner',
        agent_id: 'agent-1',
        latest_version: 'v3',
        total_runs: 100,
        completed: 96,
        failed: 3,
        timeout: 1,
        success_rate: 96.0,
        error_rate: 4.0,
        p50_latency_ms: 800,
        p95_latency_ms: 3200,
        avg_latency_ms: 1100,
        top_error: 'SANDBOX_TIMEOUT',
        trigger_sources: { api: 80, schedule: 20 },
      },
      {
        agent_name: 'review-agent',
        agent_id: 'agent-2',
        latest_version: 'v1',
        total_runs: 50,
        completed: 44,
        failed: 5,
        timeout: 1,
        success_rate: 88.0,
        error_rate: 12.0,
        p50_latency_ms: 2500,
        p95_latency_ms: 8000,
        avg_latency_ms: 3200,
        top_error: 'LLM_RATE_LIMIT',
        trigger_sources: { api: 50 },
      },
    ],
    daily_series: [],
    period: '30d',
    total_agents: 2,
    ...overrides,
  }
}

function makeEmptyDashboard() {
  return {
    overview: {
      total_runs: 0,
      completed: 0,
      failed: 0,
      timeout: 0,
      success_rate: 0,
      error_rate: 0,
      p50_latency_ms: 0,
      p95_latency_ms: 0,
      avg_latency_ms: 0,
      runs_per_day: 0,
    },
    agents: [],
    daily_series: [],
    period: '30d',
    total_agents: 0,
  }
}

/**
 * Standard mock router for metrics tests.
 * Routes /workspaces and /workspaces/{id}/metrics/dashboard.
 */
function standardMockRouter(dashboardData?: Record<string, unknown>) {
  return async (_config: unknown, _method: unknown, path: unknown) => {
    const p = path as string
    if (p === '/workspaces') {
      return {
        workspaces: [
          { id: WORKSPACE_ID, name: 'My Workspace', slug: 'my-workspace' },
        ],
      }
    }
    if (p.includes('/metrics/dashboard')) {
      return dashboardData ?? makeDashboardResponse()
    }
    return {}
  }
}

describe('orch metrics', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerMetricsCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as never)
    setupDefaults()
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    exitSpy.mockRestore()
    vi.restoreAllMocks()
  })

  // ─── Happy path ────────────────────────────────────────────────────

  it('displays overview stats and per-agent table', async () => {
    mockRequest.mockImplementation(standardMockRouter())

    await program.parseAsync(['node', 'test', 'metrics'])

    const output = allStdout(stdoutSpy)
    // Header
    expect(output).toContain('Agent Metrics')
    expect(output).toContain('last 30d')
    // Overview
    expect(output).toContain('150')
    expect(output).toContain('93.3%')
    expect(output).toContain('6.7%')
    expect(output).toContain('1.2s') // p50 = 1200ms
    expect(output).toContain('4.5s') // p95 = 4500ms
    expect(output).toContain('1.8s') // avg = 1800ms
    // Per-agent table
    expect(output).toContain('Per Agent')
    expect(output).toContain('scanner')
    expect(output).toContain('review-agent')
    expect(output).toContain('SANDBOX_TIMEOUT')
    expect(output).toContain('LLM_RATE_LIMIT')
  })

  it('shows latencies under 1s in ms', async () => {
    const data = makeDashboardResponse()
    data.overview.p50_latency_ms = 450
    data.overview.p95_latency_ms = 890
    data.overview.avg_latency_ms = 600
    mockRequest.mockImplementation(standardMockRouter(data as unknown as Record<string, unknown>))

    await program.parseAsync(['node', 'test', 'metrics'])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('450ms')
    expect(output).toContain('890ms')
    expect(output).toContain('600ms')
  })

  // ─── Empty workspace ──────────────────────────────────────────────

  it('shows "no runs" message when workspace has no data', async () => {
    mockRequest.mockImplementation(standardMockRouter(makeEmptyDashboard()))

    await program.parseAsync(['node', 'test', 'metrics'])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('No runs in this period')
  })

  // ─── JSON output ──────────────────────────────────────────────────

  it('outputs JSON when --json is specified', async () => {
    const data = makeDashboardResponse()
    mockRequest.mockImplementation(standardMockRouter(data as unknown as Record<string, unknown>))

    await program.parseAsync(['node', 'test', 'metrics', '--json'])

    expect(mockPrintJson).toHaveBeenCalledWith(
      expect.objectContaining({
        overview: expect.objectContaining({ total_runs: 150 }),
        agents: expect.arrayContaining([
          expect.objectContaining({ agent_name: 'scanner' }),
        ]),
      })
    )
    // Should NOT write formatted output when --json
    const output = allStdout(stdoutSpy)
    expect(output).not.toContain('Agent Metrics')
  })

  // ─── --days parameter ─────────────────────────────────────────────

  it('passes custom days to API', async () => {
    mockRequest.mockImplementation(standardMockRouter())

    await program.parseAsync(['node', 'test', 'metrics', '--days', '7'])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('last 7d')
    // Verify the API was called with days=7
    const dashboardCall = mockRequest.mock.calls.find(
      (c) => (c[2] as string).includes('/metrics/dashboard')
    )
    expect(dashboardCall).toBeDefined()
    expect(dashboardCall![2]).toContain('days=7')
  })

  it('rejects --days below 1', async () => {
    mockRequest.mockImplementation(standardMockRouter())

    await expect(
      program.parseAsync(['node', 'test', 'metrics', '--days', '0'])
    ).rejects.toThrow()

    const errOutput = allStderr(stderrSpy)
    expect(errOutput).toContain('--days must be between 1 and 365')
  })

  it('rejects --days above 365', async () => {
    mockRequest.mockImplementation(standardMockRouter())

    await expect(
      program.parseAsync(['node', 'test', 'metrics', '--days', '500'])
    ).rejects.toThrow()

    const errOutput = allStderr(stderrSpy)
    expect(errOutput).toContain('--days must be between 1 and 365')
  })

  // ─── --agent filter ───────────────────────────────────────────────

  it('passes agent_name filter to API', async () => {
    mockRequest.mockImplementation(standardMockRouter())

    await program.parseAsync(['node', 'test', 'metrics', '--agent', 'scanner'])

    const dashboardCall = mockRequest.mock.calls.find(
      (c) => (c[2] as string).includes('/metrics/dashboard')
    )
    expect(dashboardCall).toBeDefined()
    expect(dashboardCall![2]).toContain('agent_name=scanner')
  })

  // ─── Workspace resolution ─────────────────────────────────────────

  it('uses --workspace flag to resolve workspace', async () => {
    mockRequest.mockImplementation(async (_config, _method, path) => {
      const p = path as string
      if (p === '/workspaces') {
        return {
          workspaces: [
            { id: 'ws-other', name: 'Other WS', slug: 'other-ws' },
            { id: WORKSPACE_ID, name: 'My Workspace', slug: 'my-workspace' },
          ],
        }
      }
      if (p.includes('/metrics/dashboard')) {
        return makeDashboardResponse()
      }
      return {}
    })

    await program.parseAsync(['node', 'test', 'metrics', '--workspace', 'other-ws'])

    // Should call with other workspace ID
    const dashboardCall = mockRequest.mock.calls.find(
      (c) => (c[2] as string).includes('/metrics/dashboard')
    )
    expect(dashboardCall![2]).toContain('ws-other')
  })

  it('errors when workspace slug not found', async () => {
    mockRequest.mockImplementation(async (_config, _method, path) => {
      const p = path as string
      if (p === '/workspaces') {
        return { workspaces: [{ id: WORKSPACE_ID, name: 'My Workspace', slug: 'my-workspace' }] }
      }
      return {}
    })

    await expect(
      program.parseAsync(['node', 'test', 'metrics', '--workspace', 'nonexistent'])
    ).rejects.toThrow("Workspace 'nonexistent' not found")
  })

  it('errors when no workspace configured', async () => {
    mockLoadConfig.mockResolvedValue({})

    await expect(
      program.parseAsync(['node', 'test', 'metrics'])
    ).rejects.toThrow('No workspace specified')
  })

  // ─── Error handling ───────────────────────────────────────────────

  it('handles 403 forbidden error', async () => {
    mockRequest.mockImplementation(async (_config, _method, path) => {
      const p = path as string
      if (p === '/workspaces') {
        return { workspaces: [{ id: WORKSPACE_ID, name: 'My Workspace', slug: 'my-workspace' }] }
      }
      if (p.includes('/metrics/dashboard')) {
        throw new ApiError('Forbidden', 403)
      }
      return {}
    })

    await expect(
      program.parseAsync(['node', 'test', 'metrics'])
    ).rejects.toThrow()

    const errOutput = allStderr(stderrSpy)
    expect(errOutput).toContain('Not a member of this workspace')
  })

  // ─── Agent table formatting ───────────────────────────────────────

  it('truncates long agent names in table', async () => {
    const data = makeDashboardResponse()
    data.agents = [{
      agent_name: 'very-long-agent-name-that-exceeds-column',
      agent_id: 'agent-long',
      latest_version: 'v1',
      total_runs: 10,
      completed: 10,
      failed: 0,
      timeout: 0,
      success_rate: 100,
      error_rate: 0,
      p50_latency_ms: 500,
      p95_latency_ms: 1000,
      avg_latency_ms: 600,
      top_error: null,
      trigger_sources: { api: 10 },
    }]
    mockRequest.mockImplementation(standardMockRouter(data as unknown as Record<string, unknown>))

    await program.parseAsync(['node', 'test', 'metrics'])

    const output = allStdout(stdoutSpy)
    // Name should be truncated to 22 chars + '..'
    expect(output).toContain('very-long-agent-name-t..')
    expect(output).not.toContain('very-long-agent-name-that-exceeds-column')
  })

  it('shows dash for agents with no top error', async () => {
    const data = makeDashboardResponse()
    data.agents = [{
      agent_name: 'clean-agent',
      agent_id: 'agent-clean',
      latest_version: 'v1',
      total_runs: 50,
      completed: 50,
      failed: 0,
      timeout: 0,
      success_rate: 100,
      error_rate: 0,
      p50_latency_ms: 300,
      p95_latency_ms: 600,
      avg_latency_ms: 350,
      top_error: null,
      trigger_sources: { api: 50 },
    }]
    mockRequest.mockImplementation(standardMockRouter(data as unknown as Record<string, unknown>))

    await program.parseAsync(['node', 'test', 'metrics'])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('clean-agent')
    expect(output).toContain('100%')
  })

  it('shows no agent table when agents list is empty', async () => {
    const data = makeDashboardResponse()
    data.agents = []
    data.total_agents = 0
    mockRequest.mockImplementation(standardMockRouter(data as unknown as Record<string, unknown>))

    await program.parseAsync(['node', 'test', 'metrics'])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('Agent Metrics')
    expect(output).toContain('150') // overview still shows
    expect(output).not.toContain('Per Agent')
  })
})
