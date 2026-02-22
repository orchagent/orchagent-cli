/**
 * Tests for the health command (IDEA-011).
 *
 * Validates smoke-test functionality: agent resolution, cloud execution,
 * JSON output, error handling, and edge cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

vi.mock('../lib/config', () => ({
  getResolvedConfig: vi.fn(),
  loadConfig: vi.fn().mockResolvedValue({}),
}))

vi.mock('../lib/api', () => {
  const ApiError = class extends Error {
    status: number
    payload: unknown
    constructor(message: string, status: number) {
      super(message)
      this.status = status
    }
  }
  return {
    ApiError,
    getAgentWithFallback: vi.fn(),
    resolveWorkspaceIdForOrg: vi.fn().mockResolvedValue(undefined),
    safeFetchWithRetryForCalls: vi.fn(),
  }
})

vi.mock('../../package.json', () => ({ default: { version: '0.3.86' } }))

import { registerHealthCommand } from './health'
import { getResolvedConfig, loadConfig } from '../lib/config'
import {
  getAgentWithFallback,
  resolveWorkspaceIdForOrg,
  safeFetchWithRetryForCalls,
} from '../lib/api'

const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockLoadConfig = vi.mocked(loadConfig)
const mockGetAgentWithFallback = vi.mocked(getAgentWithFallback)
const mockResolveWorkspaceId = vi.mocked(resolveWorkspaceIdForOrg)
const mockFetch = vi.mocked(safeFetchWithRetryForCalls)

function makeResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  const headerMap = new Headers(headers)
  return new Response(JSON.stringify(body), {
    status,
    headers: headerMap,
  })
}

function allStderr(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map(c => c[0]).join('')
}

function allStdout(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map(c => c[0]).join('')
}

describe('orch health', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerHealthCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'test-org',
    })
    mockLoadConfig.mockResolvedValue({})
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  describe('successful health check', () => {
    it('reports PASS for a healthy agent', async () => {
      mockGetAgentWithFallback.mockResolvedValue({
        id: 'agent-1',
        org_name: 'Joe',
        org_slug: 'joe',
        name: 'my-agent',
        version: 'v1',
        type: 'prompt',
        supported_providers: ['any'],
      } as any)

      mockFetch.mockResolvedValue(
        makeResponse(200, { result: 'ok', run_id: 'run_abc123' })
      )

      await program.parseAsync(['node', 'test', 'health', 'joe/my-agent@v1'])

      // Should have called getAgentWithFallback
      expect(mockGetAgentWithFallback).toHaveBeenCalledWith(
        expect.any(Object), 'joe', 'my-agent', 'v1', undefined
      )

      // Should have POSTed to the agent endpoint
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test.com/joe/my-agent/v1/analyze',
        expect.objectContaining({
          method: 'POST',
          body: '{}',
        })
      )

      const stderr = allStderr(stderrSpy)
      expect(stderr).toContain('PASS')
      expect(stderr).toContain('Resolve:')
      expect(stderr).toContain('Execute:')
    })

    it('auto-generates sample input from schema', async () => {
      mockGetAgentWithFallback.mockResolvedValue({
        id: 'agent-2',
        org_name: 'Joe',
        org_slug: 'joe',
        name: 'schema-agent',
        version: 'v1',
        type: 'tool',
        input_schema: {
          type: 'object',
          properties: {
            repo_url: { type: 'string', description: 'Repo URL' },
            depth: { type: 'integer' },
            verbose: { type: 'boolean' },
          },
          required: ['repo_url'],
        },
        supported_providers: ['any'],
      } as any)

      mockFetch.mockResolvedValue(makeResponse(200, { result: 'ok' }))

      await program.parseAsync(['node', 'test', 'health', 'joe/schema-agent'])

      // Should send only required field with sample value
      const fetchCall = mockFetch.mock.calls[0]
      const sentBody = JSON.parse(fetchCall[1]?.body as string)
      expect(sentBody).toEqual({ repo_url: 'test' })
    })

    it('uses custom input via --data', async () => {
      mockGetAgentWithFallback.mockResolvedValue({
        id: 'agent-3',
        org_name: 'Joe',
        org_slug: 'joe',
        name: 'custom-input',
        version: 'v1',
        type: 'prompt',
        supported_providers: ['any'],
      } as any)

      mockFetch.mockResolvedValue(makeResponse(200, { result: 'ok' }))

      await program.parseAsync([
        'node', 'test', 'health', 'joe/custom-input',
        '--data', '{"query": "hello world"}',
      ])

      const fetchCall = mockFetch.mock.calls[0]
      const sentBody = JSON.parse(fetchCall[1]?.body as string)
      expect(sentBody).toEqual({ query: 'hello world' })
    })

    it('extracts run_id from response body', async () => {
      mockGetAgentWithFallback.mockResolvedValue({
        id: 'agent-4',
        org_name: 'Joe',
        org_slug: 'joe',
        name: 'run-id-agent',
        version: 'v1',
        type: 'prompt',
        supported_providers: ['any'],
      } as any)

      mockFetch.mockResolvedValue(
        makeResponse(200, { result: 'ok', run_id: 'run_xyz789' })
      )

      await program.parseAsync(['node', 'test', 'health', 'joe/run-id-agent', '--json'])

      const jsonOutput = stdoutSpy.mock.calls.find(c =>
        c[0].toString().includes('"status"')
      )
      expect(jsonOutput).toBeTruthy()
      const parsed = JSON.parse(jsonOutput![0] as string)
      expect(parsed.run_id).toBe('run_xyz789')
      expect(parsed.status).toBe('pass')
    })

    it('extracts run_id from response header', async () => {
      mockGetAgentWithFallback.mockResolvedValue({
        id: 'agent-4b',
        org_name: 'Joe',
        org_slug: 'joe',
        name: 'header-agent',
        version: 'v1',
        type: 'prompt',
        supported_providers: ['any'],
      } as any)

      mockFetch.mockResolvedValue(
        makeResponse(200, { result: 'ok' }, { 'x-orchagent-run-id': 'run_hdr456' })
      )

      await program.parseAsync(['node', 'test', 'health', 'joe/header-agent', '--json'])

      const jsonOutput = stdoutSpy.mock.calls.find(c =>
        c[0].toString().includes('"status"')
      )
      const parsed = JSON.parse(jsonOutput![0] as string)
      expect(parsed.run_id).toBe('run_hdr456')
    })
  })

  describe('agent resolution failures', () => {
    it('reports FAIL when agent is not found', async () => {
      const { ApiError } = await import('../lib/api')
      mockGetAgentWithFallback.mockRejectedValue(
        new ApiError('Agent not found', 404)
      )

      await program.parseAsync(['node', 'test', 'health', 'joe/missing-agent', '--json'])

      const jsonOutput = stdoutSpy.mock.calls.find(c =>
        c[0].toString().includes('"status"')
      )
      const parsed = JSON.parse(jsonOutput![0] as string)
      expect(parsed.status).toBe('fail')
      expect(parsed.checks.resolve).toBe('fail')
      expect(parsed.checks.execute).toBe('skip')
      expect(parsed.error).toContain('not found')
    })
  })

  describe('execution failures', () => {
    it('reports FAIL on non-200 response', async () => {
      mockGetAgentWithFallback.mockResolvedValue({
        id: 'agent-5',
        org_name: 'Joe',
        org_slug: 'joe',
        name: 'failing-agent',
        version: 'v1',
        type: 'tool',
        supported_providers: ['any'],
      } as any)

      mockFetch.mockResolvedValue(
        makeResponse(500, { error: { message: 'Internal sandbox error' } })
      )

      await program.parseAsync(['node', 'test', 'health', 'joe/failing-agent', '--json'])

      const jsonOutput = stdoutSpy.mock.calls.find(c =>
        c[0].toString().includes('"status"')
      )
      const parsed = JSON.parse(jsonOutput![0] as string)
      expect(parsed.status).toBe('fail')
      expect(parsed.checks.resolve).toBe('pass')
      expect(parsed.checks.execute).toBe('fail')
      expect(parsed.error).toContain('Internal sandbox error')
    })

    it('reports FAIL on network error during execution', async () => {
      mockGetAgentWithFallback.mockResolvedValue({
        id: 'agent-6',
        org_name: 'Joe',
        org_slug: 'joe',
        name: 'timeout-agent',
        version: 'v1',
        type: 'prompt',
        supported_providers: ['any'],
      } as any)

      mockFetch.mockRejectedValue(new Error('Connection timed out'))

      await program.parseAsync(['node', 'test', 'health', 'joe/timeout-agent', '--json'])

      const jsonOutput = stdoutSpy.mock.calls.find(c =>
        c[0].toString().includes('"status"')
      )
      const parsed = JSON.parse(jsonOutput![0] as string)
      expect(parsed.status).toBe('fail')
      expect(parsed.checks.execute).toBe('fail')
      expect(parsed.error).toContain('Connection timed out')
    })

    it('handles non-JSON error responses', async () => {
      mockGetAgentWithFallback.mockResolvedValue({
        id: 'agent-7',
        org_name: 'Joe',
        org_slug: 'joe',
        name: 'html-error',
        version: 'v1',
        type: 'tool',
        supported_providers: ['any'],
      } as any)

      mockFetch.mockResolvedValue(
        new Response('<html>Bad Gateway</html>', {
          status: 502,
          headers: new Headers(),
        })
      )

      await program.parseAsync(['node', 'test', 'health', 'joe/html-error', '--json'])

      const jsonOutput = stdoutSpy.mock.calls.find(c =>
        c[0].toString().includes('"status"')
      )
      const parsed = JSON.parse(jsonOutput![0] as string)
      expect(parsed.status).toBe('fail')
      expect(parsed.error).toContain('502')
    })
  })

  describe('skill agents', () => {
    it('skips execution for skill type and reports error', async () => {
      mockGetAgentWithFallback.mockResolvedValue({
        id: 'skill-1',
        org_name: 'Joe',
        org_slug: 'joe',
        name: 'my-skill',
        version: 'v1',
        type: 'skill',
        supported_providers: ['any'],
      } as any)

      await program.parseAsync(['node', 'test', 'health', 'joe/my-skill', '--json'])

      const jsonOutput = stdoutSpy.mock.calls.find(c =>
        c[0].toString().includes('"status"')
      )
      const parsed = JSON.parse(jsonOutput![0] as string)
      expect(parsed.status).toBe('fail')
      expect(parsed.checks.resolve).toBe('pass')
      expect(parsed.checks.execute).toBe('skip')
      expect(parsed.error).toContain('Skills are not runnable')
      // Should NOT have attempted execution
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  describe('auth errors', () => {
    it('throws when no API key', async () => {
      mockGetResolvedConfig.mockResolvedValue({
        apiUrl: 'https://api.test.com',
        // no apiKey
      })

      await expect(
        program.parseAsync(['node', 'test', 'health', 'joe/my-agent'])
      ).rejects.toThrow('Missing API key')
    })
  })

  describe('JSON output', () => {
    it('outputs valid JSON with all expected fields', async () => {
      mockGetAgentWithFallback.mockResolvedValue({
        id: 'agent-8',
        org_name: 'Joe',
        org_slug: 'joe',
        name: 'json-test',
        version: 'v2',
        type: 'agent',
        supported_providers: ['anthropic'],
      } as any)

      mockFetch.mockResolvedValue(
        makeResponse(200, { result: 'done', run_id: 'run_json123' })
      )

      await program.parseAsync(['node', 'test', 'health', 'joe/json-test@v2', '--json'])

      const jsonOutput = stdoutSpy.mock.calls.find(c =>
        c[0].toString().includes('"status"')
      )
      expect(jsonOutput).toBeTruthy()
      const parsed = JSON.parse(jsonOutput![0] as string)

      expect(parsed).toEqual(expect.objectContaining({
        agent: 'joe/json-test',
        version: 'v2',
        status: 'pass',
        run_id: 'run_json123',
        checks: { resolve: 'pass', execute: 'pass' },
      }))
      expect(typeof parsed.latency_ms).toBe('number')
      expect(parsed.latency_ms).toBeGreaterThanOrEqual(0)
    })
  })

  describe('input schema generation', () => {
    it('generates sample values for all required types', async () => {
      mockGetAgentWithFallback.mockResolvedValue({
        id: 'agent-schema',
        org_name: 'Joe',
        org_slug: 'joe',
        name: 'all-types',
        version: 'v1',
        type: 'tool',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            count: { type: 'integer' },
            score: { type: 'number' },
            active: { type: 'boolean' },
            items: { type: 'array' },
            config: { type: 'object' },
          },
          required: ['name', 'count', 'score', 'active', 'items', 'config'],
        },
        supported_providers: ['any'],
      } as any)

      mockFetch.mockResolvedValue(makeResponse(200, {}))

      await program.parseAsync(['node', 'test', 'health', 'joe/all-types'])

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1]?.body as string)
      expect(sentBody).toEqual({
        name: 'test',
        count: 1,
        score: 1,
        active: true,
        items: [],
        config: {},
      })
    })

    it('uses enum first value when available', async () => {
      mockGetAgentWithFallback.mockResolvedValue({
        id: 'agent-enum',
        org_name: 'Joe',
        org_slug: 'joe',
        name: 'enum-agent',
        version: 'v1',
        type: 'prompt',
        input_schema: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['fast', 'thorough', 'balanced'] },
          },
          required: ['mode'],
        },
        supported_providers: ['any'],
      } as any)

      mockFetch.mockResolvedValue(makeResponse(200, {}))

      await program.parseAsync(['node', 'test', 'health', 'joe/enum-agent'])

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1]?.body as string)
      expect(sentBody.mode).toBe('fast')
    })

    it('uses default value when available', async () => {
      mockGetAgentWithFallback.mockResolvedValue({
        id: 'agent-default',
        org_name: 'Joe',
        org_slug: 'joe',
        name: 'default-agent',
        version: 'v1',
        type: 'prompt',
        input_schema: {
          type: 'object',
          properties: {
            limit: { type: 'integer', default: 10 },
          },
          required: ['limit'],
        },
        supported_providers: ['any'],
      } as any)

      mockFetch.mockResolvedValue(makeResponse(200, {}))

      await program.parseAsync(['node', 'test', 'health', 'joe/default-agent'])

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1]?.body as string)
      expect(sentBody.limit).toBe(10)
    })

    it('sends first optional field when no required fields', async () => {
      mockGetAgentWithFallback.mockResolvedValue({
        id: 'agent-optional',
        org_name: 'Joe',
        org_slug: 'joe',
        name: 'optional-agent',
        version: 'v1',
        type: 'prompt',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            count: { type: 'integer' },
          },
          // no required
        },
        supported_providers: ['any'],
      } as any)

      mockFetch.mockResolvedValue(makeResponse(200, {}))

      await program.parseAsync(['node', 'test', 'health', 'joe/optional-agent'])

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1]?.body as string)
      expect(sentBody).toEqual({ query: 'test' })
    })

    it('sends empty object when no schema', async () => {
      mockGetAgentWithFallback.mockResolvedValue({
        id: 'agent-noschema',
        org_name: 'Joe',
        org_slug: 'joe',
        name: 'noschema-agent',
        version: 'v1',
        type: 'prompt',
        supported_providers: ['any'],
      } as any)

      mockFetch.mockResolvedValue(makeResponse(200, {}))

      await program.parseAsync(['node', 'test', 'health', 'joe/noschema-agent'])

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1]?.body as string)
      expect(sentBody).toEqual({})
    })
  })

  describe('workspace resolution', () => {
    it('passes workspace ID to agent resolution and execution', async () => {
      mockResolveWorkspaceId.mockResolvedValue('ws_team123')
      mockGetAgentWithFallback.mockResolvedValue({
        id: 'agent-ws',
        org_name: 'Team',
        org_slug: 'team',
        name: 'team-agent',
        version: 'v1',
        type: 'prompt',
        supported_providers: ['any'],
      } as any)

      mockFetch.mockResolvedValue(makeResponse(200, { result: 'ok' }))

      await program.parseAsync(['node', 'test', 'health', 'team/team-agent'])

      // Should pass workspace to resolution
      expect(mockGetAgentWithFallback).toHaveBeenCalledWith(
        expect.any(Object), 'team', 'team-agent', 'latest', 'ws_team123'
      )

      // Should include workspace header in request
      const fetchHeaders = mockFetch.mock.calls[0][1]?.headers as Record<string, string>
      expect(fetchHeaders['X-Workspace-Id']).toBe('ws_team123')
    })
  })

  describe('default endpoint', () => {
    it('uses agent default_endpoint when set', async () => {
      mockGetAgentWithFallback.mockResolvedValue({
        id: 'agent-ep',
        org_name: 'Joe',
        org_slug: 'joe',
        name: 'custom-ep',
        version: 'v1',
        type: 'tool',
        default_endpoint: 'scan',
        supported_providers: ['any'],
      } as any)

      mockFetch.mockResolvedValue(makeResponse(200, {}))

      await program.parseAsync(['node', 'test', 'health', 'joe/custom-ep'])

      const url = mockFetch.mock.calls[0][0]
      expect(url).toContain('/joe/custom-ep/latest/scan')
    })

    it('falls back to analyze endpoint', async () => {
      mockGetAgentWithFallback.mockResolvedValue({
        id: 'agent-default-ep',
        org_name: 'Joe',
        org_slug: 'joe',
        name: 'default-ep',
        version: 'v1',
        type: 'prompt',
        supported_providers: ['any'],
      } as any)

      mockFetch.mockResolvedValue(makeResponse(200, {}))

      await program.parseAsync(['node', 'test', 'health', 'joe/default-ep'])

      const url = mockFetch.mock.calls[0][0]
      expect(url).toContain('/joe/default-ep/latest/analyze')
    })
  })

  describe('timeout option', () => {
    it('passes custom timeout to fetch', async () => {
      mockGetAgentWithFallback.mockResolvedValue({
        id: 'agent-timeout',
        org_name: 'Joe',
        org_slug: 'joe',
        name: 'slow-agent',
        version: 'v1',
        type: 'agent',
        supported_providers: ['any'],
      } as any)

      mockFetch.mockResolvedValue(makeResponse(200, {}))

      await program.parseAsync([
        'node', 'test', 'health', 'joe/slow-agent', '--timeout', '60000',
      ])

      const fetchOptions = mockFetch.mock.calls[0][1]
      expect(fetchOptions?.timeoutMs).toBe(60000)
    })

    it('rejects timeout below 1000ms', async () => {
      await expect(
        program.parseAsync(['node', 'test', 'health', 'joe/agent', '--timeout', '500'])
      ).rejects.toThrow('Timeout must be at least 1000ms')
    })
  })

  describe('human-readable output', () => {
    it('shows run ID and logs hint on success', async () => {
      mockGetAgentWithFallback.mockResolvedValue({
        id: 'agent-hint',
        org_name: 'Joe',
        org_slug: 'joe',
        name: 'hint-agent',
        version: 'v1',
        type: 'prompt',
        supported_providers: ['any'],
      } as any)

      mockFetch.mockResolvedValue(
        makeResponse(200, { result: 'ok', run_id: 'run_hint999' })
      )

      await program.parseAsync(['node', 'test', 'health', 'joe/hint-agent'])

      const stderr = allStderr(stderrSpy)
      expect(stderr).toContain('run_hint999')
      expect(stderr).toContain('orch logs run_hint999')
    })

    it('shows error message on failure', async () => {
      mockGetAgentWithFallback.mockResolvedValue({
        id: 'agent-errmsg',
        org_name: 'Joe',
        org_slug: 'joe',
        name: 'err-agent',
        version: 'v1',
        type: 'tool',
        supported_providers: ['any'],
      } as any)

      mockFetch.mockResolvedValue(
        makeResponse(500, { error: { message: 'Sandbox crashed' } })
      )

      await program.parseAsync(['node', 'test', 'health', 'joe/err-agent'])

      const stderr = allStderr(stderrSpy)
      expect(stderr).toContain('FAIL')
      expect(stderr).toContain('Sandbox crashed')
    })
  })
})
