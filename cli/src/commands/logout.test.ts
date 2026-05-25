import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

vi.mock('../lib/config')
vi.mock('../lib/api', () => ({
  safeFetch: vi.fn(),
}))
vi.mock('../lib/analytics', () => ({
  track: vi.fn(),
}))

import { registerLogoutCommand } from './logout'
import { getResolvedConfig, loadConfig, saveConfig } from '../lib/config'
import { safeFetch } from '../lib/api'

const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockLoadConfig = vi.mocked(loadConfig)
const mockSaveConfig = vi.mocked(saveConfig)
const mockSafeFetch = vi.mocked(safeFetch)

describe('logout command', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()

    program = new Command()
    program.exitOverride()
    registerLogoutCommand(program)

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'joe',
    })
    mockSaveConfig.mockResolvedValue(undefined)
    mockSafeFetch.mockResolvedValue({ ok: true } as Response)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('logs out of a named profile without clearing default login', async () => {
    mockLoadConfig.mockResolvedValue({
      api_key: 'sk_default',
      default_org: 'default',
      workspace: 'default-ws',
      profiles: {
        stocksure: {
          api_key: 'sk_stocksure',
          default_org: 'stocksure',
        },
        logsure: {
          api_key: 'sk_logsure',
          default_org: 'logsure',
        },
      },
    })

    await program.parseAsync(['node', 'test', 'logout', '--profile', 'stocksure'])

    expect(mockGetResolvedConfig).toHaveBeenCalledWith({}, 'stocksure')
    expect(mockSaveConfig).toHaveBeenCalledWith({
      api_key: 'sk_default',
      default_org: 'default',
      workspace: 'default-ws',
      profiles: {
        logsure: {
          api_key: 'sk_logsure',
          default_org: 'logsure',
        },
      },
    })
    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain('Logged out of profile stocksure')
  })

  it('does not call the API when the named profile is not logged in', async () => {
    mockLoadConfig.mockResolvedValue({ profiles: {} })

    await program.parseAsync(['node', 'test', 'logout', '--profile', 'stocksure'])

    expect(mockGetResolvedConfig).not.toHaveBeenCalled()
    expect(mockSafeFetch).not.toHaveBeenCalled()
    expect(mockSaveConfig).not.toHaveBeenCalled()
    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain('Not logged into profile stocksure')
  })
})
