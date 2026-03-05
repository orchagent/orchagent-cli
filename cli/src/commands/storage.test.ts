import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

vi.mock('../lib/config')
vi.mock('../lib/api')
vi.mock('../lib/output')

import { registerStorageCommand } from './storage'
import { getResolvedConfig, loadConfig } from '../lib/config'
import { request } from '../lib/api'

const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockLoadConfig = vi.mocked(loadConfig)
const mockRequest = vi.mocked(request)

const mockWorkspaces = {
  workspaces: [{ id: 'ws-1', name: 'My Workspace', slug: 'my-ws' }],
}

const mockDocResponse = {
  namespace: 'signals',
  key: '2026-03-05',
  value: { status: 'open' },
  version: 1,
  size_bytes: 20,
  updated_at: '2026-03-05T00:00:00Z',
  updated_by: 'cli',
}

describe('storage command — stdin support', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let tmpDir: string

  beforeEach(async () => {
    vi.clearAllMocks()

    program = new Command()
    program.exitOverride()
    registerStorageCommand(program)

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
    })
    mockLoadConfig.mockResolvedValue({ workspace: 'my-ws' })

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-test-'))
  })

  afterEach(async () => {
    stdoutSpy.mockRestore()
    vi.restoreAllMocks()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  // ─────────────────────────────────────────────
  // SET — inline JSON (existing behavior)
  // ─────────────────────────────────────────────
  it('set: accepts inline JSON', async () => {
    mockRequest
      .mockResolvedValueOnce(mockWorkspaces as any)
      .mockResolvedValueOnce(mockDocResponse as any)

    await program.parseAsync([
      'node', 'test', 'storage', 'set', 'signals', '2026-03-05', '{"status":"open"}',
    ])

    const putCall = mockRequest.mock.calls[1]
    expect(putCall[1]).toBe('PUT')
    expect(putCall[2]).toBe('/storage/signals/2026-03-05')
    expect(JSON.parse(putCall[3]!.body as string)).toEqual({ status: 'open' })
  })

  // ─────────────────────────────────────────────
  // SET — @file (existing behavior)
  // ─────────────────────────────────────────────
  it('set: accepts @file.json', async () => {
    const filePath = path.join(tmpDir, 'data.json')
    await fs.writeFile(filePath, '{"from":"file"}')

    mockRequest
      .mockResolvedValueOnce(mockWorkspaces as any)
      .mockResolvedValueOnce(mockDocResponse as any)

    await program.parseAsync([
      'node', 'test', 'storage', 'set', 'signals', '2026-03-05', `@${filePath}`,
    ])

    const putCall = mockRequest.mock.calls[1]
    expect(JSON.parse(putCall[3]!.body as string)).toEqual({ from: 'file' })
  })

  // ─────────────────────────────────────────────
  // SET — explicit "-" reads stdin
  // ─────────────────────────────────────────────
  it('set: "-" reads JSON from stdin', async () => {
    // Mock process.stdin as a non-TTY async iterable that yields JSON
    const origIsTTY = process.stdin.isTTY
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })

    const jsonBuf = Buffer.from('{"from":"stdin"}')
    const originalIterator = process.stdin[Symbol.asyncIterator]
    process.stdin[Symbol.asyncIterator] = async function* () {
      yield jsonBuf
    } as any

    mockRequest
      .mockResolvedValueOnce(mockWorkspaces as any)
      .mockResolvedValueOnce(mockDocResponse as any)

    try {
      await program.parseAsync([
        'node', 'test', 'storage', 'set', 'signals', '2026-03-05', '-',
      ])

      const putCall = mockRequest.mock.calls[1]
      expect(putCall[1]).toBe('PUT')
      expect(JSON.parse(putCall[3]!.body as string)).toEqual({ from: 'stdin' })
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true })
      process.stdin[Symbol.asyncIterator] = originalIterator
    }
  })

  // ─────────────────────────────────────────────
  // SET — @- reads stdin (alt syntax)
  // ─────────────────────────────────────────────
  it('set: "@-" reads JSON from stdin', async () => {
    const origIsTTY = process.stdin.isTTY
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })

    const jsonBuf = Buffer.from('{"from":"at-stdin"}')
    const originalIterator = process.stdin[Symbol.asyncIterator]
    process.stdin[Symbol.asyncIterator] = async function* () {
      yield jsonBuf
    } as any

    mockRequest
      .mockResolvedValueOnce(mockWorkspaces as any)
      .mockResolvedValueOnce(mockDocResponse as any)

    try {
      await program.parseAsync([
        'node', 'test', 'storage', 'set', 'signals', '2026-03-05', '@-',
      ])

      const putCall = mockRequest.mock.calls[1]
      expect(JSON.parse(putCall[3]!.body as string)).toEqual({ from: 'at-stdin' })
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true })
      process.stdin[Symbol.asyncIterator] = originalIterator
    }
  })

  // ─────────────────────────────────────────────
  // SET — omitted value reads stdin (implicit)
  // ─────────────────────────────────────────────
  it('set: omitted value reads from piped stdin', async () => {
    const origIsTTY = process.stdin.isTTY
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })

    const jsonBuf = Buffer.from('{"implicit":"stdin"}')
    const originalIterator = process.stdin[Symbol.asyncIterator]
    process.stdin[Symbol.asyncIterator] = async function* () {
      yield jsonBuf
    } as any

    mockRequest
      .mockResolvedValueOnce(mockWorkspaces as any)
      .mockResolvedValueOnce(mockDocResponse as any)

    try {
      await program.parseAsync([
        'node', 'test', 'storage', 'set', 'signals', '2026-03-05',
      ])

      const putCall = mockRequest.mock.calls[1]
      expect(JSON.parse(putCall[3]!.body as string)).toEqual({ implicit: 'stdin' })
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true })
      process.stdin[Symbol.asyncIterator] = originalIterator
    }
  })

  // ─────────────────────────────────────────────
  // SET — omitted value + TTY = helpful error
  // ─────────────────────────────────────────────
  it('set: omitted value with TTY shows usage error', async () => {
    const origIsTTY = process.stdin.isTTY
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })

    mockRequest
      .mockResolvedValueOnce(mockWorkspaces as any)

    try {
      await expect(
        program.parseAsync(['node', 'test', 'storage', 'set', 'signals', '2026-03-05'])
      ).rejects.toThrow('No JSON value provided')
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true })
    }
  })

  // ─────────────────────────────────────────────
  // SET — invalid JSON from stdin
  // ─────────────────────────────────────────────
  it('set: invalid JSON from stdin throws', async () => {
    const origIsTTY = process.stdin.isTTY
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })

    const originalIterator = process.stdin[Symbol.asyncIterator]
    process.stdin[Symbol.asyncIterator] = async function* () {
      yield Buffer.from('not json')
    } as any

    mockRequest
      .mockResolvedValueOnce(mockWorkspaces as any)

    try {
      await expect(
        program.parseAsync(['node', 'test', 'storage', 'set', 'signals', '2026-03-05', '-'])
      ).rejects.toThrow('Invalid JSON')
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true })
      process.stdin[Symbol.asyncIterator] = originalIterator
    }
  })

  // ─────────────────────────────────────────────
  // PATCH — stdin support
  // ─────────────────────────────────────────────
  it('patch: "-" reads JSON from stdin', async () => {
    const origIsTTY = process.stdin.isTTY
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })

    const jsonBuf = Buffer.from('{"patched":true}')
    const originalIterator = process.stdin[Symbol.asyncIterator]
    process.stdin[Symbol.asyncIterator] = async function* () {
      yield jsonBuf
    } as any

    mockRequest
      .mockResolvedValueOnce(mockWorkspaces as any)
      .mockResolvedValueOnce(mockDocResponse as any)

    try {
      await program.parseAsync([
        'node', 'test', 'storage', 'patch', 'signals', '2026-03-05', '-',
      ])

      const patchCall = mockRequest.mock.calls[1]
      expect(patchCall[1]).toBe('PATCH')
      expect(JSON.parse(patchCall[3]!.body as string)).toEqual({ patched: true })
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true })
      process.stdin[Symbol.asyncIterator] = originalIterator
    }
  })

  it('patch: omitted value reads from piped stdin', async () => {
    const origIsTTY = process.stdin.isTTY
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })

    const jsonBuf = Buffer.from('{"implicit":"patch"}')
    const originalIterator = process.stdin[Symbol.asyncIterator]
    process.stdin[Symbol.asyncIterator] = async function* () {
      yield jsonBuf
    } as any

    mockRequest
      .mockResolvedValueOnce(mockWorkspaces as any)
      .mockResolvedValueOnce(mockDocResponse as any)

    try {
      await program.parseAsync([
        'node', 'test', 'storage', 'patch', 'signals', '2026-03-05',
      ])

      const patchCall = mockRequest.mock.calls[1]
      expect(patchCall[1]).toBe('PATCH')
      expect(JSON.parse(patchCall[3]!.body as string)).toEqual({ implicit: 'patch' })
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true })
      process.stdin[Symbol.asyncIterator] = originalIterator
    }
  })

  // ─────────────────────────────────────────────
  // @file — nonexistent file
  // ─────────────────────────────────────────────
  it('set: @nonexistent throws file not found', async () => {
    mockRequest
      .mockResolvedValueOnce(mockWorkspaces as any)

    await expect(
      program.parseAsync([
        'node', 'test', 'storage', 'set', 'signals', '2026-03-05', '@/nonexistent/path.json',
      ])
    ).rejects.toThrow('File not found')
  })
})
