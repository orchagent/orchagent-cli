/**
 * Tests for schedule command --json output (T12-09).
 *
 * schedule list/info/runs already have --json. These tests cover the
 * mutating subcommands that were missing it: create, update, trigger,
 * delete, test-alert, regenerate-webhook.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

// ── mocks ──────────────────────────────────────────────────────────

vi.mock('../lib/config', () => ({
  getResolvedConfig: vi.fn(),
  loadConfig: vi.fn().mockResolvedValue({ workspace: 'test-ws' }),
}))

vi.mock('../lib/api', () => ({
  request: vi.fn(),
  getAgentWithFallback: vi.fn(),
}))

vi.mock('../lib/agent-ref', () => ({
  parseAgentRef: vi.fn(),
}))

import { registerScheduleCommand } from './schedule'
import { getResolvedConfig, loadConfig } from '../lib/config'
import { request, getAgentWithFallback } from '../lib/api'
import { parseAgentRef } from '../lib/agent-ref'

const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockLoadConfig = vi.mocked(loadConfig)
const mockRequest = vi.mocked(request)
const mockGetAgentWithFallback = vi.mocked(getAgentWithFallback)
const mockParseAgentRef = vi.mocked(parseAgentRef)

function allStdout(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((c) => c[0]).join('')
}

// ── fixtures ───────────────────────────────────────────────────────

const WORKSPACE_ID = 'ws-abc-123'

const SCHEDULE_FIXTURE = {
  id: 'sched-uuid-001',
  workspace_id: WORKSPACE_ID,
  agent_id: 'agent-uuid-001',
  agent_name: 'my-agent',
  agent_version: 'v1',
  schedule_type: 'cron' as const,
  cron_expression: '0 9 * * 1',
  timezone: 'UTC',
  input_data: {},
  llm_provider: null,
  enabled: true,
  auto_update: true,
  last_run_at: null,
  last_run_status: null,
  next_run_at: '2026-03-02T09:00:00Z',
  run_count: 0,
  consecutive_failures: 0,
  max_consecutive_failures: 5,
  auto_disabled_at: null,
  alert_webhook_url: null,
  alert_on_failure_count: null,
  created_at: '2026-02-25T12:00:00Z',
}

const TRIGGER_FIXTURE = {
  run_id: 'run-uuid-001',
  status: 'completed',
  duration_ms: 1234,
  output: { result: 'done' },
  error: null,
}

// ── helpers ────────────────────────────────────────────────────────

function setupMocks() {
  mockGetResolvedConfig.mockResolvedValue({
    apiKey: 'sk_test_123',
    apiUrl: 'https://api.test.com',
    defaultOrg: 'myorg',
  })

  mockLoadConfig.mockResolvedValue({ workspace: 'test-ws' } as never)

  mockParseAgentRef.mockReturnValue({ org: 'myorg', agent: 'my-agent', version: 'latest' })

  // resolveWorkspaceId: first call returns workspaces list, rest are per-subcommand
  mockRequest.mockImplementation(async (_config, method, path) => {
    if (method === 'GET' && (path as string).endsWith('/workspaces')) {
      return { workspaces: [{ id: WORKSPACE_ID, name: 'Test WS', slug: 'test-ws' }] }
    }
    // resolveScheduleId: list schedules for prefix match
    if (method === 'GET' && (path as string).includes('/schedules?limit=200')) {
      return { schedules: [SCHEDULE_FIXTURE], total: 1 }
    }
    // create / update
    if ((method === 'POST' || method === 'PATCH') && (path as string).match(/\/schedules(\/[^/]+)?$/) && !(path as string).includes('trigger') && !(path as string).includes('test-alert') && !(path as string).includes('regenerate')) {
      return { schedule: SCHEDULE_FIXTURE }
    }
    // trigger
    if (method === 'POST' && (path as string).includes('/trigger')) {
      return TRIGGER_FIXTURE
    }
    // delete
    if (method === 'DELETE') {
      return { deleted: true }
    }
    // test-alert
    if (method === 'POST' && (path as string).includes('/test-alert')) {
      return { success: true }
    }
    // regenerate-webhook
    if (method === 'POST' && (path as string).includes('/regenerate-webhook')) {
      return { webhook_url: 'https://hook.example.com/new', message: 'regenerated' }
    }
    return {}
  })

  mockGetAgentWithFallback.mockResolvedValue({
    id: 'agent-uuid-001',
    version: 'v1',
    name: 'my-agent',
  } as never)
}

// ── tests ──────────────────────────────────────────────────────────

describe('schedule subcommands --json output (T12-09)', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerScheduleCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    setupMocks()
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  // ── schedule create ──

  it('schedule create --json outputs valid JSON', async () => {
    await program.parseAsync([
      'node', 'test', 'schedule', 'create', 'myorg/my-agent',
      '--cron', '0 9 * * 1', '--json',
    ])

    const output = allStdout(stdoutSpy)
    const parsed = JSON.parse(output)
    expect(parsed.schedule).toBeDefined()
    expect(parsed.schedule.id).toBe('sched-uuid-001')
    expect(parsed.schedule.schedule_type).toBe('cron')
  })

  it('schedule create without --json shows human-readable output', async () => {
    await program.parseAsync([
      'node', 'test', 'schedule', 'create', 'myorg/my-agent',
      '--cron', '0 9 * * 1',
    ])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('Schedule created')
    expect(output).toContain('sched-uuid-001')
  })

  // ── schedule update ──

  it('schedule update --json outputs valid JSON', async () => {
    await program.parseAsync([
      'node', 'test', 'schedule', 'update', 'sched-uuid-001',
      '--cron', '0 10 * * 1', '--json',
    ])

    const output = allStdout(stdoutSpy)
    const parsed = JSON.parse(output)
    expect(parsed.schedule).toBeDefined()
    expect(parsed.schedule.id).toBe('sched-uuid-001')
  })

  it('schedule update without --json shows human-readable output', async () => {
    await program.parseAsync([
      'node', 'test', 'schedule', 'update', 'sched-uuid-001',
      '--cron', '0 10 * * 1',
    ])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('Schedule updated')
  })

  // ── schedule trigger ──

  it('schedule trigger --json outputs valid JSON', async () => {
    await program.parseAsync([
      'node', 'test', 'schedule', 'trigger', 'sched-uuid-001', '--json',
    ])

    const output = allStdout(stdoutSpy)
    const parsed = JSON.parse(output)
    expect(parsed.run_id).toBe('run-uuid-001')
    expect(parsed.status).toBe('completed')
    expect(parsed.duration_ms).toBe(1234)
    expect(parsed.output).toEqual({ result: 'done' })
  })

  it('schedule trigger without --json shows human-readable output', async () => {
    await program.parseAsync([
      'node', 'test', 'schedule', 'trigger', 'sched-uuid-001',
    ])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('Run completed')
    expect(output).toContain('run-uuid-001')
  })

  // ── schedule delete ──

  it('schedule delete --json outputs valid JSON', async () => {
    await program.parseAsync([
      'node', 'test', 'schedule', 'delete', 'sched-uuid-001', '--yes', '--json',
    ])

    const output = allStdout(stdoutSpy)
    const parsed = JSON.parse(output)
    expect(parsed.deleted).toBe(true)
    expect(parsed.id).toBe('sched-uuid-001')
  })

  it('schedule delete without --json shows human-readable output', async () => {
    await program.parseAsync([
      'node', 'test', 'schedule', 'delete', 'sched-uuid-001', '--yes',
    ])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('deleted')
  })

  // ── schedule test-alert ──

  it('schedule test-alert --json outputs valid JSON', async () => {
    await program.parseAsync([
      'node', 'test', 'schedule', 'test-alert', 'sched-uuid-001', '--json',
    ])

    const output = allStdout(stdoutSpy)
    const parsed = JSON.parse(output)
    expect(parsed.success).toBe(true)
    expect(parsed.schedule_id).toBe('sched-uuid-001')
  })

  it('schedule test-alert without --json shows human-readable output', async () => {
    await program.parseAsync([
      'node', 'test', 'schedule', 'test-alert', 'sched-uuid-001',
    ])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('Test alert delivered')
  })

  // ── schedule regenerate-webhook ──

  it('schedule regenerate-webhook --json outputs valid JSON', async () => {
    await program.parseAsync([
      'node', 'test', 'schedule', 'regenerate-webhook', 'sched-uuid-001', '--yes', '--json',
    ])

    const output = allStdout(stdoutSpy)
    const parsed = JSON.parse(output)
    expect(parsed.webhook_url).toBe('https://hook.example.com/new')
    expect(parsed.schedule_id).toBe('sched-uuid-001')
  })

  it('schedule regenerate-webhook without --json shows human-readable output', async () => {
    await program.parseAsync([
      'node', 'test', 'schedule', 'regenerate-webhook', 'sched-uuid-001', '--yes',
    ])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('Webhook secret regenerated')
  })
})
