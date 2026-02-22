/**
 * Tests for checkDualInstallation (BUG-008).
 *
 * Validates that `orch doctor` detects multiple CLI installations
 * at different paths with potentially different versions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock child_process before importing the module under test
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}))

vi.mock('fs', () => ({
  realpathSync: vi.fn((p: string) => p),
}))

// Must also mock the modules that checkCliVersion imports (they run at import time)
vi.mock('../../../../package.json', () => ({
  default: { version: '0.3.84' },
}))

vi.mock('../../../update-notifier', () => ({
  DIST_TAGS_URL: 'https://example.com/dist-tags',
  writeCache: vi.fn(),
}))

import { execSync, execFileSync } from 'child_process'
import { realpathSync } from 'fs'

import { checkDualInstallation } from './environment'

const mockExecSync = vi.mocked(execSync)
const mockExecFileSync = vi.mocked(execFileSync)
const mockRealpathSync = vi.mocked(realpathSync)

describe('checkDualInstallation', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.clearAllMocks()
    // Default: realpathSync returns the path as-is
    mockRealpathSync.mockImplementation((p: unknown) => p as string)
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  /**
   * Helper: configure `which -a` responses for binary names.
   * Pass a map of binary name → list of paths.
   */
  function mockWhichResults(results: Record<string, string[]>): void {
    mockExecSync.mockImplementation((cmd: unknown) => {
      const cmdStr = String(cmd)
      for (const [binary, paths] of Object.entries(results)) {
        if (cmdStr === `which -a ${binary}`) {
          if (paths.length === 0) throw new Error('not found')
          return paths.join('\n') + '\n'
        }
      }
      throw new Error('not found')
    })
  }

  /**
   * Helper: configure `<binary> --version` responses by path.
   * Pass a map of binary path → version string output.
   */
  function mockVersionResults(results: Record<string, string>): void {
    mockExecFileSync.mockImplementation((cmd: unknown) => {
      const cmdStr = String(cmd)
      if (results[cmdStr]) {
        return results[cmdStr]
      }
      throw new Error('not found')
    })
  }

  it('returns success for single installation', async () => {
    mockWhichResults({
      orch: ['/usr/local/bin/orch'],
      orchagent: ['/usr/local/bin/orchagent'],
    })
    // Both resolve to the same real path (symlinks to same file)
    mockRealpathSync.mockImplementation(() =>
      '/usr/local/lib/node_modules/@orchagent/cli/dist/index.js'
    )
    mockVersionResults({
      '/usr/local/bin/orch': 'orchagent/0.3.84 node/v22.0.0 darwin-arm64',
    })

    const result = await checkDualInstallation()

    expect(result.status).toBe('success')
    expect(result.name).toBe('dual_installation')
    expect(result.message).toBe('Single CLI installation')
    expect(result.details?.installationCount).toBe(1)
  })

  it('returns warning for dual installs with different versions', async () => {
    mockWhichResults({
      orch: ['/home/user/.npm-global/bin/orch'],
      orchagent: ['/usr/local/bin/orchagent'],
    })
    // Different real paths (different installations)
    mockRealpathSync.mockImplementation((p: unknown) => String(p))
    mockVersionResults({
      '/home/user/.npm-global/bin/orch': 'orchagent/0.3.84 node/v22.0.0',
      '/usr/local/bin/orchagent': 'orchagent/0.3.45 node/v22.0.0',
    })

    const result = await checkDualInstallation()

    expect(result.status).toBe('warning')
    expect(result.message).toContain('Multiple CLI versions found')
    expect(result.message).toContain('v0.3.84')
    expect(result.message).toContain('v0.3.45')
    // BUG-6: fix message should include the specific stale path and rm command
    expect(result.fix).toContain('rm /usr/local/bin/orchagent')
    expect(result.fix).toContain('v0.3.45')
    expect(result.details?.versionMismatch).toBe(true)
    expect(result.details?.installationCount).toBe(2)
  })

  it('returns info for dual installs with same version', async () => {
    mockWhichResults({
      orch: ['/home/user/.npm-global/bin/orch'],
      orchagent: ['/usr/local/bin/orchagent'],
    })
    mockRealpathSync.mockImplementation((p: unknown) => String(p))
    mockVersionResults({
      '/home/user/.npm-global/bin/orch': 'orchagent/0.3.84',
      '/usr/local/bin/orchagent': 'orchagent/0.3.84',
    })

    const result = await checkDualInstallation()

    expect(result.status).toBe('info')
    expect(result.message).toContain('same version v0.3.84')
    expect(result.details?.versionMismatch).toBe(false)
    expect(result.details?.installationCount).toBe(2)
  })

  it('deduplicates symlinks pointing to the same real path', async () => {
    mockWhichResults({
      orch: ['/usr/local/bin/orch'],
      orchagent: ['/usr/local/bin/orchagent'],
    })
    // Both symlinks resolve to the same real file
    mockRealpathSync.mockReturnValue(
      '/usr/local/lib/node_modules/@orchagent/cli/dist/index.js'
    )
    mockVersionResults({
      '/usr/local/bin/orch': 'orchagent/0.3.84',
    })

    const result = await checkDualInstallation()

    expect(result.status).toBe('success')
    expect(result.message).toBe('Single CLI installation')
    expect(result.details?.installationCount).toBe(1)
  })

  it('handles the exact BUG-008 scenario', async () => {
    // System-level install at /usr/local/bin + user-level at ~/.npm-global/bin
    mockWhichResults({
      orch: ['/Users/joe/.npm-global/bin/orch'],
      orchagent: ['/usr/local/bin/orchagent'],
    })
    mockRealpathSync.mockImplementation((p: unknown) => String(p))
    mockVersionResults({
      '/Users/joe/.npm-global/bin/orch': 'orchagent/0.3.84 node/v22.0.0 darwin-arm64',
      '/usr/local/bin/orchagent': 'orchagent/0.3.45 node/v22.0.0 darwin-arm64',
    })

    const result = await checkDualInstallation()

    expect(result.status).toBe('warning')
    expect(result.message).toContain('0.3.84')
    expect(result.message).toContain('0.3.45')
    // BUG-6: fix message should name the specific stale path
    expect(result.fix).toContain('rm /usr/local/bin/orchagent')
    expect(result.fix).toContain('v0.3.45')
  })

  it('handles neither binary found in PATH', async () => {
    mockWhichResults({
      orch: [],
      orchagent: [],
    })

    const result = await checkDualInstallation()

    // 0 installations — still success (no conflict)
    expect(result.status).toBe('success')
    expect(result.message).toBe('Single CLI installation')
    expect(result.details?.installationCount).toBe(0)
  })

  it('handles multiple paths for the same binary name', async () => {
    // `which -a orch` returns two different paths
    mockWhichResults({
      orch: ['/usr/local/bin/orch', '/home/user/.npm-global/bin/orch'],
      orchagent: [],
    })
    mockRealpathSync.mockImplementation((p: unknown) => String(p))
    mockVersionResults({
      '/usr/local/bin/orch': 'orchagent/0.3.45',
      '/home/user/.npm-global/bin/orch': 'orchagent/0.3.84',
    })

    const result = await checkDualInstallation()

    expect(result.status).toBe('warning')
    expect(result.details?.installationCount).toBe(2)
    expect(result.details?.versionMismatch).toBe(true)
  })

  it('handles version parse failure gracefully', async () => {
    mockWhichResults({
      orch: ['/usr/local/bin/orch'],
      orchagent: ['/opt/bin/orchagent'],
    })
    mockRealpathSync.mockImplementation((p: unknown) => String(p))
    // One binary returns valid version, the other crashes
    mockExecFileSync.mockImplementation((cmd: unknown) => {
      if (String(cmd) === '/usr/local/bin/orch') return 'orchagent/0.3.84'
      throw new Error('segfault')
    })

    const result = await checkDualInstallation()

    // Two installations: one with version, one with 'unknown'
    expect(result.status).toBe('warning')
    expect(result.message).toContain('v0.3.84')
    expect(result.message).toContain('vunknown')
    expect(result.details?.versionMismatch).toBe(true)
  })

  it('handles realpathSync failure (broken symlinks)', async () => {
    mockWhichResults({
      orch: ['/usr/local/bin/orch'],
      orchagent: ['/usr/local/bin/orchagent'],
    })
    // realpathSync throws for broken symlinks — falls back to original path
    mockRealpathSync.mockImplementation(() => {
      throw new Error('ENOENT')
    })
    mockVersionResults({
      '/usr/local/bin/orch': 'orchagent/0.3.84',
      '/usr/local/bin/orchagent': 'orchagent/0.3.84',
    })

    const result = await checkDualInstallation()

    // Paths are different strings, so treated as 2 installations (same version)
    expect(result.status).toBe('info')
    expect(result.details?.installationCount).toBe(2)
  })

  it('skips on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })

    const result = await checkDualInstallation()

    expect(result.status).toBe('info')
    expect(result.message).toContain('Windows')
    expect(result.details?.skipped).toBe(true)
    // Should not have called execSync at all
    expect(mockExecSync).not.toHaveBeenCalled()
  })

  it('result has correct category and name', async () => {
    mockWhichResults({ orch: [], orchagent: [] })

    const result = await checkDualInstallation()

    expect(result.category).toBe('environment')
    expect(result.name).toBe('dual_installation')
  })

  it('handles three installations with mixed versions', async () => {
    mockWhichResults({
      orch: ['/usr/local/bin/orch', '/home/user/.npm-global/bin/orch'],
      orchagent: ['/opt/homebrew/bin/orchagent'],
    })
    mockRealpathSync.mockImplementation((p: unknown) => String(p))
    mockVersionResults({
      '/usr/local/bin/orch': 'orchagent/0.3.45',
      '/home/user/.npm-global/bin/orch': 'orchagent/0.3.84',
      '/opt/homebrew/bin/orchagent': 'orchagent/0.3.80',
    })

    const result = await checkDualInstallation()

    expect(result.status).toBe('warning')
    expect(result.details?.installationCount).toBe(3)
    expect(result.details?.versionMismatch).toBe(true)
    // BUG-6: should list both stale paths in the rm command
    expect(result.fix).toContain('/usr/local/bin/orch')
    expect(result.fix).toContain('/opt/homebrew/bin/orchagent')
    // Should NOT suggest removing the newest
    expect(result.fix).not.toContain('/home/user/.npm-global/bin/orch')
  })

  it('fix message handles unknown version as stale', async () => {
    mockWhichResults({
      orch: ['/usr/local/bin/orch'],
      orchagent: ['/opt/bin/orchagent'],
    })
    mockRealpathSync.mockImplementation((p: unknown) => String(p))
    mockExecFileSync.mockImplementation((cmd: unknown) => {
      if (String(cmd) === '/usr/local/bin/orch') return 'orchagent/0.3.84'
      throw new Error('segfault')
    })

    const result = await checkDualInstallation()

    expect(result.status).toBe('warning')
    // Unknown-version binary should be flagged in the fix
    expect(result.fix).toContain('/opt/bin/orchagent')
  })

  it('handles version string in different formats', async () => {
    mockWhichResults({
      orch: ['/usr/local/bin/orch'],
      orchagent: [],
    })
    mockRealpathSync.mockImplementation((p: unknown) => String(p))
    // Version output as bare number (no "orchagent/" prefix)
    mockVersionResults({
      '/usr/local/bin/orch': '0.3.84',
    })

    const result = await checkDualInstallation()

    expect(result.status).toBe('success')
    const installs = result.details?.installations as Array<{ version: string }>
    expect(installs[0].version).toBe('0.3.84')
  })

  it('only finds orchagent binary, not orch', async () => {
    mockWhichResults({
      orch: [],
      orchagent: ['/usr/local/bin/orchagent'],
    })
    mockRealpathSync.mockImplementation((p: unknown) => String(p))
    mockVersionResults({
      '/usr/local/bin/orchagent': 'orchagent/0.3.84',
    })

    const result = await checkDualInstallation()

    expect(result.status).toBe('success')
    expect(result.details?.installationCount).toBe(1)
  })
})
