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

      // Should send only required field — field name 'repo_url' triggers URL heuristic
      const fetchCall = mockFetch.mock.calls[0]
      const sentBody = JSON.parse(fetchCall[1]?.body as string)
      expect(sentBody).toEqual({ repo_url: 'https://example.com' })
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
            query: { type: 'string' },
            count: { type: 'integer' },
            score: { type: 'number' },
            active: { type: 'boolean' },
            items: { type: 'array' },
            config: { type: 'object' },
          },
          required: ['query', 'count', 'score', 'active', 'items', 'config'],
        },
        supported_providers: ['any'],
      } as any)

      mockFetch.mockResolvedValue(makeResponse(200, {}))

      await program.parseAsync(['node', 'test', 'health', 'joe/all-types'])

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1]?.body as string)
      expect(sentBody).toEqual({
        query: 'test',
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

  describe('schema-aware sample generation (UX-3)', () => {
    // Helper: run health with a given input_schema and return the body sent to the server
    async function getSentBody(inputSchema: Record<string, unknown>): Promise<Record<string, unknown>> {
      mockGetAgentWithFallback.mockResolvedValue({
        id: 'agent-ux3',
        org_name: 'Joe',
        org_slug: 'joe',
        name: 'ux3-agent',
        version: 'v1',
        type: 'tool',
        input_schema: inputSchema,
        supported_providers: ['any'],
      } as any)
      mockFetch.mockResolvedValue(makeResponse(200, {}))
      await program.parseAsync(['node', 'test', 'health', 'joe/ux3-agent'])
      return JSON.parse(mockFetch.mock.calls[0][1]?.body as string)
    }

    describe('format-based string generation', () => {
      it('generates URL for format: uri', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: { target: { type: 'string', format: 'uri' } },
          required: ['target'],
        })
        expect(body.target).toBe('https://example.com')
      })

      it('generates URL for format: url', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: { site: { type: 'string', format: 'url' } },
          required: ['site'],
        })
        expect(body.site).toBe('https://example.com')
      })

      it('generates email for format: email', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: { contact: { type: 'string', format: 'email' } },
          required: ['contact'],
        })
        expect(body.contact).toBe('test@example.com')
      })

      it('generates date for format: date', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: { when: { type: 'string', format: 'date' } },
          required: ['when'],
        })
        expect(body.when).toBe('2026-01-01')
      })

      it('generates datetime for format: date-time', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: { ts: { type: 'string', format: 'date-time' } },
          required: ['ts'],
        })
        expect(body.ts).toBe('2026-01-01T00:00:00Z')
      })

      it('generates UUID for format: uuid', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        })
        expect(body.id).toBe('00000000-0000-0000-0000-000000000000')
      })

      it('generates hostname for format: hostname', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: { server: { type: 'string', format: 'hostname' } },
          required: ['server'],
        })
        expect(body.server).toBe('example.com')
      })

      it('generates IPv4 for format: ipv4', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: { addr: { type: 'string', format: 'ipv4' } },
          required: ['addr'],
        })
        expect(body.addr).toBe('192.0.2.1')
      })

      it('generates IPv6 for format: ipv6', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: { addr6: { type: 'string', format: 'ipv6' } },
          required: ['addr6'],
        })
        expect(body.addr6).toBe('::1')
      })

      it('falls back to "test" for unknown format', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: { thing: { type: 'string', format: 'custom-weird-format' } },
          required: ['thing'],
        })
        expect(body.thing).toBe('test')
      })
    })

    describe('field name heuristics', () => {
      it('generates URL for field named repo_url', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: { repo_url: { type: 'string' } },
          required: ['repo_url'],
        })
        expect(body.repo_url).toBe('https://example.com')
      })

      it('generates URL for field named webhook', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: { webhook: { type: 'string' } },
          required: ['webhook'],
        })
        expect(body.webhook).toBe('https://example.com')
      })

      it('generates email for field named user_email', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: { user_email: { type: 'string' } },
          required: ['user_email'],
        })
        expect(body.user_email).toBe('test@example.com')
      })

      it('generates file path for field named file_path', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: { file_path: { type: 'string' } },
          required: ['file_path'],
        })
        expect(body.file_path).toBe('/tmp/test')
      })

      it('generates hostname for field named domain', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: { domain: { type: 'string' } },
          required: ['domain'],
        })
        expect(body.domain).toBe('example.com')
      })

      it('does not false-positive on unrelated field names', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: { culture: { type: 'string' }, formula: { type: 'string' } },
          required: ['culture', 'formula'],
        })
        expect(body.culture).toBe('test')
        expect(body.formula).toBe('test')
      })
    })

    describe('examples field', () => {
      it('uses first example value', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: {
            query: { type: 'string', examples: ['hello world', 'another'] },
          },
          required: ['query'],
        })
        expect(body.query).toBe('hello world')
      })

      it('examples take priority over format', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: {
            site: { type: 'string', format: 'uri', examples: ['https://mysite.dev'] },
          },
          required: ['site'],
        })
        expect(body.site).toBe('https://mysite.dev')
      })
    })

    describe('numeric constraints', () => {
      it('respects minimum', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: { port: { type: 'integer', minimum: 1024 } },
          required: ['port'],
        })
        expect(body.port).toBe(1024)
      })

      it('respects maximum', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: { pct: { type: 'number', maximum: 100 } },
          required: ['pct'],
        })
        expect(body.pct).toBe(100)
      })

      it('picks midpoint for min+max range (integer)', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: { level: { type: 'integer', minimum: 1, maximum: 10 } },
          required: ['level'],
        })
        expect(body.level).toBe(6) // Math.ceil((1+10)/2)
      })

      it('picks midpoint for min+max range (number)', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: { ratio: { type: 'number', minimum: 0, maximum: 1 } },
          required: ['ratio'],
        })
        expect(body.ratio).toBe(0.5)
      })

      it('respects exclusiveMinimum', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: { age: { type: 'integer', exclusiveMinimum: 0 } },
          required: ['age'],
        })
        expect(body.age).toBe(1) // exclusiveMinimum + 1
      })

      it('respects exclusiveMaximum', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: { score: { type: 'integer', exclusiveMaximum: 100 } },
          required: ['score'],
        })
        expect(body.score).toBe(99) // exclusiveMaximum - 1
      })
    })

    describe('string minLength', () => {
      it('pads string to meet minLength', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: { code: { type: 'string', minLength: 8 } },
          required: ['code'],
        })
        expect(body.code).toBe('testxxxx')
        expect((body.code as string).length).toBe(8)
      })

      it('does not pad when minLength <= "test" length', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: { tag: { type: 'string', minLength: 2 } },
          required: ['tag'],
        })
        expect(body.tag).toBe('test')
      })
    })

    describe('array with minItems', () => {
      it('generates items when minItems > 0', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: {
            tags: { type: 'array', minItems: 3, items: { type: 'string' } },
          },
          required: ['tags'],
        })
        expect(body.tags).toEqual(['test', 'test', 'test'])
      })

      it('generates integer items from items schema', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: {
            scores: { type: 'array', minItems: 2, items: { type: 'integer' } },
          },
          required: ['scores'],
        })
        expect(body.scores).toEqual([1, 1])
      })

      it('defaults to string items when items schema missing', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: {
            data: { type: 'array', minItems: 1 },
          },
          required: ['data'],
        })
        expect(body.data).toEqual(['test'])
      })

      it('returns empty array when no minItems', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: {
            optional_list: { type: 'array' },
          },
          required: ['optional_list'],
        })
        expect(body.optional_list).toEqual([])
      })
    })

    describe('priority order', () => {
      it('default > examples > enum > format > name heuristic', async () => {
        // default wins over everything
        const body = await getSentBody({
          type: 'object',
          properties: {
            url: {
              type: 'string',
              format: 'uri',
              examples: ['https://other.dev'],
              enum: ['a', 'b'],
              default: 'my-default',
            },
          },
          required: ['url'],
        })
        expect(body.url).toBe('my-default')
      })

      it('examples win over enum and format', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: {
            url: {
              type: 'string',
              format: 'uri',
              enum: ['a', 'b'],
              examples: ['https://specific.dev'],
            },
          },
          required: ['url'],
        })
        expect(body.url).toBe('https://specific.dev')
      })

      it('enum wins over format', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: {
            url: {
              type: 'string',
              format: 'uri',
              enum: ['https://allowed.com', 'https://other.com'],
            },
          },
          required: ['url'],
        })
        expect(body.url).toBe('https://allowed.com')
      })

      it('format wins over name heuristic', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: {
            // field named 'email' but format says ipv4
            email: { type: 'string', format: 'ipv4' },
          },
          required: ['email'],
        })
        expect(body.email).toBe('192.0.2.1')
      })
    })

    describe('mixed realistic schema', () => {
      it('generates realistic payload for a URL scanner agent', async () => {
        const body = await getSentBody({
          type: 'object',
          properties: {
            target_url: { type: 'string', format: 'uri', description: 'URL to scan' },
            depth: { type: 'integer', minimum: 1, maximum: 5 },
            notify_email: { type: 'string', format: 'email' },
            tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
            verbose: { type: 'boolean' },
          },
          required: ['target_url', 'depth', 'notify_email', 'tags'],
        })
        expect(body).toEqual({
          target_url: 'https://example.com',
          depth: 3, // Math.ceil((1+5)/2)
          notify_email: 'test@example.com',
          tags: ['test'],
        })
      })
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
