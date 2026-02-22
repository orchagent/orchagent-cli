/**
 * Tests for the dev command (IDEA-006).
 *
 * Covers: command registration, argument parsing, validation errors,
 * banner output, file watcher setup, shutdown handling, and edge cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('fs/promises', () => ({
  default: {
    stat: vi.fn(),
    access: vi.fn(),
    readFile: vi.fn(),
  },
}))

vi.mock('../lib/dotenv', () => ({
  loadDotEnv: vi.fn().mockResolvedValue({}),
}))

vi.mock('../lib/spinner', () => ({
  formatElapsed: vi.fn((s: number) => `${s.toFixed(1)}s`),
}))

vi.mock('../lib/dev-server', () => ({
  loadAgentConfig: vi.fn(),
  createDevServer: vi.fn(),
  engineLabel: vi.fn((e: string) => {
    if (e === 'direct_llm') return 'prompt'
    if (e === 'managed_loop') return 'agent loop'
    return 'code runtime'
  }),
}))

vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn(),
  },
}))

import fs from 'fs/promises'
import { registerDevCommand } from './dev'
import { loadDotEnv } from '../lib/dotenv'
import { loadAgentConfig, createDevServer } from '../lib/dev-server'
import chokidar from 'chokidar'

const mockFs = vi.mocked(fs)
const mockLoadDotEnv = vi.mocked(loadDotEnv)
const mockLoadAgentConfig = vi.mocked(loadAgentConfig)
const mockCreateDevServer = vi.mocked(createDevServer)
const mockChokidar = vi.mocked(chokidar)

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeAgentConfig(overrides: Record<string, unknown> = {}) {
  return {
    manifest: {
      name: 'test-agent',
      version: 'v1',
      type: 'prompt',
      ...overrides,
    },
    engine: 'direct_llm',
    agentDir: '/tmp/test-agent',
    prompt: 'Test prompt',
    ...overrides,
  } as any
}

function makeMockServer() {
  const server = {
    listen: vi.fn((_port: number, cb: () => void) => cb()),
    on: vi.fn(),
    close: vi.fn((cb: () => void) => cb()),
  }
  return {
    server,
    close: vi.fn().mockResolvedValue(undefined),
  }
}

function makeMockWatcher() {
  const watcher = {
    on: vi.fn().mockReturnThis(),
    close: vi.fn().mockResolvedValue(undefined),
  }
  return watcher
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('orch dev command', () => {
  let program: Command
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let processExitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerDevCommand(program)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    // Reset default mock returns (clearAllMocks clears implementations)
    mockLoadDotEnv.mockResolvedValue({})
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    stdoutSpy.mockRestore()
    processExitSpy.mockRestore()
    vi.restoreAllMocks()
  })

  function allStderr(): string {
    return stderrSpy.mock.calls.map(c => c[0]).join('')
  }

  // ── Validation ──

  describe('validation', () => {
    it('throws on invalid port (not a number)', async () => {
      mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)
      mockFs.access.mockResolvedValue(undefined)

      await expect(
        program.parseAsync(['node', 'test', 'dev', '.', '--port', 'abc'])
      ).rejects.toThrow('Port must be a number')
    })

    it('throws on port out of range', async () => {
      mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)
      mockFs.access.mockResolvedValue(undefined)

      await expect(
        program.parseAsync(['node', 'test', 'dev', '.', '--port', '99999'])
      ).rejects.toThrow('Port must be a number between 1 and 65535')
    })

    it('throws on port 0', async () => {
      mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)
      mockFs.access.mockResolvedValue(undefined)

      await expect(
        program.parseAsync(['node', 'test', 'dev', '.', '--port', '0'])
      ).rejects.toThrow('Port must be a number between 1 and 65535')
    })

    it('throws when directory does not exist', async () => {
      mockFs.stat.mockRejectedValue(new Error('ENOENT'))

      await expect(
        program.parseAsync(['node', 'test', 'dev', '/nonexistent'])
      ).rejects.toThrow('Directory not found')
    })

    it('throws when path is not a directory', async () => {
      mockFs.stat.mockResolvedValue({ isDirectory: () => false } as any)

      await expect(
        program.parseAsync(['node', 'test', 'dev', '/some/file.txt'])
      ).rejects.toThrow('Not a directory')
    })

    it('throws when orchagent.json is missing', async () => {
      mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)
      mockFs.access.mockRejectedValue(new Error('ENOENT'))

      await expect(
        program.parseAsync(['node', 'test', 'dev', '/tmp/empty-dir'])
      ).rejects.toThrow('No orchagent.json found')
    })

    it('throws when agent config fails to load', async () => {
      mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)
      mockFs.access.mockResolvedValue(undefined)
      mockLoadAgentConfig.mockRejectedValue(new Error('Invalid manifest'))

      await expect(
        program.parseAsync(['node', 'test', 'dev', '.'])
      ).rejects.toThrow('Failed to load agent configuration')
    })

    it('throws for skill type agents', async () => {
      mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)
      mockFs.access.mockResolvedValue(undefined)
      mockLoadAgentConfig.mockResolvedValue(makeAgentConfig({
        manifest: { name: 'my-skill', version: 'v1', type: 'skill' },
      }))

      await expect(
        program.parseAsync(['node', 'test', 'dev', '.'])
      ).rejects.toThrow('Skills cannot be served')
    })
  })

  // ── Server startup ──

  describe('server startup', () => {
    it('starts server on default port 4900', async () => {
      mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)
      mockFs.access.mockResolvedValue(undefined)
      mockLoadAgentConfig.mockResolvedValue(makeAgentConfig())
      const mockServer = makeMockServer()
      mockCreateDevServer.mockReturnValue(mockServer as any)
      mockChokidar.watch.mockReturnValue(makeMockWatcher() as any)

      // The command blocks forever with await new Promise(() => {}),
      // so we need to handle the SIGINT path
      const promise = program.parseAsync(['node', 'test', 'dev', '.'])

      // Give it time to start
      await new Promise(r => setTimeout(r, 50))

      expect(mockCreateDevServer).toHaveBeenCalledWith(
        4900,
        false,
        expect.any(Function),
        expect.any(Object)
      )
      expect(mockServer.server.listen).toHaveBeenCalledWith(4900, expect.any(Function))

      // Clean up - the promise will never resolve, just ignore it
      promise.catch(() => {})
    })

    it('starts server on custom port', async () => {
      mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)
      mockFs.access.mockResolvedValue(undefined)
      mockLoadAgentConfig.mockResolvedValue(makeAgentConfig())
      const mockServer = makeMockServer()
      mockCreateDevServer.mockReturnValue(mockServer as any)
      mockChokidar.watch.mockReturnValue(makeMockWatcher() as any)

      const promise = program.parseAsync(['node', 'test', 'dev', '.', '--port', '3001'])

      await new Promise(r => setTimeout(r, 50))

      expect(mockCreateDevServer).toHaveBeenCalledWith(
        3001,
        expect.any(Boolean),
        expect.any(Function),
        expect.any(Object)
      )
      expect(mockServer.server.listen).toHaveBeenCalledWith(3001, expect.any(Function))

      promise.catch(() => {})
    })

    it('passes verbose flag to server', async () => {
      mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)
      mockFs.access.mockResolvedValue(undefined)
      mockLoadAgentConfig.mockResolvedValue(makeAgentConfig())
      const mockServer = makeMockServer()
      mockCreateDevServer.mockReturnValue(mockServer as any)
      mockChokidar.watch.mockReturnValue(makeMockWatcher() as any)

      const promise = program.parseAsync(['node', 'test', 'dev', '.', '--verbose'])

      await new Promise(r => setTimeout(r, 50))

      expect(mockCreateDevServer).toHaveBeenCalledWith(
        4900,
        true,
        expect.any(Function),
        expect.any(Object)
      )

      promise.catch(() => {})
    })

    it('handles EADDRINUSE error', async () => {
      mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)
      mockFs.access.mockResolvedValue(undefined)
      mockLoadAgentConfig.mockResolvedValue(makeAgentConfig())

      const mockServer = makeMockServer()
      mockServer.server.on.mockImplementation((event: string, handler: (err: any) => void) => {
        if (event === 'error') {
          setTimeout(() => handler({ code: 'EADDRINUSE' }), 10)
        }
      })
      mockServer.server.listen.mockImplementation(() => {
        // Don't call callback - let the error handler fire
      })
      mockCreateDevServer.mockReturnValue(mockServer as any)

      await expect(
        program.parseAsync(['node', 'test', 'dev', '.'])
      ).rejects.toThrow('Port 4900 is already in use')
    })
  })

  // ── Banner output ──

  describe('banner output', () => {
    it('prints agent info in banner', async () => {
      mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)
      mockFs.access.mockResolvedValue(undefined)
      mockLoadAgentConfig.mockResolvedValue(makeAgentConfig({
        manifest: { name: 'my-cool-agent', version: 'v2', type: 'agent' },
        engine: 'managed_loop',
      }))
      const mockServer = makeMockServer()
      mockCreateDevServer.mockReturnValue(mockServer as any)
      mockChokidar.watch.mockReturnValue(makeMockWatcher() as any)

      const promise = program.parseAsync(['node', 'test', 'dev', '.'])
      await new Promise(r => setTimeout(r, 50))

      const stderr = allStderr()
      expect(stderr).toContain('my-cool-agent')
      expect(stderr).toContain('v2')
      expect(stderr).toContain('agent loop')
      expect(stderr).toContain('localhost:4900')
      expect(stderr).toContain('Watching for file changes')

      promise.catch(() => {})
    })

    it('shows .env loading message', async () => {
      mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)
      mockFs.access.mockResolvedValue(undefined)
      mockLoadAgentConfig.mockResolvedValue(makeAgentConfig())
      mockLoadDotEnv.mockResolvedValue({ API_KEY: 'test', SECRET: 'val' })
      const mockServer = makeMockServer()
      mockCreateDevServer.mockReturnValue(mockServer as any)
      mockChokidar.watch.mockReturnValue(makeMockWatcher() as any)

      const promise = program.parseAsync(['node', 'test', 'dev', '.'])
      await new Promise(r => setTimeout(r, 50))

      const stderr = allStderr()
      expect(stderr).toContain('2 variables from .env')

      promise.catch(() => {})
    })

    it('shows entrypoint for code_runtime agents', async () => {
      mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)
      mockFs.access.mockResolvedValue(undefined)
      mockLoadAgentConfig.mockResolvedValue(makeAgentConfig({
        manifest: { name: 'my-tool', version: 'v1', type: 'tool' },
        engine: 'code_runtime',
        entrypoint: 'main.py',
      }))
      const mockServer = makeMockServer()
      mockCreateDevServer.mockReturnValue(mockServer as any)
      mockChokidar.watch.mockReturnValue(makeMockWatcher() as any)

      const promise = program.parseAsync(['node', 'test', 'dev', '.'])
      await new Promise(r => setTimeout(r, 50))

      const stderr = allStderr()
      expect(stderr).toContain('main.py')

      promise.catch(() => {})
    })
  })

  // ── File watcher ──

  describe('file watcher', () => {
    it('sets up chokidar watcher by default', async () => {
      mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)
      mockFs.access.mockResolvedValue(undefined)
      mockLoadAgentConfig.mockResolvedValue(makeAgentConfig())
      const mockServer = makeMockServer()
      mockCreateDevServer.mockReturnValue(mockServer as any)
      mockChokidar.watch.mockReturnValue(makeMockWatcher() as any)

      const promise = program.parseAsync(['node', 'test', 'dev', '.'])
      await new Promise(r => setTimeout(r, 50))

      expect(mockChokidar.watch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          persistent: true,
          ignoreInitial: true,
        })
      )

      promise.catch(() => {})
    })

    it('skips watcher when --no-watch', async () => {
      mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)
      mockFs.access.mockResolvedValue(undefined)
      mockLoadAgentConfig.mockResolvedValue(makeAgentConfig())
      const mockServer = makeMockServer()
      mockCreateDevServer.mockReturnValue(mockServer as any)

      const promise = program.parseAsync(['node', 'test', 'dev', '.', '--no-watch'])
      await new Promise(r => setTimeout(r, 50))

      expect(mockChokidar.watch).not.toHaveBeenCalled()
      const stderr = allStderr()
      expect(stderr).toContain('File watching disabled')

      promise.catch(() => {})
    })

    it('watcher ignores node_modules and .git', async () => {
      mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)
      mockFs.access.mockResolvedValue(undefined)
      mockLoadAgentConfig.mockResolvedValue(makeAgentConfig())
      const mockServer = makeMockServer()
      mockCreateDevServer.mockReturnValue(mockServer as any)
      mockChokidar.watch.mockReturnValue(makeMockWatcher() as any)

      const promise = program.parseAsync(['node', 'test', 'dev', '.'])
      await new Promise(r => setTimeout(r, 50))

      const watcherOpts = mockChokidar.watch.mock.calls[0][1] as { ignored: RegExp }
      expect(watcherOpts.ignored.test('node_modules')).toBe(true)
      expect(watcherOpts.ignored.test('.git')).toBe(true)
      expect(watcherOpts.ignored.test('__pycache__')).toBe(true)
      expect(watcherOpts.ignored.test('.venv')).toBe(true)

      promise.catch(() => {})
    })
  })

  // ── Config getter ──

  describe('config getter passed to server', () => {
    it('passes a getter that returns the current config', async () => {
      mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)
      mockFs.access.mockResolvedValue(undefined)
      const config = makeAgentConfig()
      mockLoadAgentConfig.mockResolvedValue(config)
      const mockServer = makeMockServer()
      mockCreateDevServer.mockReturnValue(mockServer as any)
      mockChokidar.watch.mockReturnValue(makeMockWatcher() as any)

      const promise = program.parseAsync(['node', 'test', 'dev', '.'])
      await new Promise(r => setTimeout(r, 50))

      const getConfig = mockCreateDevServer.mock.calls[0][2]
      const result = getConfig()
      expect(result).toBeTruthy()
      expect(result?.manifest.name).toBe('test-agent')

      promise.catch(() => {})
    })
  })

  // ── Default path ──

  describe('default path', () => {
    it('defaults to current directory when no path given', async () => {
      mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)
      mockFs.access.mockResolvedValue(undefined)
      mockLoadAgentConfig.mockResolvedValue(makeAgentConfig())
      const mockServer = makeMockServer()
      mockCreateDevServer.mockReturnValue(mockServer as any)
      mockChokidar.watch.mockReturnValue(makeMockWatcher() as any)

      const promise = program.parseAsync(['node', 'test', 'dev'])
      await new Promise(r => setTimeout(r, 50))

      // loadAgentConfig should be called with resolved cwd
      expect(mockLoadAgentConfig).toHaveBeenCalledWith(expect.any(String))

      promise.catch(() => {})
    })
  })
})
