import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

vi.mock('../lib/config')
vi.mock('../lib/api', () => {
  const ApiError = class extends Error {
    status: number
    payload?: unknown
    constructor(message: string, status: number, payload?: unknown) {
      super(message)
      this.status = status
      this.payload = payload
    }
  }

  return {
    ApiError,
    getAgentWithFallback: vi.fn(),
    request: vi.fn(),
    forkAgent: vi.fn(),
  }
})
vi.mock('../lib/analytics')
vi.mock('../lib/output')
vi.mock('../lib/key-store')

import { registerForkCommand } from './fork'
import { getResolvedConfig, loadConfig } from '../lib/config'
import { getAgentWithFallback, request, forkAgent, ApiError } from '../lib/api'
import { track } from '../lib/analytics'
import { printJson } from '../lib/output'
import { saveServiceKey } from '../lib/key-store'

const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockLoadConfig = vi.mocked(loadConfig)
const mockGetAgentWithFallback = vi.mocked(getAgentWithFallback)
const mockRequest = vi.mocked(request)
const mockForkAgent = vi.mocked(forkAgent)
const mockTrack = vi.mocked(track)
const mockPrintJson = vi.mocked(printJson)
const mockSaveServiceKey = vi.mocked(saveServiceKey)

describe('fork command', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()

    program = new Command()
    program.exitOverride()
    registerForkCommand(program)

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
    })

    mockLoadConfig.mockResolvedValue({})

    mockGetAgentWithFallback.mockResolvedValue({
      id: 'source-agent-id',
      org_slug: 'orchagent',
      name: 'my-discord-agent',
      version: 'v1',
    } as any)

    mockForkAgent.mockResolvedValue({
      agent: {
        id: 'forked-agent-id',
        org_slug: 'joe',
        name: 'my-discord-agent',
        version: 'v1',
      },
      service_key: 'sk_service_abc123',
      service_key_prefix: 'sk_service',
    } as any)

    mockTrack.mockResolvedValue(undefined)
    mockSaveServiceKey.mockResolvedValue('/home/.orchagent/keys/joe/my-discord-agent.json')
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('throws when not logged in', async () => {
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: '',
      apiUrl: 'https://api.test.com',
    })

    await expect(
      program.parseAsync(['node', 'test', 'fork', 'orchagent/my-discord-agent'])
    ).rejects.toThrow('Not logged in')
  })

  it('forks a public agent into current workspace by default with org_slug from response', async () => {
    await program.parseAsync(['node', 'test', 'fork', 'orchagent/my-discord-agent'])

    expect(mockGetAgentWithFallback).toHaveBeenCalledWith(
      expect.any(Object),
      'orchagent',
      'my-discord-agent',
      'latest'
    )
    expect(mockForkAgent).toHaveBeenCalledWith(
      expect.any(Object),
      'source-agent-id',
      {}
    )

    const output = stdoutSpy.mock.calls.map((c) => c[0]).join('')
    expect(output).toContain('Forked orchagent/my-discord-agent@latest')
    expect(output).toContain('New agent: joe/my-discord-agent@v1')
    expect(output).toContain('Service key')
  })

  it('resolves current workspace when org_slug is missing from response', async () => {
    // Simulate gateway returning agent without org_slug
    mockForkAgent.mockResolvedValue({
      agent: {
        id: 'forked-agent-id',
        org_slug: undefined, // Missing!
        name: 'my-discord-agent',
        version: 'v1',
      },
      service_key: 'sk_service_abc123',
      service_key_prefix: 'sk_service',
    } as any)

    mockRequest.mockResolvedValue({
      workspaces: [
        { id: 'ws-personal', name: 'Personal', slug: 'joe', type: 'personal', role: 'owner', member_count: 1 },
      ],
    } as any)

    await program.parseAsync(['node', 'test', 'fork', 'orchagent/my-discord-agent'])

    // Should call /workspaces to resolve current workspace
    expect(mockRequest).toHaveBeenCalledWith(
      expect.any(Object),
      'GET',
      '/workspaces'
    )

    const output = stdoutSpy.mock.calls.map((c) => c[0]).join('')
    expect(output).toContain('Resolving current workspace')
    expect(output).toContain('New agent: joe/my-discord-agent@v1')
    expect(output).toContain('Workspace: Personal (joe)')
  })

  it('resolves --workspace slug and sends workspace_id', async () => {
    mockRequest.mockResolvedValue({
      workspaces: [
        { id: 'ws-personal', name: 'Personal', slug: 'joe', type: 'personal', role: 'owner', member_count: 1 },
        { id: 'ws-team', name: 'Acme', slug: 'acme-corp', type: 'team', role: 'member', member_count: 4 },
      ],
    } as any)

    await program.parseAsync([
      'node',
      'test',
      'fork',
      'orchagent/my-discord-agent@v2',
      '--workspace',
      'acme-corp',
      '--name',
      'customer-support-bot',
    ])

    expect(mockRequest).toHaveBeenCalledWith(
      expect.any(Object),
      'GET',
      '/workspaces'
    )
    expect(mockForkAgent).toHaveBeenCalledWith(
      expect.any(Object),
      'source-agent-id',
      {
        workspace_id: 'ws-team',
        new_name: 'customer-support-bot',
      }
    )
  })

  it('throws when workspace slug is not found', async () => {
    mockRequest.mockResolvedValue({
      workspaces: [{ id: 'ws-1', name: 'Personal', slug: 'joe', type: 'personal', role: 'owner', member_count: 1 }],
    } as any)

    await expect(
      program.parseAsync([
        'node',
        'test',
        'fork',
        'orchagent/my-discord-agent',
        '--workspace',
        'does-not-exist',
      ])
    ).rejects.toThrow("Workspace 'does-not-exist' not found")
  })

  it('maps workspace-targeting auth failures to a friendly error', async () => {
    mockRequest.mockResolvedValue({
      workspaces: [{ id: 'ws-team', name: 'Acme', slug: 'acme-corp', type: 'team', role: 'member', member_count: 4 }],
    } as any)
    mockForkAgent.mockRejectedValue(
      new ApiError('Authentication required for workspace targeting', 401)
    )

    await expect(
      program.parseAsync([
        'node',
        'test',
        'fork',
        'orchagent/my-discord-agent',
        '--workspace',
        'acme-corp',
      ])
    ).rejects.toThrow('Forking into a specific workspace requires a user session key')
  })

  it('outputs JSON with --json', async () => {
    await program.parseAsync([
      'node',
      'test',
      'fork',
      'orchagent/my-discord-agent',
      '--json',
    ])

    expect(mockPrintJson).toHaveBeenCalledWith({
      agent: {
        id: 'forked-agent-id',
        org_slug: 'joe',
        name: 'my-discord-agent',
        version: 'v1',
      },
      service_key: 'sk_service_abc123',
      service_key_prefix: 'sk_service',
    })
  })

  it('tracks analytics event', async () => {
    await program.parseAsync(['node', 'test', 'fork', 'orchagent/my-discord-agent'])

    expect(mockTrack).toHaveBeenCalledWith('cli_fork', {
      source_org: 'orchagent',
      source_agent: 'my-discord-agent',
      source_version: 'latest',
      target_workspace: null,
    })
  })

  it('saves service key locally after fork', async () => {
    await program.parseAsync(['node', 'test', 'fork', 'orchagent/my-discord-agent'])

    expect(mockSaveServiceKey).toHaveBeenCalledWith(
      'joe', 'my-discord-agent', 'v1', 'sk_service_abc123', 'sk_service_a'
    )
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join('')
    expect(output).toContain('Saved to')
    expect(output).toContain('Retrieve later')
  })

  it('shows warning when key save fails during fork', async () => {
    mockSaveServiceKey.mockRejectedValue(new Error('Permission denied'))

    await program.parseAsync(['node', 'test', 'fork', 'orchagent/my-discord-agent'])

    const output = stdoutSpy.mock.calls.map((c) => c[0]).join('')
    // Key is still displayed
    expect(output).toContain('sk_service_abc123')
    expect(output).toContain('Could not save key locally')
  })

  it('does not save key when forking with --json', async () => {
    await program.parseAsync(['node', 'test', 'fork', 'orchagent/my-discord-agent', '--json'])

    // JSON mode outputs raw JSON, no interactive saving
    expect(mockSaveServiceKey).not.toHaveBeenCalled()
  })

  it('uses org_slug from response when --workspace is specified', async () => {
    mockRequest.mockResolvedValue({
      workspaces: [
        { id: 'ws-team', name: 'Acme', slug: 'acme-corp', type: 'team', role: 'member', member_count: 4 },
      ],
    } as any)

    // When forking into acme-corp, the gateway returns the forked agent with correct org_slug
    mockForkAgent.mockResolvedValue({
      agent: {
        id: 'forked-agent-id',
        org_slug: 'acme-corp', // Gateway confirms it was created in acme-corp
        name: 'my-discord-agent',
        version: 'v1',
      },
      service_key: 'sk_service_abc123',
      service_key_prefix: 'sk_service',
    } as any)

    await program.parseAsync([
      'node',
      'test',
      'fork',
      'orchagent/my-discord-agent',
      '--workspace',
      'acme-corp',
    ])

    const output = stdoutSpy.mock.calls.map((c) => c[0]).join('')
    // Should show the workspace from the response (which matches the target)
    expect(output).toContain('New agent: acme-corp/my-discord-agent@v1')
    expect(output).toContain('Workspace: Acme (acme-corp)')
  })

  it('falls back to targetWorkspace slug when org_slug missing', async () => {
    mockRequest.mockResolvedValue({
      workspaces: [
        { id: 'ws-team', name: 'Acme', slug: 'acme-corp', type: 'team', role: 'member', member_count: 4 },
      ],
    } as any)

    // Edge case: gateway doesn't return org_slug for some reason
    mockForkAgent.mockResolvedValue({
      agent: {
        id: 'forked-agent-id',
        org_slug: undefined, // Missing
        name: 'my-discord-agent',
        version: 'v1',
      },
      service_key: 'sk_service_abc123',
      service_key_prefix: 'sk_service',
    } as any)

    await program.parseAsync([
      'node',
      'test',
      'fork',
      'orchagent/my-discord-agent',
      '--workspace',
      'acme-corp',
    ])

    const output = stdoutSpy.mock.calls.map((c) => c[0]).join('')
    // Should fall back to the explicitly provided workspace
    expect(output).toContain('New agent: acme-corp/my-discord-agent@v1')
    expect(output).toContain('Workspace: Acme (acme-corp)')
  })

  it('handles multiple workspaces with config default workspace', async () => {
    // When config has a default workspace and multiple workspaces exist
    mockRequest.mockResolvedValue({
      workspaces: [
        { id: 'ws-personal', name: 'Personal', slug: 'joe', type: 'personal', role: 'owner', member_count: 1 },
        { id: 'ws-team', name: 'Acme', slug: 'acme-corp', type: 'team', role: 'member', member_count: 4 },
      ],
    } as any)

    mockForkAgent.mockResolvedValue({
      agent: {
        id: 'forked-agent-id',
        org_slug: undefined, // Missing — will resolve from config
        name: 'my-discord-agent',
        version: 'v1',
      },
      service_key: 'sk_service_abc123',
      service_key_prefix: 'sk_service',
    } as any)

    // Config has a default workspace set
    mockLoadConfig.mockResolvedValue({
      workspace: 'joe', // Default workspace set
    } as any)

    await program.parseAsync(['node', 'test', 'fork', 'orchagent/my-discord-agent'])

    const output = stdoutSpy.mock.calls.map((c) => c[0]).join('')
    // Should use the config default
    expect(output).toContain('New agent: joe/my-discord-agent@v1')
    expect(output).toContain('Workspace: Personal (joe)')
  })

  it('throws when multiple workspaces and no default', async () => {
    mockRequest.mockResolvedValue({
      workspaces: [
        { id: 'ws-personal', name: 'Personal', slug: 'joe', type: 'personal', role: 'owner', member_count: 1 },
        { id: 'ws-team', name: 'Acme', slug: 'acme-corp', type: 'team', role: 'member', member_count: 4 },
      ],
    } as any)

    mockForkAgent.mockResolvedValue({
      agent: {
        id: 'forked-agent-id',
        org_slug: undefined, // Missing
        name: 'my-discord-agent',
        version: 'v1',
      },
      service_key: 'sk_service_abc123',
      service_key_prefix: 'sk_service',
    } as any)

    // Config has no default workspace
    mockLoadConfig.mockResolvedValue({} as any)

    await expect(
      program.parseAsync(['node', 'test', 'fork', 'orchagent/my-discord-agent'])
    ).rejects.toThrow('Multiple workspaces available')
  })
})
