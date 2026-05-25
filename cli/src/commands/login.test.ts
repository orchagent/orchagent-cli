/**
 * Tests for the login command.
 *
 * Covers: UX-5 (suggest orch doctor after first login)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

vi.mock('../lib/config')
vi.mock('../lib/api', () => ({
  getOrg: vi.fn(),
}))
vi.mock('../lib/browser-auth', () => ({
  startBrowserAuth: vi.fn(),
}))
vi.mock('../lib/analytics', () => ({
  track: vi.fn(),
}))

import { registerLoginCommand } from './login'
import { getResolvedConfig, loadConfig, saveConfig } from '../lib/config'
import { getOrg } from '../lib/api'
import { startBrowserAuth } from '../lib/browser-auth'

const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockLoadConfig = vi.mocked(loadConfig)
const mockSaveConfig = vi.mocked(saveConfig)
const mockGetOrg = vi.mocked(getOrg)
const mockStartBrowserAuth = vi.mocked(startBrowserAuth)

describe('login command', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()

    program = new Command()
    program.exitOverride()
    registerLoginCommand(program)

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'joe',
    })

    mockGetOrg.mockResolvedValue({
      id: 'org-1',
      name: 'Joe',
      slug: 'joe',
      created_at: '2026-01-01T00:00:00Z',
    })

    mockSaveConfig.mockResolvedValue(undefined)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    vi.restoreAllMocks()
  })

  // ─── Key-based login ────────────────────────────────────────────────────────

  it('logs in with --key and prints success', async () => {
    mockLoadConfig.mockResolvedValue({})

    await program.parseAsync(['node', 'test', 'login', '--key', 'sk_test_123'])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain('Logged in to joe')
  })

  it('saves config with api_key on key-based login', async () => {
    mockLoadConfig.mockResolvedValue({})

    await program.parseAsync(['node', 'test', 'login', '--key', 'sk_new_key'])

    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ api_key: 'sk_new_key' })
    )
  })

  it('saves key-based login to a named profile without replacing default login', async () => {
    mockLoadConfig.mockResolvedValue({
      api_key: 'sk_default',
      default_org: 'default',
      workspace: 'default-ws',
      profiles: {
        old: {
          api_key: 'sk_old',
          default_org: 'old',
        },
      },
    })

    await program.parseAsync(['node', 'test', 'login', '--key', 'sk_stocksure', '--profile', 'stocksure'])

    expect(mockSaveConfig).toHaveBeenCalledWith({
      api_key: 'sk_default',
      default_org: 'default',
      workspace: 'default-ws',
      profiles: {
        old: {
          api_key: 'sk_old',
          default_org: 'old',
        },
        stocksure: {
          api_key: 'sk_stocksure',
          api_url: 'https://api.test.com',
          default_org: 'joe',
        },
      },
    })
  })

  it('clears only the named profile workspace on profile login', async () => {
    mockLoadConfig.mockResolvedValue({
      profiles: {
        stocksure: {
          api_key: 'sk_old',
          default_org: 'stocksure',
          workspace: 'old-workspace',
        },
      },
    })

    await program.parseAsync(['node', 'test', 'login', '--key', 'sk_new', '--profile', 'stocksure'])

    const savedConfig = mockSaveConfig.mock.calls[0][0]
    expect(savedConfig.profiles?.stocksure).not.toHaveProperty('workspace')
  })

  it('clears workspace on key-based login', async () => {
    mockLoadConfig.mockResolvedValue({ workspace: 'old-ws' })

    await program.parseAsync(['node', 'test', 'login', '--key', 'sk_test_123'])

    const savedConfig = mockSaveConfig.mock.calls[0][0]
    expect(savedConfig).not.toHaveProperty('workspace')
  })

  // ─── UX-5: Suggest orch doctor after first login ────────────────────────────

  it('suggests orch doctor on first key-based login (no previous api_key)', async () => {
    mockLoadConfig.mockResolvedValue({})

    await program.parseAsync(['node', 'test', 'login', '--key', 'sk_test_123'])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain('orch doctor')
  })

  it('does NOT suggest orch doctor on re-login (existing api_key)', async () => {
    mockLoadConfig.mockResolvedValue({ api_key: 'sk_old_key' })

    await program.parseAsync(['node', 'test', 'login', '--key', 'sk_test_123'])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).not.toContain('orch doctor')
  })

  it('suggests orch doctor on first browser-based login (no previous api_key)', async () => {
    mockLoadConfig.mockResolvedValue({})
    mockStartBrowserAuth.mockResolvedValue({
      apiKey: 'sk_browser_key',
      orgSlug: 'joe',
      orgName: 'Joe',
    })

    // Simulate TTY for browser login path
    const origIsTTY = process.stdin.isTTY
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })

    try {
      await program.parseAsync(['node', 'test', 'login'])

      const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
      expect(output).toContain('orch doctor')
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true })
    }
  })

  it('saves browser login to a named profile', async () => {
    mockLoadConfig.mockResolvedValue({ api_key: 'sk_default' })
    mockStartBrowserAuth.mockResolvedValue({
      apiKey: 'sk_browser_key',
      orgSlug: 'logsure',
      orgName: 'LogSure',
    })

    const origIsTTY = process.stdin.isTTY
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })

    try {
      await program.parseAsync(['node', 'test', 'login', '--profile', 'logsure'])

      expect(mockSaveConfig).toHaveBeenCalledWith({
        api_key: 'sk_default',
        profiles: {
          logsure: {
            api_key: 'sk_browser_key',
            api_url: 'https://api.test.com',
            default_org: 'logsure',
          },
        },
      })
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true })
    }
  })

  it('does NOT suggest orch doctor on browser re-login (existing api_key)', async () => {
    mockLoadConfig.mockResolvedValue({ api_key: 'sk_old_key' })
    mockStartBrowserAuth.mockResolvedValue({
      apiKey: 'sk_browser_key',
      orgSlug: 'joe',
      orgName: 'Joe',
    })

    const origIsTTY = process.stdin.isTTY
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })

    try {
      await program.parseAsync(['node', 'test', 'login'])

      const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
      expect(output).not.toContain('orch doctor')
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true })
    }
  })

  // ─── Edge case: config exists but no api_key (e.g. only api_url set) ──────

  it('suggests orch doctor when config exists but has no api_key', async () => {
    mockLoadConfig.mockResolvedValue({ api_url: 'https://custom.api.com' })

    await program.parseAsync(['node', 'test', 'login', '--key', 'sk_test_123'])

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(output).toContain('orch doctor')
  })
})
