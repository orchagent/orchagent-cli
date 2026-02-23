/**
 * Tests for the update command.
 *
 * UX-6: Verify that `orch update --check` handles private agents correctly
 * by falling back to the authenticated endpoint instead of showing
 * "could not fetch latest" for private agents.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

vi.mock('../lib/config', () => ({
  getResolvedConfig: vi.fn(),
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
    publicRequest: vi.fn(),
    getOrg: vi.fn(),
    getMyAgent: vi.fn(),
    resolveWorkspaceIdForOrg: vi.fn().mockResolvedValue(undefined),
  }
})
vi.mock('../lib/errors', () => {
  class NetworkError extends Error {
    exitCode = 9
    constructor(url: string, cause?: Error) {
      super(`Unable to connect to ${new URL(url).host}`)
      this.cause = cause
    }
  }
  return { NetworkError }
})
vi.mock('../lib/analytics', () => ({
  track: vi.fn(),
}))
vi.mock('../lib/installed', () => ({
  getInstalled: vi.fn(),
  trackInstall: vi.fn(),
  checkModified: vi.fn(),
  computeHash: vi.fn().mockReturnValue('hash123'),
}))
vi.mock('../lib/agents-md-utils', () => ({
  mergeAgentsMdContent: vi.fn((_existing, content) => content),
}))
vi.mock('../adapters', () => ({
  adapterRegistry: {
    get: vi.fn().mockReturnValue({
      name: 'claude-code',
      version: '1.0',
      canConvert: () => ({ canConvert: true, warnings: [], errors: [] }),
      convert: () => [{ filename: 'test.md', content: 'test', installPath: '.claude' }],
    }),
  },
}))

import { registerUpdateCommand } from './update'
import { getResolvedConfig } from '../lib/config'
import { publicRequest, getOrg, getMyAgent, ApiError } from '../lib/api'
import { NetworkError } from '../lib/errors'
import { getInstalled, checkModified } from '../lib/installed'

const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockPublicRequest = vi.mocked(publicRequest)
const mockGetOrg = vi.mocked(getOrg)
const mockGetMyAgent = vi.mocked(getMyAgent)
const mockGetInstalled = vi.mocked(getInstalled)
const mockCheckModified = vi.mocked(checkModified)

function allStdout(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map(c => c[0]).join('')
}

function makeInstalledAgent(overrides: Record<string, unknown> = {}) {
  return {
    agent: 'joe/my-agent',
    version: 'v1',
    format: 'claude-code',
    scope: 'user' as const,
    path: '/home/user/.claude/test.md',
    installedAt: '2026-02-20T00:00:00Z',
    adapterVersion: '1.0',
    contentHash: 'abc123',
    ...overrides,
  }
}

describe('UX-6: orch update --check for private agents', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerUpdateCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'joe',
    })
    mockCheckModified.mockResolvedValue({ modified: false, missing: false })
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('shows up-to-date for public agent with matching version', async () => {
    mockGetInstalled.mockResolvedValue([makeInstalledAgent()])
    mockPublicRequest.mockResolvedValue({
      id: 'a1',
      name: 'my-agent',
      version: 'v1',
      org_slug: 'joe',
    })

    await program.parseAsync(['node', 'test', 'update', '--check'])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('joe/my-agent@v1')
    expect(output).toContain('up to date')
  })

  it('shows update available for public agent with newer version', async () => {
    mockGetInstalled.mockResolvedValue([makeInstalledAgent()])
    mockPublicRequest.mockResolvedValue({
      id: 'a1',
      name: 'my-agent',
      version: 'v2',
      org_slug: 'joe',
    })

    await program.parseAsync(['node', 'test', 'update', '--check'])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('joe/my-agent@v1')
    expect(output).toContain('v2')
    expect(output).toContain('1 update(s) available')
  })

  it('falls back to authenticated endpoint for private agent (404 from public)', async () => {
    mockGetInstalled.mockResolvedValue([makeInstalledAgent()])
    mockPublicRequest.mockRejectedValue(new ApiError('Not found', 404))
    mockGetOrg.mockResolvedValue({ id: 'org-1', slug: 'joe', name: 'Joe' } as any)
    mockGetMyAgent.mockResolvedValue({
      id: 'a1',
      name: 'my-agent',
      version: 'v1',
      org_slug: 'joe',
    } as any)

    await program.parseAsync(['node', 'test', 'update', '--check'])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('up to date')
    expect(output).not.toContain('not found')
    expect(output).not.toContain('could not fetch')
    expect(output).not.toContain('Log in')
  })

  it('shows update available for private agent with newer version', async () => {
    mockGetInstalled.mockResolvedValue([makeInstalledAgent()])
    mockPublicRequest.mockRejectedValue(new ApiError('Not found', 404))
    mockGetOrg.mockResolvedValue({ id: 'org-1', slug: 'joe', name: 'Joe' } as any)
    mockGetMyAgent.mockResolvedValue({
      id: 'a1',
      name: 'my-agent',
      version: 'v3',
      org_slug: 'joe',
    } as any)

    await program.parseAsync(['node', 'test', 'update', '--check'])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('joe/my-agent@v1')
    expect(output).toContain('v3')
    expect(output).toContain('1 update(s) available')
  })

  it('shows login hint when no API key and public 404', async () => {
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: undefined as any,
      apiUrl: 'https://api.test.com',
      defaultOrg: 'joe',
    })
    mockGetInstalled.mockResolvedValue([makeInstalledAgent()])
    mockPublicRequest.mockRejectedValue(new ApiError('Not found', 404))

    await program.parseAsync(['node', 'test', 'update', '--check'])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('not found publicly')
    expect(output).toContain('orch login')
    expect(output).toContain('private agents')
  })

  it('shows "agent not found" when authenticated but org mismatch', async () => {
    mockGetInstalled.mockResolvedValue([makeInstalledAgent({ agent: 'other-org/my-agent' })])
    mockPublicRequest.mockRejectedValue(new ApiError('Not found', 404))
    mockGetOrg.mockResolvedValue({ id: 'org-1', slug: 'joe', name: 'Joe' } as any)

    await program.parseAsync(['node', 'test', 'update', '--check'])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('agent not found')
    expect(output).not.toContain('Log in')
  })

  it('shows "agent not found" when authenticated but agent not in user list', async () => {
    mockGetInstalled.mockResolvedValue([makeInstalledAgent()])
    mockPublicRequest.mockRejectedValue(new ApiError('Not found', 404))
    mockGetOrg.mockResolvedValue({ id: 'org-1', slug: 'joe', name: 'Joe' } as any)
    mockGetMyAgent.mockResolvedValue(null)

    await program.parseAsync(['node', 'test', 'update', '--check'])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('agent not found')
  })

  it('propagates network errors (not confused with 404)', async () => {
    mockGetInstalled.mockResolvedValue([makeInstalledAgent()])
    mockPublicRequest.mockRejectedValue(
      new NetworkError('https://api.test.com/public/agents/joe/my-agent/latest')
    )

    await expect(
      program.parseAsync(['node', 'test', 'update', '--check'])
    ).rejects.toThrow('Unable to connect')
  })

  it('propagates non-404 API errors (e.g., 500)', async () => {
    mockGetInstalled.mockResolvedValue([makeInstalledAgent()])
    mockPublicRequest.mockRejectedValue(new ApiError('Internal error', 500))

    await expect(
      program.parseAsync(['node', 'test', 'update', '--check'])
    ).rejects.toThrow('Internal error')
  })

  it('handles multiple agents with mixed public/private', async () => {
    mockGetInstalled.mockResolvedValue([
      makeInstalledAgent({ agent: 'joe/public-agent' }),
      makeInstalledAgent({ agent: 'joe/private-agent' }),
    ])

    // First call (public-agent): succeeds on public endpoint
    // Second call (private-agent): 404 on public endpoint
    mockPublicRequest
      .mockResolvedValueOnce({
        id: 'a1',
        name: 'public-agent',
        version: 'v1',
        org_slug: 'joe',
      })
      .mockRejectedValueOnce(new ApiError('Not found', 404))

    mockGetOrg.mockResolvedValue({ id: 'org-1', slug: 'joe', name: 'Joe' } as any)
    mockGetMyAgent.mockResolvedValue({
      id: 'a2',
      name: 'private-agent',
      version: 'v1',
      org_slug: 'joe',
    } as any)

    await program.parseAsync(['node', 'test', 'update', '--check'])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('joe/public-agent@v1')
    expect(output).toContain('joe/private-agent@v1')
    expect(output).toContain('up to date')
    expect(output).not.toContain('not found')
  })

  it('handles no installed agents', async () => {
    mockGetInstalled.mockResolvedValue([])

    await program.parseAsync(['node', 'test', 'update', '--check'])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('No agents installed')
  })

  it('handles specific agent not installed', async () => {
    mockGetInstalled.mockResolvedValue([makeInstalledAgent()])

    await program.parseAsync(['node', 'test', 'update', 'joe/other-agent', '--check'])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('not installed')
  })

  it('resolves workspace context for team org agents', async () => {
    const { resolveWorkspaceIdForOrg } = await import('../lib/api')
    const mockResolveWs = vi.mocked(resolveWorkspaceIdForOrg)
    mockResolveWs.mockResolvedValue('ws-team-123')

    mockGetInstalled.mockResolvedValue([makeInstalledAgent({ agent: 'team-org/my-agent' })])
    mockPublicRequest.mockRejectedValue(new ApiError('Not found', 404))
    mockGetOrg.mockResolvedValue({ id: 'org-1', slug: 'team-org', name: 'Team' } as any)
    mockGetMyAgent.mockResolvedValue({
      id: 'a1',
      name: 'my-agent',
      version: 'v1',
      org_slug: 'team-org',
    } as any)

    await program.parseAsync(['node', 'test', 'update', '--check'])

    // Verify workspace ID was passed through
    expect(mockResolveWs).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk_test_123' }),
      'team-org'
    )
    expect(mockGetOrg).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk_test_123' }),
      'ws-team-123'
    )
    expect(mockGetMyAgent).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk_test_123' }),
      'my-agent',
      'latest',
      'ws-team-123'
    )

    const output = allStdout(stdoutSpy)
    expect(output).toContain('up to date')
  })
})
