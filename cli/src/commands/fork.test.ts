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
    getPublicAgent: vi.fn(),
    request: vi.fn(),
    forkAgent: vi.fn(),
  }
})
vi.mock('../lib/analytics')
vi.mock('../lib/output')

import { registerForkCommand } from './fork'
import { getResolvedConfig } from '../lib/config'
import { getPublicAgent, request, forkAgent, ApiError } from '../lib/api'
import { track } from '../lib/analytics'
import { printJson } from '../lib/output'

const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockGetPublicAgent = vi.mocked(getPublicAgent)
const mockRequest = vi.mocked(request)
const mockForkAgent = vi.mocked(forkAgent)
const mockTrack = vi.mocked(track)
const mockPrintJson = vi.mocked(printJson)

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

    mockGetPublicAgent.mockResolvedValue({
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

  it('forks a public agent into current workspace by default', async () => {
    await program.parseAsync(['node', 'test', 'fork', 'orchagent/my-discord-agent'])

    expect(mockGetPublicAgent).toHaveBeenCalledWith(
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
})
