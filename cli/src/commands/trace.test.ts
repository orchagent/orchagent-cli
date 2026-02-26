/**
 * Tests for the trace command.
 *
 * Covers: trace display, event rendering, short ID resolution, error cases, JSON output.
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

import { registerTraceCommand } from './trace'
import { getResolvedConfig, loadConfig } from '../lib/config'
import { request } from '../lib/api'
import { printJson } from '../lib/output'

const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockLoadConfig = vi.mocked(loadConfig)
const mockRequest = vi.mocked(request)
const mockPrintJson = vi.mocked(printJson)

const WORKSPACE_ID = 'ws-123'
const FULL_RUN_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
const TRACE_ID = 'trace-abc-123'

function setupDefaults() {
  mockGetResolvedConfig.mockResolvedValue({
    apiKey: 'sk_test_123',
    apiUrl: 'https://api.test.com',
    defaultOrg: 'joe',
  })
  mockLoadConfig.mockResolvedValue({ workspace: 'joe' })
}

function makeRunDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: FULL_RUN_ID,
    agent_name: 'test-agent',
    agent_version: 'v1',
    status: 'completed',
    error_message: null,
    duration_ms: 3500,
    trigger_source: 'api',
    started_at: '2026-02-22T10:00:00Z',
    created_at: '2026-02-22T10:00:00Z',
    ...overrides,
  }
}

function makeTraceHeader(overrides: Record<string, unknown> = {}) {
  return {
    id: TRACE_ID,
    run_id: FULL_RUN_ID,
    workspace_id: WORKSPACE_ID,
    status: 'completed',
    created_at: '2026-02-22T10:00:00Z',
    completed_at: '2026-02-22T10:00:03Z',
    ...overrides,
  }
}

function makeTraceEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'event-1',
    trace_id: TRACE_ID,
    sequence_no: 1,
    event_type: 'llm_call_succeeded',
    payload: {},
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    token_input: 1000,
    token_output: 200,
    cache_read_tokens: 50,
    cache_write_tokens: 100,
    cost_usd: 0.003,
    duration_ms: 1200,
    error_type: null,
    error_message: null,
    created_at: '2026-02-22T10:00:01Z',
    ...overrides,
  }
}

/**
 * Standard mock router for trace tests.
 * Routes: /workspaces, /runs/{id}, /runs/{id}/trace, /traces/{id}/events
 * IMPORTANT: Check /events BEFORE /trace to avoid URL overlap
 * (/traces/{id}/events contains "/trace").
 */
function standardMockRouter(
  overrides: {
    run?: Record<string, unknown>
    trace?: Record<string, unknown>
    events?: unknown[]
    eventsTotal?: number
  } = {}
) {
  return async (_config: unknown, _method: unknown, path: unknown) => {
    const p = path as string
    if (p === '/workspaces') {
      return { workspaces: [{ id: WORKSPACE_ID, name: 'Joe', slug: 'joe' }] }
    }
    if (p === `/workspaces/${WORKSPACE_ID}/runs/${FULL_RUN_ID}`) {
      return makeRunDetail(overrides.run ?? {})
    }
    // Check events BEFORE trace (events URL contains "/traces/" which matches "/trace")
    if (p.includes('/events')) {
      const events = overrides.events ?? [makeTraceEvent()]
      return {
        events,
        total: overrides.eventsTotal ?? events.length,
        cursor: '0',
        next_cursor: null,
      }
    }
    if (p.endsWith('/trace')) {
      return { trace: makeTraceHeader(overrides.trace ?? {}) }
    }
    return {}
  }
}

describe('trace command', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()

    program = new Command()
    program.exitOverride()
    registerTraceCommand(program)

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    setupDefaults()
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  // ─── Basic trace display ────────────────────────────────────────────

  it('displays trace header and events for a run', async () => {
    mockRequest.mockImplementation(standardMockRouter({
      events: [
        makeTraceEvent({ sequence_no: 1, event_type: 'llm_call_started', provider: 'anthropic', model: 'claude-sonnet-4-20250514' }),
        makeTraceEvent({ sequence_no: 2 }),
      ],
    }))

    await program.parseAsync(['node', 'test', 'trace', FULL_RUN_ID])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain(`Trace for run ${FULL_RUN_ID}`)
    expect(output).toContain('test-agent@v1')
    expect(output).toContain('anthropic')
    expect(output).toContain('LLM')
  })

  // ─── All event types ──────────────────────────────────────────────

  it('renders llm_call_succeeded with tokens and cost', async () => {
    mockRequest.mockImplementation(standardMockRouter({
      events: [makeTraceEvent({
        sequence_no: 1,
        event_type: 'llm_call_succeeded',
        provider: 'openai',
        model: 'gpt-4o',
        token_input: 5000,
        token_output: 1500,
        cost_usd: 0.025,
        duration_ms: 3200,
      })],
    }))

    await program.parseAsync(['node', 'test', 'trace', FULL_RUN_ID])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain('openai/gpt-4o')
    expect(output).toContain('5,000 in')
    expect(output).toContain('1,500 out')
    expect(output).toContain('$0.0250')
    expect(output).toContain('3.2s')
  })

  it('renders llm_call_failed with error', async () => {
    mockRequest.mockImplementation(standardMockRouter({
      run: { status: 'failed' },
      trace: { status: 'failed' },
      events: [makeTraceEvent({
        sequence_no: 1,
        event_type: 'llm_call_failed',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        error_type: 'rate_limit',
        error_message: 'Rate limit exceeded',
        duration_ms: 500,
      })],
    }))

    await program.parseAsync(['node', 'test', 'trace', FULL_RUN_ID])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain('Rate limit exceeded')
  })

  it('renders tool_call_succeeded', async () => {
    mockRequest.mockImplementation(standardMockRouter({
      events: [makeTraceEvent({
        sequence_no: 1,
        event_type: 'tool_call_succeeded',
        payload: { tool_name: 'scan_code' },
        provider: null, model: null,
        token_input: null, token_output: null, cost_usd: null,
        duration_ms: 800,
      })],
    }))

    await program.parseAsync(['node', 'test', 'trace', FULL_RUN_ID])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain('TOOL')
    expect(output).toContain('scan_code')
    expect(output).toContain('800ms')
  })

  it('renders tool_call_failed', async () => {
    mockRequest.mockImplementation(standardMockRouter({
      events: [makeTraceEvent({
        sequence_no: 1,
        event_type: 'tool_call_failed',
        payload: { tool_name: 'fetch_data' },
        provider: null, model: null,
        token_input: null, token_output: null, cost_usd: null,
        error_type: 'timeout',
        error_message: 'Tool execution timed out',
        duration_ms: 30000,
      })],
    }))

    await program.parseAsync(['node', 'test', 'trace', FULL_RUN_ID])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain('fetch_data')
    expect(output).toContain('Tool execution timed out')
  })

  it('renders decision events', async () => {
    mockRequest.mockImplementation(standardMockRouter({
      events: [makeTraceEvent({
        sequence_no: 1,
        event_type: 'decision',
        payload: { description: 'Choosing to call sub-agent scanner' },
        provider: null, model: null,
        token_input: null, token_output: null, cost_usd: null,
        duration_ms: null,
      })],
    }))

    await program.parseAsync(['node', 'test', 'trace', FULL_RUN_ID])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain('DECIDE')
    expect(output).toContain('Choosing to call sub-agent scanner')
  })

  it('renders fallback_transition events', async () => {
    mockRequest.mockImplementation(standardMockRouter({
      events: [makeTraceEvent({
        sequence_no: 1,
        event_type: 'fallback_transition',
        payload: { from_provider: 'anthropic', to_provider: 'openai', reason: 'rate limited' },
        provider: null, model: null,
        token_input: null, token_output: null, cost_usd: null,
        duration_ms: null,
      })],
    }))

    await program.parseAsync(['node', 'test', 'trace', FULL_RUN_ID])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain('FALLBACK')
    expect(output).toContain('anthropic -> openai')
    expect(output).toContain('rate limited')
  })

  it('renders policy_violation events', async () => {
    mockRequest.mockImplementation(standardMockRouter({
      events: [makeTraceEvent({
        sequence_no: 1,
        event_type: 'policy_violation',
        payload: { violation_type: 'dependency_not_allowed', detail: 'Agent X not in allowlist' },
        provider: null, model: null,
        token_input: null, token_output: null, cost_usd: null,
        duration_ms: null,
      })],
    }))

    await program.parseAsync(['node', 'test', 'trace', FULL_RUN_ID])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain('POLICY')
    expect(output).toContain('dependency_not_allowed')
    expect(output).toContain('Agent X not in allowlist')
  })

  it('renders error events', async () => {
    mockRequest.mockImplementation(standardMockRouter({
      run: { status: 'failed' },
      trace: { status: 'failed' },
      events: [makeTraceEvent({
        sequence_no: 1,
        event_type: 'error',
        payload: {},
        provider: null, model: null,
        token_input: null, token_output: null, cost_usd: null,
        duration_ms: null,
        error_type: 'SANDBOX_ERROR',
        error_message: 'Process exited with code 137',
      })],
    }))

    await program.parseAsync(['node', 'test', 'trace', FULL_RUN_ID])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain('ERROR')
    expect(output).toContain('SANDBOX_ERROR')
    expect(output).toContain('Process exited with code 137')
  })

  // ─── Empty trace ────────────────────────────────────────────────────

  it('shows message for empty trace', async () => {
    mockRequest.mockImplementation(standardMockRouter({ events: [] }))

    await program.parseAsync(['node', 'test', 'trace', FULL_RUN_ID])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain('No trace events recorded')
  })

  // ─── JSON output ──────────────────────────────────────────────────

  it('outputs JSON with --json flag', async () => {
    const events = [
      makeTraceEvent({ sequence_no: 1 }),
      makeTraceEvent({ sequence_no: 2, event_type: 'tool_call_succeeded', payload: { tool_name: 'bash' } }),
    ]

    mockRequest.mockImplementation(standardMockRouter({ events }))

    await program.parseAsync(['node', 'test', 'trace', FULL_RUN_ID, '--json'])

    expect(mockPrintJson).toHaveBeenCalledWith(
      expect.objectContaining({
        run: expect.objectContaining({ id: FULL_RUN_ID }),
        trace: expect.objectContaining({ id: TRACE_ID }),
        events: expect.arrayContaining([
          expect.objectContaining({ sequence_no: 1 }),
          expect.objectContaining({ sequence_no: 2 }),
        ]),
      })
    )
  })

  // ─── Short run ID resolution ──────────────────────────────────────

  it('resolves short run ID prefix', async () => {
    mockRequest.mockImplementation(async (_config, _method, path) => {
      const p = path as string
      if (p === '/workspaces') {
        return { workspaces: [{ id: WORKSPACE_ID, name: 'Joe', slug: 'joe' }] }
      }
      if (p.includes('/runs?') && p.includes('run_id_prefix')) {
        return { runs: [{ id: FULL_RUN_ID }], total: 1 }
      }
      if (p === `/workspaces/${WORKSPACE_ID}/runs/${FULL_RUN_ID}`) {
        return makeRunDetail()
      }
      if (p.includes('/events')) {
        return { events: [], total: 0, cursor: '0', next_cursor: null }
      }
      if (p.endsWith('/trace')) {
        return { trace: makeTraceHeader() }
      }
      return {}
    })

    await program.parseAsync(['node', 'test', 'trace', 'a1b2c3d4'])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain(`Trace for run ${FULL_RUN_ID}`)
  })

  // ─── Error cases ──────────────────────────────────────────────────

  it('errors when no trace available', async () => {
    mockRequest.mockImplementation(async (_config, _method, path) => {
      const p = path as string
      if (p === '/workspaces') {
        return { workspaces: [{ id: WORKSPACE_ID, name: 'Joe', slug: 'joe' }] }
      }
      if (p === `/workspaces/${WORKSPACE_ID}/runs/${FULL_RUN_ID}`) {
        return makeRunDetail()
      }
      if (p.endsWith('/trace')) {
        throw new Error('Not found')
      }
      return {}
    })

    await expect(
      program.parseAsync(['node', 'test', 'trace', FULL_RUN_ID])
    ).rejects.toThrow('No trace available')
  })

  it('requires API key', async () => {
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: '',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'joe',
    })

    await expect(
      program.parseAsync(['node', 'test', 'trace', FULL_RUN_ID])
    ).rejects.toThrow('Missing API key')
  })

  it('accepts req_xxx format and strips prefix', async () => {
    mockRequest.mockImplementation(async (_config, _method, path) => {
      const p = path as string
      if (p === '/workspaces') {
        return { workspaces: [{ id: WORKSPACE_ID, name: 'Joe', slug: 'joe' }] }
      }
      if (p.includes('/runs?') && p.includes('run_id_prefix')) {
        // Verify the prefix search uses the hex suffix, not the full req_xxx
        expect(p).toContain('run_id_prefix=ed7ceed0f439')
        return { runs: [{ id: FULL_RUN_ID }], total: 1 }
      }
      if (p === `/workspaces/${WORKSPACE_ID}/runs/${FULL_RUN_ID}`) {
        return makeRunDetail()
      }
      if (p.includes('/events')) {
        return { events: [], total: 0, cursor: '0', next_cursor: null }
      }
      if (p.endsWith('/trace')) {
        return { trace: makeTraceHeader() }
      }
      return {}
    })

    await program.parseAsync(['node', 'test', 'trace', 'req_ed7ceed0f439'])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain(`Trace for run ${FULL_RUN_ID}`)
  })

  it('rejects invalid run ID format', async () => {
    mockRequest.mockImplementation(async (_config, _method, path) => {
      if (path === '/workspaces') {
        return { workspaces: [{ id: WORKSPACE_ID, name: 'Joe', slug: 'joe' }] }
      }
      return {}
    })

    await expect(
      program.parseAsync(['node', 'test', 'trace', 'not-valid!'])
    ).rejects.toThrow('Invalid run ID')
  })

  // ─── Summary stats ────────────────────────────────────────────────

  it('shows summary with LLM and tool call counts', async () => {
    mockRequest.mockImplementation(standardMockRouter({
      events: [
        makeTraceEvent({ sequence_no: 1, event_type: 'llm_call_succeeded', provider: 'anthropic', token_input: 1000, token_output: 200, cost_usd: 0.003 }),
        makeTraceEvent({ sequence_no: 2, event_type: 'tool_call_succeeded', payload: { tool_name: 'bash' }, provider: null, token_input: null, token_output: null, cost_usd: null }),
        makeTraceEvent({ sequence_no: 3, event_type: 'llm_call_succeeded', provider: 'openai', token_input: 2000, token_output: 500, cost_usd: 0.01 }),
      ],
    }))

    await program.parseAsync(['node', 'test', 'trace', FULL_RUN_ID])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain('LLM calls:   2')
    expect(output).toContain('Tool calls:  1')
    expect(output).toContain('anthropic')
    expect(output).toContain('openai')
  })

  // ─── Pagination ────────────────────────────────────────────────────

  it('paginates through trace events', async () => {
    let fetchCount = 0

    mockRequest.mockImplementation(async (_config, _method, path) => {
      const p = path as string
      if (p === '/workspaces') {
        return { workspaces: [{ id: WORKSPACE_ID, name: 'Joe', slug: 'joe' }] }
      }
      if (p === `/workspaces/${WORKSPACE_ID}/runs/${FULL_RUN_ID}`) {
        return makeRunDetail()
      }
      if (p.includes('/events')) {
        fetchCount++
        if (fetchCount === 1) {
          return {
            events: [makeTraceEvent({ sequence_no: 1 })],
            total: 2,
            cursor: '0',
            next_cursor: '1',
          }
        }
        return {
          events: [makeTraceEvent({ sequence_no: 2 })],
          total: 2,
          cursor: '1',
          next_cursor: null,
        }
      }
      if (p.endsWith('/trace')) {
        return { trace: makeTraceHeader() }
      }
      return {}
    })

    await program.parseAsync(['node', 'test', 'trace', FULL_RUN_ID])

    expect(fetchCount).toBe(2)
    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    // Sequence numbers rendered as "# 1" and "# 2" (padded)
    expect(output).toContain('# 1')
    expect(output).toContain('# 2')
  })

  // ─── Footer hints ─────────────────────────────────────────────────

  it('shows orch logs and orch replay hints in footer', async () => {
    mockRequest.mockImplementation(standardMockRouter())

    await program.parseAsync(['node', 'test', 'trace', FULL_RUN_ID])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain('orch logs')
    expect(output).toContain('orch replay')
  })
})
