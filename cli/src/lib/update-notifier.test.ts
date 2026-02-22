/**
 * Tests for the CLI update notifier.
 *
 * Covers: cache reading/writing, version comparison, opt-out via env var,
 * and resilience to failures (corrupted cache, missing directory, etc.).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'path'
import os from 'os'

// Mock the Node built-ins before importing the module
vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
}))

vi.mock('https', () => ({
  default: {
    get: vi.fn(),
  },
}))

// Mock package.json
vi.mock('../../package.json', () => ({
  default: { version: '0.3.33' },
}))

import fs from 'fs'
import https from 'https'

// We need to re-import the module for each test to reset module-level state
async function loadModule() {
  // Clear the module cache so we get fresh module-level state
  const modulePath = './update-notifier'
  // vitest doesn't easily allow re-importing with fresh state, so we
  // test the public API behavior as-is
  const mod = await import(modulePath)
  return mod
}

describe('update-notifier', () => {
  const CACHE_PATH = path.join(os.homedir(), '.orchagent', 'update-check.json')

  beforeEach(() => {
    vi.resetAllMocks()
    delete process.env.NO_UPDATE_NOTIFIER
  })

  afterEach(() => {
    delete process.env.NO_UPDATE_NOTIFIER
  })

  describe('checkForUpdates', () => {
    it('reads cache file on startup', async () => {
      const cache = JSON.stringify({ latest: '0.3.33', checkedAt: Date.now() })
      vi.mocked(fs.readFileSync).mockReturnValueOnce(cache)

      const { checkForUpdates } = await loadModule()
      checkForUpdates()

      expect(fs.readFileSync).toHaveBeenCalledWith(CACHE_PATH, 'utf-8')
    })

    it('does nothing when NO_UPDATE_NOTIFIER env is set', async () => {
      process.env.NO_UPDATE_NOTIFIER = '1'

      const { checkForUpdates } = await loadModule()
      checkForUpdates()

      expect(fs.readFileSync).not.toHaveBeenCalled()
    })

    it('triggers background check when cache is stale', async () => {
      const staleCache = JSON.stringify({
        latest: '0.3.33',
        checkedAt: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
      })
      vi.mocked(fs.readFileSync).mockReturnValueOnce(staleCache)

      const mockReq = {
        on: vi.fn().mockReturnThis(),
      }
      vi.mocked(https.get).mockReturnValueOnce(mockReq as any)

      const { checkForUpdates } = await loadModule()
      checkForUpdates()

      expect(https.get).toHaveBeenCalled()
      // Should register socket handler for unref
      expect(mockReq.on).toHaveBeenCalledWith('socket', expect.any(Function))
    })

    it('triggers background check when cache file is missing', async () => {
      vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
        throw new Error('ENOENT')
      })

      const mockReq = {
        on: vi.fn().mockReturnThis(),
      }
      vi.mocked(https.get).mockReturnValueOnce(mockReq as any)

      const { checkForUpdates } = await loadModule()
      checkForUpdates()

      expect(https.get).toHaveBeenCalled()
    })

    it('does not trigger background check when cache is fresh', async () => {
      const freshCache = JSON.stringify({
        latest: '0.4.0',
        checkedAt: Date.now() - 1000, // 1 second ago
      })
      vi.mocked(fs.readFileSync).mockReturnValueOnce(freshCache)

      const { checkForUpdates } = await loadModule()
      checkForUpdates()

      expect(https.get).not.toHaveBeenCalled()
    })

    it('survives corrupted cache file gracefully', async () => {
      vi.mocked(fs.readFileSync).mockReturnValueOnce('not json at all{{{')

      const mockReq = {
        on: vi.fn().mockReturnThis(),
      }
      vi.mocked(https.get).mockReturnValueOnce(mockReq as any)

      const { checkForUpdates } = await loadModule()
      expect(() => checkForUpdates()).not.toThrow()
    })

    it('survives https.get throwing', async () => {
      vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
        throw new Error('ENOENT')
      })
      vi.mocked(https.get).mockImplementationOnce(() => {
        throw new Error('getaddrinfo ENOTFOUND')
      })

      const { checkForUpdates } = await loadModule()
      expect(() => checkForUpdates()).not.toThrow()
    })
  })

  describe('printUpdateNotification', () => {
    it('prints update notice when newer version is cached', async () => {
      const cache = JSON.stringify({
        latest: '0.4.0',
        checkedAt: Date.now(),
      })
      vi.mocked(fs.readFileSync).mockReturnValueOnce(cache)

      const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

      const { checkForUpdates, printUpdateNotification } = await loadModule()
      checkForUpdates()
      printUpdateNotification()

      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('Update available')
      )
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('v0.3.33')
      )
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('v0.4.0')
      )

      stderrSpy.mockRestore()
    })

    it('shows correct install command (npm install -g @orchagent/cli@latest)', async () => {
      const cache = JSON.stringify({
        latest: '0.4.0',
        checkedAt: Date.now(),
      })
      vi.mocked(fs.readFileSync).mockReturnValueOnce(cache)

      const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

      const { checkForUpdates, printUpdateNotification } = await loadModule()
      checkForUpdates()
      printUpdateNotification()

      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('npm install -g @orchagent/cli@latest')
      )
      // Must NOT use the unreliable `npm update -g` command
      expect(stderrSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('npm update -g')
      )

      stderrSpy.mockRestore()
    })

    it('prints nothing when version is current', async () => {
      const cache = JSON.stringify({
        latest: '0.3.33',
        checkedAt: Date.now(),
      })
      vi.mocked(fs.readFileSync).mockReturnValueOnce(cache)

      const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

      const { checkForUpdates, printUpdateNotification } = await loadModule()
      checkForUpdates()
      printUpdateNotification()

      expect(stderrSpy).not.toHaveBeenCalled()

      stderrSpy.mockRestore()
    })

    it('prints nothing when cached version is older (dev/prerelease)', async () => {
      const cache = JSON.stringify({
        latest: '0.3.32',
        checkedAt: Date.now(),
      })
      vi.mocked(fs.readFileSync).mockReturnValueOnce(cache)

      const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

      const { checkForUpdates, printUpdateNotification } = await loadModule()
      checkForUpdates()
      printUpdateNotification()

      expect(stderrSpy).not.toHaveBeenCalled()

      stderrSpy.mockRestore()
    })

    it('prints nothing when no cache exists', async () => {
      vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
        throw new Error('ENOENT')
      })

      const mockReq = {
        on: vi.fn().mockReturnThis(),
      }
      vi.mocked(https.get).mockReturnValueOnce(mockReq as any)

      const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

      const { checkForUpdates, printUpdateNotification } = await loadModule()
      checkForUpdates()
      printUpdateNotification()

      expect(stderrSpy).not.toHaveBeenCalled()

      stderrSpy.mockRestore()
    })
  })
})
