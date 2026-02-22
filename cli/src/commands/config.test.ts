/**
 * Tests for config command validation.
 * Covers UX-14: empty value rejection with hint to use `config unset`.
 * Covers BUG-14: --json flag on config list and config get.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

// Mock the adapters module
vi.mock('../adapters', () => ({
  adapterRegistry: {
    getIds: () => ['claude-code', 'cursor'],
  },
}))

vi.mock('../lib/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/config')>()
  return {
    ...actual,
    loadConfig: vi.fn(),
    getResolvedConfig: vi.fn(),
    getDefaultFormats: vi.fn(),
    getDefaultScope: vi.fn(),
    getDefaultProvider: vi.fn(),
  }
})
vi.mock('../lib/output')

import { setConfigValue, registerConfigCommand } from './config'
import { loadConfig, getResolvedConfig, getDefaultFormats, getDefaultScope, getDefaultProvider, VALID_PROVIDERS } from '../lib/config'
import { printJson } from '../lib/output'

const mockLoadConfig = vi.mocked(loadConfig)
const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockGetDefaultFormats = vi.mocked(getDefaultFormats)
const mockGetDefaultScope = vi.mocked(getDefaultScope)
const mockGetDefaultProvider = vi.mocked(getDefaultProvider)
const mockPrintJson = vi.mocked(printJson)

describe('setConfigValue — empty value hint (UX-14)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('rejects empty string for default-provider with unset hint', async () => {
    await expect(setConfigValue('default-provider', '')).rejects.toThrow(
      'orch config unset default-provider'
    )
  })

  it('rejects whitespace-only string for default-provider with unset hint', async () => {
    await expect(setConfigValue('default-provider', '  ')).rejects.toThrow(
      'orch config unset default-provider'
    )
  })

  it('rejects empty string for default-scope with unset hint', async () => {
    await expect(setConfigValue('default-scope', '')).rejects.toThrow(
      'orch config unset default-scope'
    )
  })

  it('rejects empty string for default-format with unset hint', async () => {
    await expect(setConfigValue('default-format', '')).rejects.toThrow(
      'orch config unset default-format'
    )
  })

  it('still rejects invalid (non-empty) provider values normally', async () => {
    await expect(setConfigValue('default-provider', 'badprovider')).rejects.toThrow(
      'Invalid provider'
    )
  })

  it('still rejects unknown config keys', async () => {
    await expect(setConfigValue('nonexistent', 'value')).rejects.toThrow(
      'Unknown config key'
    )
  })
})

describe('config --json flag (BUG-14)', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()

    program = new Command()
    program.exitOverride()
    registerConfigCommand(program)

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    vi.restoreAllMocks()
  })

  describe('config list --json', () => {
    it('outputs JSON with --json flag', async () => {
      mockLoadConfig.mockResolvedValueOnce({
        default_formats: ['claude-code', 'cursor'],
        default_scope: 'user',
        default_provider: 'openai',
      })

      await program.parseAsync(['node', 'test', 'config', 'list', '--json'])

      expect(mockPrintJson).toHaveBeenCalledTimes(1)
      expect(mockPrintJson).toHaveBeenCalledWith({
        default_format: ['claude-code', 'cursor'],
        default_scope: 'user',
        default_provider: 'openai',
      })
    })

    it('outputs null values in JSON when not set', async () => {
      mockLoadConfig.mockResolvedValueOnce({})

      await program.parseAsync(['node', 'test', 'config', 'list', '--json'])

      expect(mockPrintJson).toHaveBeenCalledWith({
        default_format: [],
        default_scope: null,
        default_provider: null,
      })
    })

    it('does not call printJson without --json flag', async () => {
      mockLoadConfig.mockResolvedValueOnce({
        default_formats: ['claude-code'],
      })

      await program.parseAsync(['node', 'test', 'config', 'list'])

      expect(mockPrintJson).not.toHaveBeenCalled()
    })
  })

  describe('config get --json', () => {
    it('outputs JSON for default-format', async () => {
      mockGetResolvedConfig.mockResolvedValueOnce({
        apiKey: 'sk_test_123',
        apiUrl: 'https://api.test.com',
      })
      mockGetDefaultFormats.mockResolvedValueOnce(['claude-code', 'cursor'])

      await program.parseAsync(['node', 'test', 'config', 'get', 'default-format', '--json'])

      expect(mockPrintJson).toHaveBeenCalledWith({
        key: 'default-format',
        value: ['claude-code', 'cursor'],
      })
    })

    it('outputs JSON for default-scope', async () => {
      mockGetDefaultScope.mockResolvedValueOnce('user' as any)

      await program.parseAsync(['node', 'test', 'config', 'get', 'default-scope', '--json'])

      expect(mockPrintJson).toHaveBeenCalledWith({
        key: 'default-scope',
        value: 'user',
      })
    })

    it('outputs JSON for default-provider', async () => {
      mockGetDefaultProvider.mockResolvedValueOnce('openai' as any)

      await program.parseAsync(['node', 'test', 'config', 'get', 'default-provider', '--json'])

      expect(mockPrintJson).toHaveBeenCalledWith({
        key: 'default-provider',
        value: 'openai',
      })
    })

    it('outputs null value when not set', async () => {
      mockGetDefaultScope.mockResolvedValueOnce(undefined)

      await program.parseAsync(['node', 'test', 'config', 'get', 'default-scope', '--json'])

      expect(mockPrintJson).toHaveBeenCalledWith({
        key: 'default-scope',
        value: null,
      })
    })

    it('does not call printJson without --json flag', async () => {
      mockGetDefaultScope.mockResolvedValueOnce('user' as any)

      await program.parseAsync(['node', 'test', 'config', 'get', 'default-scope'])

      expect(mockPrintJson).not.toHaveBeenCalled()
    })
  })
})
