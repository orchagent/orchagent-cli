/**
 * Tests for the estimate command (IDEA-005: Cost estimation before run).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

vi.mock('../lib/config', () => ({
  getResolvedConfig: vi.fn(),
  loadConfig: vi.fn().mockResolvedValue({}),
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
    getAgentCostEstimate: vi.fn(),
  }
})

import { registerEstimateCommand } from './estimate'
import { getResolvedConfig } from '../lib/config'
import { getAgentCostEstimate, ApiError } from '../lib/api'

const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockGetAgentCostEstimate = vi.mocked(getAgentCostEstimate)

function allStdout(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map(c => c[0]).join('')
}

function allStderr(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map(c => c[0]).join('')
}

describe('orch estimate', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerEstimateCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as never)
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'test-org',
    })
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    exitSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('displays cost estimate for an agent with history', async () => {
    mockGetAgentCostEstimate.mockResolvedValue({
      agent: 'myorg/my-agent@v1',
      type: 'agent',
      execution_engine: 'managed_loop',
      supported_providers: ['anthropic', 'openai'],
      estimate: {
        sample_size: 25,
        avg_cost_usd: 0.015,
        p50_cost_usd: 0.012,
        p95_cost_usd: 0.045,
        avg_input_tokens: 1500,
        avg_output_tokens: 500,
        avg_duration_ms: 3200,
        success_rate: 96.0,
        provider_breakdown: [
          { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', runs: 20, total_cost_usd: 0.24, avg_cost_usd: 0.012 },
          { provider: 'openai', model: 'gpt-4o-mini', runs: 5, total_cost_usd: 0.1, avg_cost_usd: 0.02 },
        ],
        period_days: 30,
      },
      metadata: { request_id: 'test-123' },
    })

    await program.parseAsync(['node', 'test', 'estimate', 'myorg/my-agent@v1'])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('myorg/my-agent@v1')
    expect(output).toContain('Type: agent')
    expect(output).toContain('Cost Estimate')
    expect(output).toContain('25 runs')
    expect(output).toContain('Average')
    expect(output).toContain('Median')
    expect(output).toContain('95th pct')
    expect(output).toContain('Tokens')
    expect(output).toContain('Duration')
    expect(output).toContain('By Provider')
    expect(output).toContain('anthropic')
    expect(output).toContain('openai')
  })

  it('shows warning for agent with no run history', async () => {
    mockGetAgentCostEstimate.mockResolvedValue({
      agent: 'myorg/new-agent@v1',
      type: 'prompt',
      execution_engine: 'direct_llm',
      supported_providers: ['any'],
      estimate: {
        sample_size: 0,
      },
      metadata: { request_id: 'test-456' },
    })

    await program.parseAsync(['node', 'test', 'estimate', 'myorg/new-agent@v1'])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('No run history available')
  })

  it('outputs JSON when --json is specified', async () => {
    mockGetAgentCostEstimate.mockResolvedValue({
      agent: 'myorg/my-agent@latest',
      type: 'agent',
      execution_engine: 'managed_loop',
      supported_providers: ['any'],
      estimate: {
        sample_size: 10,
        avg_cost_usd: 0.01,
        p50_cost_usd: 0.008,
        p95_cost_usd: 0.03,
        avg_input_tokens: 1000,
        avg_output_tokens: 300,
        avg_duration_ms: 2000,
        success_rate: 100.0,
        provider_breakdown: [],
        period_days: 30,
      },
      metadata: { request_id: 'test-789' },
    })

    await program.parseAsync(['node', 'test', 'estimate', 'myorg/my-agent', '--json'])

    const output = allStdout(stdoutSpy)
    const parsed = JSON.parse(output)
    expect(parsed.agent).toBe('myorg/my-agent@latest')
    expect(parsed.estimate.sample_size).toBe(10)
    expect(parsed.estimate.avg_cost_usd).toBe(0.01)
  })

  it('calls API with correct parameters', async () => {
    mockGetAgentCostEstimate.mockResolvedValue({
      agent: 'orchagent/scanner@v3',
      type: 'tool',
      execution_engine: 'code_runtime',
      supported_providers: ['any'],
      estimate: { sample_size: 0 },
      metadata: { request_id: 'test-abc' },
    })

    await program.parseAsync(['node', 'test', 'estimate', 'orchagent/scanner@v3'])

    expect(mockGetAgentCostEstimate).toHaveBeenCalledWith(
      expect.any(Object),
      'orchagent',
      'scanner',
      'v3'
    )
  })

  it('defaults to latest version when not specified', async () => {
    mockGetAgentCostEstimate.mockResolvedValue({
      agent: 'myorg/agent@latest',
      type: 'agent',
      execution_engine: null,
      supported_providers: ['any'],
      estimate: { sample_size: 0 },
      metadata: { request_id: 'test-def' },
    })

    await program.parseAsync(['node', 'test', 'estimate', 'myorg/agent'])

    expect(mockGetAgentCostEstimate).toHaveBeenCalledWith(
      expect.any(Object),
      'myorg',
      'agent',
      'latest'
    )
  })

  it('handles 404 error gracefully', async () => {
    mockGetAgentCostEstimate.mockRejectedValue(
      new ApiError('Not found', 404)
    )

    await expect(
      program.parseAsync(['node', 'test', 'estimate', 'nonexistent/agent'])
    ).rejects.toThrow()

    const errOutput = allStderr(stderrSpy)
    expect(errOutput).toContain('not found')
  })

  it('displays execution engine when available', async () => {
    mockGetAgentCostEstimate.mockResolvedValue({
      agent: 'myorg/tool@v1',
      type: 'tool',
      execution_engine: 'code_runtime',
      supported_providers: ['any'],
      estimate: { sample_size: 0 },
      metadata: { request_id: 'test-eng' },
    })

    await program.parseAsync(['node', 'test', 'estimate', 'myorg/tool@v1'])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('Engine: code_runtime')
  })

  it('displays success rate with correct color threshold', async () => {
    mockGetAgentCostEstimate.mockResolvedValue({
      agent: 'myorg/reliable@v1',
      type: 'agent',
      execution_engine: 'managed_loop',
      supported_providers: ['any'],
      estimate: {
        sample_size: 100,
        avg_cost_usd: 0.01,
        p50_cost_usd: 0.008,
        p95_cost_usd: 0.025,
        avg_input_tokens: 800,
        avg_output_tokens: 200,
        avg_duration_ms: 1500,
        success_rate: 98.5,
        provider_breakdown: [],
        period_days: 30,
      },
      metadata: { request_id: 'test-rate' },
    })

    await program.parseAsync(['node', 'test', 'estimate', 'myorg/reliable@v1'])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('98.5%')
  })

  it('shows provider model names', async () => {
    mockGetAgentCostEstimate.mockResolvedValue({
      agent: 'myorg/multi@v1',
      type: 'agent',
      execution_engine: 'managed_loop',
      supported_providers: ['anthropic', 'gemini'],
      estimate: {
        sample_size: 30,
        avg_cost_usd: 0.02,
        p50_cost_usd: 0.015,
        p95_cost_usd: 0.05,
        avg_input_tokens: 2000,
        avg_output_tokens: 600,
        avg_duration_ms: 4000,
        success_rate: 90.0,
        provider_breakdown: [
          { provider: 'anthropic', model: 'claude-sonnet-4-6', runs: 20, total_cost_usd: 0.4, avg_cost_usd: 0.02 },
          { provider: 'gemini', model: 'gemini-2.5-flash', runs: 10, total_cost_usd: 0.1, avg_cost_usd: 0.01 },
        ],
        period_days: 30,
      },
      metadata: { request_id: 'test-prov' },
    })

    await program.parseAsync(['node', 'test', 'estimate', 'myorg/multi@v1'])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('claude-sonnet-4-6')
    expect(output).toContain('gemini-2.5-flash')
  })
})
