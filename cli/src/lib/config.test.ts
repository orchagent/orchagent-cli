/**
 * Tests for config loading and saving.
 *
 * These tests cover the security-critical config management:
 * - Loading config from file
 * - Saving config with proper permissions
 * - Config resolution priority (overrides > env > file)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'path'
import os from 'os'

// Mock fs/promises
vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    chmod: vi.fn(),
  },
}))

import fs from 'fs/promises'
import {
  loadConfig,
  saveConfig,
  getResolvedConfig,
  getConfigPath,
  unsetConfigKey,
} from './config'

describe('loadConfig', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns empty object when config file missing', async () => {
    const error = new Error('ENOENT') as NodeJS.ErrnoException
    error.code = 'ENOENT'
    vi.mocked(fs.readFile).mockRejectedValueOnce(error)

    const config = await loadConfig()

    expect(config).toEqual({})
  })

  it('parses JSON config file', async () => {
    const configData = {
      api_key: 'sk_test_123',
      api_url: 'https://custom.api.com',
      default_org: 'my-org',
    }
    vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(configData))

    const config = await loadConfig()

    expect(config).toEqual(configData)
  })

  it('throws on non-ENOENT errors', async () => {
    const error = new Error('Permission denied') as NodeJS.ErrnoException
    error.code = 'EACCES'
    vi.mocked(fs.readFile).mockRejectedValueOnce(error)

    await expect(loadConfig()).rejects.toThrow('Permission denied')
  })

  it('reads from ~/.orchagent/config.json', async () => {
    vi.mocked(fs.readFile).mockResolvedValueOnce('{}')

    await loadConfig()

    expect(fs.readFile).toHaveBeenCalledWith(
      path.join(os.homedir(), '.orchagent', 'config.json'),
      'utf-8'
    )
  })
})

describe('saveConfig', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(fs.mkdir).mockResolvedValue(undefined)
    vi.mocked(fs.writeFile).mockResolvedValue(undefined)
    vi.mocked(fs.chmod).mockResolvedValue(undefined)
  })

  it('creates config directory if missing', async () => {
    await saveConfig({ api_key: 'sk_test' })

    expect(fs.mkdir).toHaveBeenCalledWith(
      path.join(os.homedir(), '.orchagent'),
      { recursive: true }
    )
  })

  it('writes JSON with pretty formatting', async () => {
    const config = { api_key: 'sk_test_123' }

    await saveConfig(config)

    expect(fs.writeFile).toHaveBeenCalledWith(
      path.join(os.homedir(), '.orchagent', 'config.json'),
      expect.stringContaining('"api_key": "sk_test_123"'),
      { mode: 0o600 }
    )
  })

  it('sets restrictive file permissions (0600)', async () => {
    await saveConfig({ api_key: 'sk_test' })

    // First via writeFile options
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      { mode: 0o600 }
    )

    // Then explicitly with chmod
    expect(fs.chmod).toHaveBeenCalledWith(
      path.join(os.homedir(), '.orchagent', 'config.json'),
      0o600
    )
  })

  it('adds trailing newline to file', async () => {
    await saveConfig({ api_key: 'test' })

    const writeCall = vi.mocked(fs.writeFile).mock.calls[0]
    const content = writeCall[1] as string
    expect(content.endsWith('\n')).toBe(true)
  })
})

describe('getResolvedConfig', () => {
  const originalEnv = process.env

  beforeEach(() => {
    vi.resetAllMocks()
    process.env = { ...originalEnv }
    // Clear orchagent env vars so tests start from a clean slate
    delete process.env.ORCHAGENT_API_KEY
    delete process.env.ORCHAGENT_API_URL
    delete process.env.ORCHAGENT_DEFAULT_ORG
    delete process.env.ORCHAGENT_PROFILE
    // Default: no config file
    const error = new Error('ENOENT') as NodeJS.ErrnoException
    error.code = 'ENOENT'
    vi.mocked(fs.readFile).mockRejectedValue(error)
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('uses default API URL when not configured', async () => {
    const config = await getResolvedConfig()

    expect(config.apiUrl).toBe('https://api.orchagent.io')
  })

  it('reads API key from file config', async () => {
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      JSON.stringify({ api_key: 'sk_from_file' })
    )

    const config = await getResolvedConfig()

    expect(config.apiKey).toBe('sk_from_file')
  })

  it('prioritizes file config over env vars', async () => {
    process.env.ORCHAGENT_API_KEY = 'sk_from_env'
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      JSON.stringify({ api_key: 'sk_from_file' })
    )

    const config = await getResolvedConfig()

    expect(config.apiKey).toBe('sk_from_file')
  })

  it('uses ORCHAGENT_PROFILE to select a named profile', async () => {
    process.env.ORCHAGENT_PROFILE = 'stocksure'
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      JSON.stringify({
        api_key: 'sk_hub',
        default_org: 'hub',
        profiles: {
          stocksure: {
            api_key: 'sk_stocksure',
            api_url: 'https://api.profile.test',
            default_org: 'stocksure',
          },
        },
      })
    )

    const config = await getResolvedConfig()

    expect(config).toEqual({
      apiKey: 'sk_stocksure',
      apiUrl: 'https://api.profile.test',
      defaultOrg: 'stocksure',
    })
  })

  it('uses profile-mode env key instead of falling back to active file login', async () => {
    process.env.ORCHAGENT_PROFILE = 'stocksure'
    process.env.ORCHAGENT_API_KEY = 'sk_env_stocksure'
    process.env.ORCHAGENT_DEFAULT_ORG = 'stocksure'
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      JSON.stringify({ api_key: 'sk_hub', default_org: 'hub' })
    )

    const config = await getResolvedConfig()

    expect(config.apiKey).toBe('sk_env_stocksure')
    expect(config.defaultOrg).toBe('stocksure')
  })

  it('falls back to env var when no file config', async () => {
    process.env.ORCHAGENT_API_KEY = 'sk_from_env'

    const config = await getResolvedConfig()

    expect(config.apiKey).toBe('sk_from_env')
  })

  it('prioritizes overrides over env vars', async () => {
    process.env.ORCHAGENT_API_KEY = 'sk_from_env'

    const config = await getResolvedConfig({ api_key: 'sk_override' })

    expect(config.apiKey).toBe('sk_override')
  })

  it('resolves API URL from env var', async () => {
    process.env.ORCHAGENT_API_URL = 'https://custom.api.com'

    const config = await getResolvedConfig()

    expect(config.apiUrl).toBe('https://custom.api.com')
  })

  it('resolves default org from env var', async () => {
    process.env.ORCHAGENT_DEFAULT_ORG = 'my-org'

    const config = await getResolvedConfig()

    expect(config.defaultOrg).toBe('my-org')
  })

  it('returns undefined apiKey when not set anywhere', async () => {
    const config = await getResolvedConfig()

    expect(config.apiKey).toBeUndefined()
  })
})

describe('unsetConfigKey', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(fs.mkdir).mockResolvedValue(undefined)
    vi.mocked(fs.writeFile).mockResolvedValue(undefined)
    vi.mocked(fs.chmod).mockResolvedValue(undefined)
  })

  it('removes default-provider from config', async () => {
    const existingConfig = { api_key: 'sk_test', default_provider: 'gemini' }
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existingConfig))

    await unsetConfigKey('default-provider')

    const writeCall = vi.mocked(fs.writeFile).mock.calls[0]
    const written = JSON.parse(writeCall[1] as string)
    expect(written).toEqual({ api_key: 'sk_test' })
    expect(written).not.toHaveProperty('default_provider')
  })

  it('removes default-scope from config', async () => {
    const existingConfig = { api_key: 'sk_test', default_scope: 'user' }
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existingConfig))

    await unsetConfigKey('default-scope')

    const writeCall = vi.mocked(fs.writeFile).mock.calls[0]
    const written = JSON.parse(writeCall[1] as string)
    expect(written).toEqual({ api_key: 'sk_test' })
    expect(written).not.toHaveProperty('default_scope')
  })

  it('removes default-format from config', async () => {
    const existingConfig = { api_key: 'sk_test', default_formats: ['claude-code'] }
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existingConfig))

    await unsetConfigKey('default-format')

    const writeCall = vi.mocked(fs.writeFile).mock.calls[0]
    const written = JSON.parse(writeCall[1] as string)
    expect(written).toEqual({ api_key: 'sk_test' })
    expect(written).not.toHaveProperty('default_formats')
  })

  it('throws for unknown config key', async () => {
    await expect(unsetConfigKey('nonexistent')).rejects.toThrow('Unknown config key')
  })

  it('succeeds even when key was not previously set', async () => {
    const existingConfig = { api_key: 'sk_test' }
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existingConfig))

    await unsetConfigKey('default-provider')

    const writeCall = vi.mocked(fs.writeFile).mock.calls[0]
    const written = JSON.parse(writeCall[1] as string)
    expect(written).toEqual({ api_key: 'sk_test' })
  })

  it('preserves other config keys when unsetting one', async () => {
    const existingConfig = {
      api_key: 'sk_test',
      default_provider: 'gemini',
      default_scope: 'project',
      default_formats: ['cursor'],
    }
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existingConfig))

    await unsetConfigKey('default-provider')

    const writeCall = vi.mocked(fs.writeFile).mock.calls[0]
    const written = JSON.parse(writeCall[1] as string)
    expect(written.api_key).toBe('sk_test')
    expect(written.default_scope).toBe('project')
    expect(written.default_formats).toEqual(['cursor'])
    expect(written).not.toHaveProperty('default_provider')
  })
})

describe('getConfigPath', () => {
  it('returns path to config file', () => {
    const configPath = getConfigPath()

    expect(configPath).toBe(path.join(os.homedir(), '.orchagent', 'config.json'))
  })
})
