/**
 * Tests for the env command --json flag (BUG-14).
 *
 * Tests cover:
 * - orch env list --json outputs raw JSON
 * - orch env status <id> --json outputs raw JSON
 * - Table output still works without --json
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

vi.mock('../lib/config')
vi.mock('../lib/api')
vi.mock('../lib/output')
vi.mock('../lib/analytics', () => ({ track: vi.fn() }))

import { registerEnvCommand } from './env'
import { getResolvedConfig, loadConfig } from '../lib/config'
import { listEnvironments, getEnvironment, getOrg } from '../lib/api'
import { printJson } from '../lib/output'

const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockLoadConfig = vi.mocked(loadConfig)
const mockListEnvironments = vi.mocked(listEnvironments)
const mockGetEnvironment = vi.mocked(getEnvironment)
const mockGetOrg = vi.mocked(getOrg)
const mockPrintJson = vi.mocked(printJson)

const mockEnvList = {
  environments: [
    {
      environment: { id: 'env-001', name: 'python-3.11', is_predefined: true, created_at: '2026-02-10T00:00:00Z', dockerfile_content: 'FROM python:3.11' },
      build: { status: 'ready', error_message: null, build_logs: null },
      agent_count: 3,
    },
    {
      environment: { id: 'env-002', name: 'custom-ml', is_predefined: false, created_at: '2026-02-12T00:00:00Z', dockerfile_content: 'FROM python:3.11\nRUN pip install torch' },
      build: { status: 'building', error_message: null, build_logs: null },
      agent_count: 1,
    },
  ],
  default_environment_id: 'env-001',
}

const mockEnvDetail = {
  environment: { id: 'env-001', name: 'python-3.11', is_predefined: true, created_at: '2026-02-10T00:00:00Z', dockerfile_content: 'FROM python:3.11' },
  build: { status: 'ready', error_message: null, build_logs: null },
  agent_count: 3,
}

describe('env command', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()

    program = new Command()
    program.exitOverride()
    registerEnvCommand(program)

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
    })
    mockLoadConfig.mockResolvedValue({})
    mockGetOrg.mockResolvedValue({ id: 'org-1', slug: 'my-org' } as any)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    vi.restoreAllMocks()
  })

  describe('env list', () => {
    it('outputs JSON with --json flag', async () => {
      mockListEnvironments.mockResolvedValueOnce(mockEnvList as any)

      await program.parseAsync(['node', 'test', 'env', 'list', '--json'])

      expect(mockPrintJson).toHaveBeenCalledTimes(1)
      expect(mockPrintJson).toHaveBeenCalledWith(mockEnvList)
    })

    it('does not call printJson without --json flag', async () => {
      mockListEnvironments.mockResolvedValueOnce(mockEnvList as any)

      await program.parseAsync(['node', 'test', 'env', 'list'])

      expect(mockPrintJson).not.toHaveBeenCalled()
    })

    it('outputs JSON even when environment list is empty', async () => {
      const emptyResult = { environments: [], default_environment_id: null }
      mockListEnvironments.mockResolvedValueOnce(emptyResult as any)

      await program.parseAsync(['node', 'test', 'env', 'list', '--json'])

      expect(mockPrintJson).toHaveBeenCalledWith(emptyResult)
    })
  })

  describe('env status', () => {
    it('outputs JSON with --json flag', async () => {
      mockGetEnvironment.mockResolvedValueOnce(mockEnvDetail as any)

      await program.parseAsync(['node', 'test', 'env', 'status', 'env-001', '--json'])

      expect(mockPrintJson).toHaveBeenCalledTimes(1)
      expect(mockPrintJson).toHaveBeenCalledWith(mockEnvDetail)
    })

    it('does not call printJson without --json flag', async () => {
      mockGetEnvironment.mockResolvedValueOnce(mockEnvDetail as any)

      await program.parseAsync(['node', 'test', 'env', 'status', 'env-001'])

      expect(mockPrintJson).not.toHaveBeenCalled()
    })
  })
})
