/**
 * Tests for the replay command.
 *
 * Covers: replay submission, polling, short ID resolution, error cases.
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

import { registerReplayCommand } from './replay'
import { getResolvedConfig, loadConfig } from '../lib/config'
import { request } from '../lib/api'
import { printJson } from '../lib/output'

const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockLoadConfig = vi.mocked(loadConfig)
const mockRequest = vi.mocked(request)
const mockPrintJson = vi.mocked(printJson)

const WORKSPACE_ID = 'ws-123'
const FULL_RUN_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
const REPLAY_RUN_ID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
const JOB_ID = 'job-replay-1'

function setupDefaults() {
  mockGetResolvedConfig.mockResolvedValue({
    apiKey: 'sk_test_123',
    apiUrl: 'https://api.test.com',
    defaultOrg: 'joe',
  })
  mockLoadConfig.mockResolvedValue({ workspace: 'joe' })
}

function makeReplayResponse(overrides: Record<string, unknown> = {}) {
  return {
    run_id: REPLAY_RUN_ID,
    job_id: JOB_ID,
    replay_of_run_id: FULL_RUN_ID,
    status: 'queued',
    ...overrides,
  }
}

function makeRunLogs(overrides: Record<string, unknown> = {}) {
  return {
    run_id: REPLAY_RUN_ID,
    agent_name: 'test-agent',
    agent_version: 'v1',
    run_status: 'completed',
    error_message: null,
    input_data: { query: 'test' },
    output_data: { result: 'ok' },
    has_execution_log: true,
    stdout: 'hello world\n',
    stderr: null,
    exit_code: 0,
    execution_time_ms: 1500,
    ...overrides,
  }
}

describe('replay command', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })

    program = new Command()
    program.exitOverride()
    registerReplayCommand(program)

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    setupDefaults()
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  // ─── --no-wait mode ──────────────────────────────────────────────

  it('submits replay and returns immediately with --no-wait', async () => {
    mockRequest.mockImplementation(async (_config, method, path) => {
      if (path === '/workspaces') {
        return { workspaces: [{ id: WORKSPACE_ID, name: 'Joe', slug: 'joe' }] }
      }
      if (typeof path === 'string' && path.includes('/replay')) {
        return makeReplayResponse()
      }
      return {}
    })

    await program.parseAsync(['node', 'test', 'replay', FULL_RUN_ID, '--no-wait'])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain('Replay queued')
    expect(output).toContain(REPLAY_RUN_ID)
    expect(output).toContain(JOB_ID)
  })

  it('submits replay with --no-wait --json', async () => {
    mockRequest.mockImplementation(async (_config, method, path) => {
      if (path === '/workspaces') {
        return { workspaces: [{ id: WORKSPACE_ID, name: 'Joe', slug: 'joe' }] }
      }
      if (typeof path === 'string' && path.includes('/replay')) {
        return makeReplayResponse()
      }
      return {}
    })

    await program.parseAsync(['node', 'test', 'replay', FULL_RUN_ID, '--no-wait', '--json'])

    expect(mockPrintJson).toHaveBeenCalledWith(
      expect.objectContaining({
        run_id: REPLAY_RUN_ID,
        job_id: JOB_ID,
      })
    )
  })

  // ─── Replay with wait (polling) ──────────────────────────────────

  it('submits replay and polls for completion', async () => {
    let pollCount = 0

    mockRequest.mockImplementation(async (_config, method, path) => {
      if (path === '/workspaces') {
        return { workspaces: [{ id: WORKSPACE_ID, name: 'Joe', slug: 'joe' }] }
      }
      if (typeof path === 'string' && path.includes('/replay')) {
        return makeReplayResponse()
      }
      // Poll for run status
      if (typeof path === 'string' && path === `/workspaces/${WORKSPACE_ID}/runs/${REPLAY_RUN_ID}`) {
        pollCount++
        if (pollCount < 2) {
          return { id: REPLAY_RUN_ID, status: 'running' }
        }
        return { id: REPLAY_RUN_ID, status: 'completed' }
      }
      // Final logs
      if (typeof path === 'string' && path.includes(`/runs/${REPLAY_RUN_ID}/logs`)) {
        return makeRunLogs()
      }
      return {}
    })

    await program.parseAsync(['node', 'test', 'replay', FULL_RUN_ID])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain(`Replay ${REPLAY_RUN_ID}`)
    expect(output).toContain('test-agent@v1')
    expect(output).toContain('hello world')
    expect(pollCount).toBeGreaterThanOrEqual(2)
  })

  it('shows error output for failed replay', async () => {
    mockRequest.mockImplementation(async (_config, method, path) => {
      if (path === '/workspaces') {
        return { workspaces: [{ id: WORKSPACE_ID, name: 'Joe', slug: 'joe' }] }
      }
      if (typeof path === 'string' && path.includes('/replay')) {
        return makeReplayResponse()
      }
      if (typeof path === 'string' && path === `/workspaces/${WORKSPACE_ID}/runs/${REPLAY_RUN_ID}`) {
        return { id: REPLAY_RUN_ID, status: 'failed' }
      }
      if (typeof path === 'string' && path.includes(`/runs/${REPLAY_RUN_ID}/logs`)) {
        return makeRunLogs({
          run_status: 'failed',
          error_message: 'SANDBOX_ERROR: process exited with code 1',
          output_data: null,
        })
      }
      return {}
    })

    await program.parseAsync(['node', 'test', 'replay', FULL_RUN_ID])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain('SANDBOX_ERROR')
  })

  it('outputs JSON when --json is used with wait', async () => {
    mockRequest.mockImplementation(async (_config, method, path) => {
      if (path === '/workspaces') {
        return { workspaces: [{ id: WORKSPACE_ID, name: 'Joe', slug: 'joe' }] }
      }
      if (typeof path === 'string' && path.includes('/replay')) {
        return makeReplayResponse()
      }
      if (typeof path === 'string' && path === `/workspaces/${WORKSPACE_ID}/runs/${REPLAY_RUN_ID}`) {
        return { id: REPLAY_RUN_ID, status: 'completed' }
      }
      if (typeof path === 'string' && path.includes(`/runs/${REPLAY_RUN_ID}/logs`)) {
        return makeRunLogs()
      }
      return {}
    })

    await program.parseAsync(['node', 'test', 'replay', FULL_RUN_ID, '--json'])

    expect(mockPrintJson).toHaveBeenCalledWith(
      expect.objectContaining({
        replay: expect.objectContaining({ run_id: REPLAY_RUN_ID }),
        result: expect.objectContaining({ agent_name: 'test-agent' }),
      })
    )
  })

  // ─── Short run ID resolution ──────────────────────────────────────

  it('resolves short run ID prefix before replaying', async () => {
    mockRequest.mockImplementation(async (_config, method, path) => {
      if (path === '/workspaces') {
        return { workspaces: [{ id: WORKSPACE_ID, name: 'Joe', slug: 'joe' }] }
      }
      // Short ID resolution
      if (typeof path === 'string' && path.includes('/runs?') && path.includes('run_id_prefix')) {
        return {
          runs: [{ id: FULL_RUN_ID, agent_name: 'test', agent_version: 'v1', status: 'completed' }],
          total: 1,
        }
      }
      if (typeof path === 'string' && path.includes(`/runs/${FULL_RUN_ID}/replay`)) {
        return makeReplayResponse()
      }
      if (typeof path === 'string' && path === `/workspaces/${WORKSPACE_ID}/runs/${REPLAY_RUN_ID}`) {
        return { id: REPLAY_RUN_ID, status: 'completed' }
      }
      if (typeof path === 'string' && path.includes(`/runs/${REPLAY_RUN_ID}/logs`)) {
        return makeRunLogs()
      }
      return {}
    })

    await program.parseAsync(['node', 'test', 'replay', 'a1b2c3d4', '--no-wait'])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain('Replay queued')
  })

  it('errors on ambiguous short run ID', async () => {
    mockRequest.mockImplementation(async (_config, method, path) => {
      if (path === '/workspaces') {
        return { workspaces: [{ id: WORKSPACE_ID, name: 'Joe', slug: 'joe' }] }
      }
      if (typeof path === 'string' && path.includes('/runs?')) {
        return {
          runs: [
            { id: 'aabbccdd-1111-2222-3333-444455556666' },
            { id: 'aabbccdd-9999-8888-7777-666655554444' },
          ],
          total: 2,
        }
      }
      return {}
    })

    await expect(
      program.parseAsync(['node', 'test', 'replay', 'aabbccdd', '--no-wait'])
    ).rejects.toThrow('Ambiguous')
  })

  it('errors on no matching short run ID', async () => {
    mockRequest.mockImplementation(async (_config, method, path) => {
      if (path === '/workspaces') {
        return { workspaces: [{ id: WORKSPACE_ID, name: 'Joe', slug: 'joe' }] }
      }
      if (typeof path === 'string' && path.includes('/runs?')) {
        return { runs: [], total: 0 }
      }
      return {}
    })

    await expect(
      program.parseAsync(['node', 'test', 'replay', 'deadbeef', '--no-wait'])
    ).rejects.toThrow("No run found matching 'deadbeef'")
  })

  // ─── Invalid inputs ────────────────────────────────────────────────

  it('rejects invalid run ID format', async () => {
    mockRequest.mockImplementation(async (_config, method, path) => {
      if (path === '/workspaces') {
        return { workspaces: [{ id: WORKSPACE_ID, name: 'Joe', slug: 'joe' }] }
      }
      return {}
    })

    await expect(
      program.parseAsync(['node', 'test', 'replay', 'not-hex!', '--no-wait'])
    ).rejects.toThrow('Invalid run ID')
  })

  it('requires API key', async () => {
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: '',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'joe',
    })

    await expect(
      program.parseAsync(['node', 'test', 'replay', FULL_RUN_ID, '--no-wait'])
    ).rejects.toThrow('Missing API key')
  })

  it('requires workspace', async () => {
    mockLoadConfig.mockResolvedValue({})

    await expect(
      program.parseAsync(['node', 'test', 'replay', FULL_RUN_ID, '--no-wait'])
    ).rejects.toThrow('No workspace specified')
  })

  // ─── Options forwarding ────────────────────────────────────────────

  it('passes reason and override-policy to replay request', async () => {
    let replayBody: Record<string, unknown> = {}

    mockRequest.mockImplementation(async (_config, method, path, options) => {
      if (path === '/workspaces') {
        return { workspaces: [{ id: WORKSPACE_ID, name: 'Joe', slug: 'joe' }] }
      }
      if (typeof path === 'string' && path.includes('/replay')) {
        if (options?.body) {
          replayBody = JSON.parse(options.body as string)
        }
        return makeReplayResponse()
      }
      return {}
    })

    await program.parseAsync([
      'node', 'test', 'replay', FULL_RUN_ID,
      '--no-wait',
      '--reason', 'debugging timeout',
      '--override-policy', 'policy-abc',
    ])

    expect(replayBody.reason).toBe('debugging timeout')
    expect(replayBody.override_provider_policy_id).toBe('policy-abc')
  })

  // ─── Footer hints ──────────────────────────────────────────────────

  it('shows trace hint in footer after successful replay', async () => {
    mockRequest.mockImplementation(async (_config, method, path) => {
      if (path === '/workspaces') {
        return { workspaces: [{ id: WORKSPACE_ID, name: 'Joe', slug: 'joe' }] }
      }
      if (typeof path === 'string' && path.includes('/replay')) {
        return makeReplayResponse()
      }
      if (typeof path === 'string' && path === `/workspaces/${WORKSPACE_ID}/runs/${REPLAY_RUN_ID}`) {
        return { id: REPLAY_RUN_ID, status: 'completed' }
      }
      if (typeof path === 'string' && path.includes(`/runs/${REPLAY_RUN_ID}/logs`)) {
        return makeRunLogs()
      }
      return {}
    })

    await program.parseAsync(['node', 'test', 'replay', FULL_RUN_ID])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain('orch trace')
  })

  it('shows orch logs hint in --no-wait mode', async () => {
    mockRequest.mockImplementation(async (_config, method, path) => {
      if (path === '/workspaces') {
        return { workspaces: [{ id: WORKSPACE_ID, name: 'Joe', slug: 'joe' }] }
      }
      if (typeof path === 'string' && path.includes('/replay')) {
        return makeReplayResponse()
      }
      return {}
    })

    await program.parseAsync(['node', 'test', 'replay', FULL_RUN_ID, '--no-wait'])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain('orch logs')
  })
})
