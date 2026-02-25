/**
 * Tests for BUG-11-07: `orch security test` ignores workspace vault keys.
 *
 * The security test command didn't resolve workspace IDs or send
 * X-Workspace-Id headers, so gateway vault key lookups used the
 * personal org instead of the team workspace.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

// Mock modules before importing
vi.mock('fs/promises')
vi.mock('../lib/config')
vi.mock('../lib/api')
vi.mock('../lib/analytics', () => ({
  track: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../lib/spinner', () => ({
  createSpinner: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
  })),
}))
vi.mock('../lib/output', () => ({
  printJson: vi.fn(),
}))

import { registerSecurityCommand } from './security'
import { getResolvedConfig, loadConfig } from '../lib/config'
import { safeFetchWithRetryForCalls, resolveWorkspaceIdForOrg } from '../lib/api'

const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockLoadConfig = vi.mocked(loadConfig)
const mockSafeFetchWithRetryForCalls = vi.mocked(safeFetchWithRetryForCalls)
const mockResolveWorkspaceIdForOrg = vi.mocked(resolveWorkspaceIdForOrg)

function mockSuccessfulScanResponse() {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      agent_id: 'team-org/test-agent/latest',
      scanned_at: '2026-02-25T00:00:00Z',
      total_attacks: 35,
      vulnerabilities_found: 0,
      risk_level: 'NONE',
      vulnerabilities: [],
      summary: { by_severity: {}, by_category: {} },
    }),
  } as unknown as Response
}

describe('security test workspace support (BUG-11-07)', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()

    program = new Command()
    program.exitOverride()
    registerSecurityCommand(program)

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'default-org',
    })

    mockLoadConfig.mockResolvedValue({})
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('resolves workspace ID and sends X-Workspace-Id header for team workspace', async () => {
    mockResolveWorkspaceIdForOrg.mockResolvedValue('ws-team-456')
    mockSafeFetchWithRetryForCalls.mockResolvedValue(mockSuccessfulScanResponse())

    await program.parseAsync([
      'node', 'test', 'security', 'test', 'team-org/test-agent',
      '--key', 'sk-test-key', '--provider', 'openai',
    ])

    // Verify resolveWorkspaceIdForOrg was called with the org
    expect(mockResolveWorkspaceIdForOrg).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk_test_123' }),
      'team-org'
    )

    // Verify X-Workspace-Id header was sent
    const fetchCall = mockSafeFetchWithRetryForCalls.mock.calls[0]
    expect(fetchCall[1]?.headers?.['X-Workspace-Id']).toBe('ws-team-456')
  })

  it('does not send X-Workspace-Id for personal org', async () => {
    mockResolveWorkspaceIdForOrg.mockResolvedValue(undefined)
    mockSafeFetchWithRetryForCalls.mockResolvedValue(mockSuccessfulScanResponse())

    await program.parseAsync([
      'node', 'test', 'security', 'test', 'personal-org/test-agent',
      '--key', 'sk-test-key', '--provider', 'openai',
    ])

    // Verify no X-Workspace-Id header
    const fetchCall = mockSafeFetchWithRetryForCalls.mock.calls[0]
    expect(fetchCall[1]?.headers?.['X-Workspace-Id']).toBeUndefined()
  })

  it('sends provider preference when --provider specified without --key', async () => {
    // Set up env var so detectLlmKey finds a key for the requested provider
    const origEnv = process.env.GEMINI_API_KEY
    process.env.GEMINI_API_KEY = 'test-gemini-key'

    mockResolveWorkspaceIdForOrg.mockResolvedValue('ws-team-789')
    mockSafeFetchWithRetryForCalls.mockResolvedValue(mockSuccessfulScanResponse())

    await program.parseAsync([
      'node', 'test', 'security', 'test', 'team-org/test-agent',
      '--provider', 'gemini',
    ])

    // Verify X-LLM-API-Key was sent with the gemini key
    const fetchCall = mockSafeFetchWithRetryForCalls.mock.calls[0]
    expect(fetchCall[1]?.headers?.['X-LLM-API-Key']).toBe('test-gemini-key')
    expect(fetchCall[1]?.headers?.['X-Workspace-Id']).toBe('ws-team-789')

    // Restore
    if (origEnv !== undefined) {
      process.env.GEMINI_API_KEY = origEnv
    } else {
      delete process.env.GEMINI_API_KEY
    }
  })

  it('omits X-LLM-API-Key when no local key found (relies on gateway vault)', async () => {
    // No env vars set, no --key flag
    const origKeys = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      OLLAMA_HOST: process.env.OLLAMA_HOST,
    }
    delete process.env.OPENAI_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.GEMINI_API_KEY
    delete process.env.OLLAMA_HOST

    mockResolveWorkspaceIdForOrg.mockResolvedValue('ws-team-vault')
    mockSafeFetchWithRetryForCalls.mockResolvedValue(mockSuccessfulScanResponse())

    await program.parseAsync([
      'node', 'test', 'security', 'test', 'team-org/test-agent',
    ])

    // Should still send X-Workspace-Id so gateway can find vault keys
    const fetchCall = mockSafeFetchWithRetryForCalls.mock.calls[0]
    expect(fetchCall[1]?.headers?.['X-Workspace-Id']).toBe('ws-team-vault')
    // No local key — header should be absent (gateway will check vault)
    expect(fetchCall[1]?.headers?.['X-LLM-API-Key']).toBeUndefined()

    // Restore
    for (const [k, v] of Object.entries(origKeys)) {
      if (v !== undefined) process.env[k] = v
      else delete process.env[k]
    }
  })
})
