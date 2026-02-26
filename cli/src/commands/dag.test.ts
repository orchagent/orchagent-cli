/**
 * Tests for the dag command (IDEA-001).
 *
 * Covers: DAG display, ASCII tree rendering, live mode, short ID resolution,
 * error cases, JSON output.
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
vi.mock('../lib/spinner', () => ({
  createSpinner: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
  })),
}))

import { registerDagCommand } from './dag'
import { getResolvedConfig, loadConfig } from '../lib/config'
import { request } from '../lib/api'
import { printJson } from '../lib/output'

const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockLoadConfig = vi.mocked(loadConfig)
const mockRequest = vi.mocked(request)
const mockPrintJson = vi.mocked(printJson)

const WORKSPACE_ID = 'ws-dag-123'
const FULL_RUN_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
const ROOT_RUN_ID = '11111111-2222-3333-4444-555555555555'

function setupDefaults() {
  mockGetResolvedConfig.mockResolvedValue({
    apiKey: 'sk_test_dag_123',
    apiUrl: 'https://api.test.com',
    defaultOrg: 'joe',
  })
  mockLoadConfig.mockResolvedValue({ workspace: 'joe' })
}

function makeDagResponse(overrides: Record<string, unknown> = {}) {
  return {
    root_run_id: ROOT_RUN_ID,
    is_live: false,
    total_cost_usd: 0.015,
    total_duration_ms: 8000,
    node_count: 3,
    active_count: 0,
    completed_count: 3,
    failed_count: 0,
    most_expensive_agent: 'orchestrator',
    tree: {
      run_id: ROOT_RUN_ID,
      agent_name: 'orchestrator',
      agent_version: 'v1',
      status: 'completed',
      duration_ms: 8000,
      started_at: '2026-02-22T10:00:00Z',
      self_cost_usd: 0.005,
      subtree_cost_usd: 0.015,
      cost_pct: 33.3,
      input_tokens: 1000,
      output_tokens: 200,
      llm_model: 'claude-sonnet-4-20250514',
      llm_provider: 'anthropic',
      trace_summary: {
        llm_calls: 2,
        tool_calls: 1,
        errors: 0,
        total_tokens: 1200,
        total_cost_usd: 0.005,
      },
      children: [
        {
          run_id: 'child-1',
          agent_name: 'audit-agent',
          agent_version: 'v2',
          status: 'completed',
          duration_ms: 5000,
          started_at: '2026-02-22T10:00:01Z',
          self_cost_usd: 0.006,
          subtree_cost_usd: 0.01,
          cost_pct: 40.0,
          input_tokens: 800,
          output_tokens: 150,
          llm_model: 'claude-haiku-4-5-20251001',
          llm_provider: 'anthropic',
          trace_summary: {
            llm_calls: 1,
            tool_calls: 1,
            errors: 0,
            total_tokens: 950,
            total_cost_usd: 0.006,
          },
          children: [
            {
              run_id: 'grandchild-1',
              agent_name: 'scanner-tool',
              agent_version: 'v1',
              status: 'completed',
              duration_ms: 3000,
              started_at: '2026-02-22T10:00:02Z',
              self_cost_usd: 0.004,
              subtree_cost_usd: 0.004,
              cost_pct: 26.7,
              input_tokens: 500,
              output_tokens: 100,
              llm_model: null,
              llm_provider: null,
              trace_summary: {
                llm_calls: 0,
                tool_calls: 2,
                errors: 0,
                total_tokens: 600,
                total_cost_usd: 0.004,
              },
              children: [],
            },
          ],
        },
      ],
    },
    ...overrides,
  }
}

async function runCommand(...args: string[]) {
  const program = new Command()
  program.exitOverride()
  registerDagCommand(program)

  const output: string[] = []
  const origWrite = process.stdout.write
  process.stdout.write = (chunk: any) => {
    output.push(String(chunk))
    return true
  }

  try {
    await program.parseAsync(['node', 'test', 'dag', ...args])
  } finally {
    process.stdout.write = origWrite
  }

  return output.join('')
}

describe('orch dag', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupDefaults()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('displays DAG for a full UUID', async () => {
    mockRequest
      .mockResolvedValueOnce({
        workspaces: [{ id: WORKSPACE_ID, slug: 'joe', name: 'Joe' }],
      })
      .mockResolvedValueOnce(makeDagResponse())

    const output = await runCommand(FULL_RUN_ID)

    expect(output).toContain('Orchestration DAG')
    expect(output).toContain('orchestrator')
    expect(output).toContain('audit-agent')
    expect(output).toContain('scanner-tool')
    expect(output).toContain('3')
    expect(mockRequest).toHaveBeenCalledTimes(2)
  })

  it('displays DAG with correct status icons', async () => {
    mockRequest
      .mockResolvedValueOnce({
        workspaces: [{ id: WORKSPACE_ID, slug: 'joe', name: 'Joe' }],
      })
      .mockResolvedValueOnce(makeDagResponse())

    const output = await runCommand(FULL_RUN_ID)

    // Completed nodes should have check marks (✓)
    expect(output).toContain('✓')
  })

  it('shows cost and duration in header', async () => {
    mockRequest
      .mockResolvedValueOnce({
        workspaces: [{ id: WORKSPACE_ID, slug: 'joe', name: 'Joe' }],
      })
      .mockResolvedValueOnce(makeDagResponse())

    const output = await runCommand(FULL_RUN_ID)

    expect(output).toContain('8.0s')
    expect(output).toContain('$0.0150')
  })

  it('resolves short UUID prefix', async () => {
    const shortId = 'a1b2c3d'

    mockRequest
      .mockResolvedValueOnce({
        workspaces: [{ id: WORKSPACE_ID, slug: 'joe', name: 'Joe' }],
      })
      .mockResolvedValueOnce({
        runs: [{ id: FULL_RUN_ID }],
        total: 1,
      })
      .mockResolvedValueOnce(makeDagResponse())

    const output = await runCommand(shortId)

    expect(output).toContain('orchestrator')
  })

  it('outputs JSON with --json flag', async () => {
    const dagResponse = makeDagResponse()

    mockRequest
      .mockResolvedValueOnce({
        workspaces: [{ id: WORKSPACE_ID, slug: 'joe', name: 'Joe' }],
      })
      .mockResolvedValueOnce(dagResponse)

    await runCommand(FULL_RUN_ID, '--json')

    expect(mockPrintJson).toHaveBeenCalledTimes(1)
    const jsonArg = mockPrintJson.mock.calls[0][0] as any
    expect(jsonArg.root_run_id).toBe(ROOT_RUN_ID)
    expect(jsonArg.node_count).toBe(3)
  })

  it('accepts req_xxx format and strips prefix', async () => {
    mockRequest
      .mockResolvedValueOnce({
        workspaces: [{ id: WORKSPACE_ID, slug: 'joe', name: 'Joe' }],
      })
      .mockResolvedValueOnce({
        runs: [{ id: FULL_RUN_ID }],
        total: 1,
      })
      .mockResolvedValueOnce(makeDagResponse())

    const output = await runCommand('req_a1b2c3d4e5f6')

    expect(output).toContain('orchestrator')
    // Verify the short ID resolution was called (3 requests: workspace, prefix search, dag)
    expect(mockRequest).toHaveBeenCalledTimes(3)
    // Verify prefix search used hex suffix without req_ prefix
    const prefixCall = mockRequest.mock.calls[1]
    expect(prefixCall[2]).toContain('run_id_prefix=a1b2c3d4e5f6')
  })

  it('throws error for invalid run ID format', async () => {
    mockRequest.mockResolvedValueOnce({
      workspaces: [{ id: WORKSPACE_ID, slug: 'joe', name: 'Joe' }],
    })

    await expect(runCommand('invalid/id')).rejects.toThrow()
  })

  it('throws error when run is not part of a chain', async () => {
    mockRequest
      .mockResolvedValueOnce({
        workspaces: [{ id: WORKSPACE_ID, slug: 'joe', name: 'Joe' }],
      })
      .mockRejectedValueOnce(new Error('Not part of a chain (404)'))

    await expect(runCommand(FULL_RUN_ID)).rejects.toThrow(
      'is not part of an orchestration chain'
    )
  })

  it('throws error without API key', async () => {
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: '',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'joe',
    })

    await expect(runCommand(FULL_RUN_ID)).rejects.toThrow('Missing API key')
  })

  it('throws error without workspace', async () => {
    mockLoadConfig.mockResolvedValue({})
    mockRequest.mockResolvedValueOnce({ workspaces: [] })

    await expect(runCommand(FULL_RUN_ID)).rejects.toThrow()
  })

  it('displays live indicator for running chains', async () => {
    const liveDag = makeDagResponse({
      is_live: true,
      active_count: 1,
      completed_count: 1,
      tree: {
        ...makeDagResponse().tree,
        status: 'running',
      },
    })

    mockRequest
      .mockResolvedValueOnce({
        workspaces: [{ id: WORKSPACE_ID, slug: 'joe', name: 'Joe' }],
      })
      .mockResolvedValueOnce(liveDag)

    const output = await runCommand(FULL_RUN_ID)

    expect(output).toContain('LIVE')
    expect(output).toContain('1 active')
  })

  it('shows trace summary (LLM calls, tool calls)', async () => {
    mockRequest
      .mockResolvedValueOnce({
        workspaces: [{ id: WORKSPACE_ID, slug: 'joe', name: 'Joe' }],
      })
      .mockResolvedValueOnce(makeDagResponse())

    const output = await runCommand(FULL_RUN_ID)

    expect(output).toContain('LLM')
    expect(output).toContain('tool')
    expect(output).toContain('tok')
  })

  it('shows failed status with error indicators', async () => {
    const failedDag = makeDagResponse({
      failed_count: 1,
      completed_count: 2,
      tree: {
        ...makeDagResponse().tree,
        children: [
          {
            ...makeDagResponse().tree.children[0],
            status: 'failed',
            trace_summary: {
              llm_calls: 1,
              tool_calls: 0,
              errors: 1,
              total_tokens: 500,
              total_cost_usd: 0.002,
            },
          },
        ],
      },
    })

    mockRequest
      .mockResolvedValueOnce({
        workspaces: [{ id: WORKSPACE_ID, slug: 'joe', name: 'Joe' }],
      })
      .mockResolvedValueOnce(failedDag)

    const output = await runCommand(FULL_RUN_ID)

    // Should show failure indicator
    expect(output).toContain('✗')
    expect(output).toContain('1 failed')
  })

  it('shows footer with trace/logs hints', async () => {
    mockRequest
      .mockResolvedValueOnce({
        workspaces: [{ id: WORKSPACE_ID, slug: 'joe', name: 'Joe' }],
      })
      .mockResolvedValueOnce(makeDagResponse())

    const output = await runCommand(FULL_RUN_ID)

    expect(output).toContain('orch trace')
    expect(output).toContain('orch logs')
  })

  it('shows most expensive agent in header', async () => {
    mockRequest
      .mockResolvedValueOnce({
        workspaces: [{ id: WORKSPACE_ID, slug: 'joe', name: 'Joe' }],
      })
      .mockResolvedValueOnce(makeDagResponse())

    const output = await runCommand(FULL_RUN_ID)

    expect(output).toContain('orchestrator')
  })

  it('handles fan-out (multiple children)', async () => {
    const fanoutDag = makeDagResponse({
      node_count: 4,
      tree: {
        ...makeDagResponse().tree,
        children: [
          {
            run_id: 'child-1',
            agent_name: 'worker-a',
            agent_version: 'v1',
            status: 'completed',
            duration_ms: 3000,
            started_at: '2026-02-22T10:00:01Z',
            self_cost_usd: 0.003,
            subtree_cost_usd: 0.003,
            cost_pct: 20.0,
            input_tokens: 500,
            output_tokens: 100,
            llm_model: null,
            llm_provider: null,
            trace_summary: { llm_calls: 0, tool_calls: 1, errors: 0, total_tokens: 600, total_cost_usd: 0.003 },
            children: [],
          },
          {
            run_id: 'child-2',
            agent_name: 'worker-b',
            agent_version: 'v1',
            status: 'completed',
            duration_ms: 4000,
            started_at: '2026-02-22T10:00:01Z',
            self_cost_usd: 0.004,
            subtree_cost_usd: 0.004,
            cost_pct: 26.7,
            input_tokens: 600,
            output_tokens: 120,
            llm_model: null,
            llm_provider: null,
            trace_summary: { llm_calls: 0, tool_calls: 2, errors: 0, total_tokens: 720, total_cost_usd: 0.004 },
            children: [],
          },
          {
            run_id: 'child-3',
            agent_name: 'worker-c',
            agent_version: 'v1',
            status: 'completed',
            duration_ms: 2000,
            started_at: '2026-02-22T10:00:01Z',
            self_cost_usd: 0.003,
            subtree_cost_usd: 0.003,
            cost_pct: 20.0,
            input_tokens: 400,
            output_tokens: 80,
            llm_model: null,
            llm_provider: null,
            trace_summary: { llm_calls: 0, tool_calls: 1, errors: 0, total_tokens: 480, total_cost_usd: 0.003 },
            children: [],
          },
        ],
      },
    })

    mockRequest
      .mockResolvedValueOnce({
        workspaces: [{ id: WORKSPACE_ID, slug: 'joe', name: 'Joe' }],
      })
      .mockResolvedValueOnce(fanoutDag)

    const output = await runCommand(FULL_RUN_ID)

    expect(output).toContain('worker-a')
    expect(output).toContain('worker-b')
    expect(output).toContain('worker-c')
    expect(output).toContain('4')
  })

  it('accepts --workspace flag', async () => {
    mockRequest
      .mockResolvedValueOnce({
        workspaces: [{ id: 'ws-custom', slug: 'custom-ws', name: 'Custom' }],
      })
      .mockResolvedValueOnce(makeDagResponse())

    const output = await runCommand(FULL_RUN_ID, '--workspace', 'custom-ws')

    expect(output).toContain('orchestrator')
    // Verify workspace resolution used correct slug
    expect(mockRequest).toHaveBeenCalledTimes(2)
  })
})
