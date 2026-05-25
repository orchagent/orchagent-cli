import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

vi.mock('../lib/config')
vi.mock('../lib/api', () => ({
  getOrg: vi.fn(),
  request: vi.fn(),
}))

import { registerWhoamiCommand } from './whoami'
import { getResolvedConfig, loadConfig } from '../lib/config'
import { getOrg, request } from '../lib/api'

const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockLoadConfig = vi.mocked(loadConfig)
const mockGetOrg = vi.mocked(getOrg)
const mockRequest = vi.mocked(request)

describe('whoami command', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()

    program = new Command()
    program.exitOverride()
    registerWhoamiCommand(program)

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'stocksure',
    })
    mockGetOrg.mockResolvedValue({
      id: 'org-1',
      name: 'StockSure',
      slug: 'stocksure',
      created_at: '2026-01-01T00:00:00Z',
    })
    mockLoadConfig.mockResolvedValue({})
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('uses a named profile when provided', async () => {
    mockLoadConfig.mockResolvedValue({
      profiles: {
        stocksure: {
          api_key: 'sk_stocksure',
          default_org: 'stocksure',
        },
      },
    })

    await program.parseAsync(['node', 'test', 'whoami', '--profile', 'stocksure'])

    expect(mockGetResolvedConfig).toHaveBeenCalledWith({}, 'stocksure')
    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain('Profile: stocksure')
    expect(output).toContain('Org slug: stocksure')
  })

  it('shows the profile workspace when one is set', async () => {
    mockLoadConfig.mockResolvedValue({
      profiles: {
        stocksure: {
          api_key: 'sk_stocksure',
          default_org: 'stocksure',
          workspace: 'client-workspace',
        },
      },
    })
    mockRequest.mockResolvedValue({
      workspaces: [
        {
          id: 'ws-1',
          name: 'Client Workspace',
          slug: 'client-workspace',
          type: 'team',
          role: 'owner',
          member_count: 1,
        },
      ],
    })

    await program.parseAsync(['node', 'test', 'whoami', '--profile', 'stocksure'])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain('Active workspace: Client Workspace (client-workspace)')
  })
})
