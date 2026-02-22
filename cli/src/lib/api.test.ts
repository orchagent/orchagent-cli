/**
 * Tests for API client functions.
 *
 * These tests cover the core API client that all CLI commands depend on:
 * - Request building and authentication
 * - Error parsing
 * - Public vs authenticated requests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { request, publicRequest, ApiError, getOrg, safeFetchWithRetryForCalls, getAgentWithFallback, listMyAgents, resolveWorkspaceIdForOrg } from './api'
import type { ResolvedConfig } from '../types'

// Mock fetch globally
const mockFetch = vi.fn()
global.fetch = mockFetch

describe('ApiError', () => {
  it('includes status code and message', () => {
    const error = new ApiError('Not found', 404)

    expect(error.message).toBe('Not found')
    expect(error.status).toBe(404)
  })

  it('includes optional payload', () => {
    const payload = { error: { code: 'NOT_FOUND' } }
    const error = new ApiError('Not found', 404, payload)

    expect(error.payload).toEqual(payload)
  })
})

describe('request', () => {
  const config: ResolvedConfig = {
    apiKey: 'sk_test_123',
    apiUrl: 'https://api.test.com',
  }

  beforeEach(() => {
    mockFetch.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('adds Authorization header with Bearer token', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: 'test' }),
    })

    await request(config, 'GET', '/test')

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.test.com/test',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk_test_123',
        }),
      })
    )
  })

  it('returns parsed JSON response', async () => {
    const responseData = { org: 'test', slug: 'test-org' }
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(responseData),
    })

    const result = await request(config, 'GET', '/org')

    expect(result).toEqual(responseData)
  })

  it('throws ApiError when response not ok', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: () => Promise.resolve(JSON.stringify({
        error: { message: 'Agent not found' }
      })),
    })

    await expect(request(config, 'GET', '/agents/missing'))
      .rejects.toThrow(ApiError)
  })

  it('throws ApiError with 401 when no API key', async () => {
    const noKeyConfig: ResolvedConfig = {
      apiKey: undefined,
      apiUrl: 'https://api.test.com',
    }

    await expect(request(noKeyConfig, 'GET', '/test'))
      .rejects.toThrow('Missing API key')
  })

  it('parses error message from JSON response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: () => Promise.resolve(JSON.stringify({
        error: { message: 'Access denied to private agent' }
      })),
    })

    try {
      await request(config, 'GET', '/agents/private')
      expect.fail('Should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      expect((error as ApiError).message).toBe('Access denied to private agent')
      expect((error as ApiError).status).toBe(403)
    }
  })

  it('uses statusText when no JSON message', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: () => Promise.resolve('not json'),
    })

    try {
      await request(config, 'GET', '/broken')
      expect.fail('Should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      expect((error as ApiError).message).toBe('Internal Server Error')
    }
  })

  it('includes custom headers', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}),
    })

    await request(config, 'POST', '/agents', {
      body: JSON.stringify({ name: 'test' }),
      headers: { 'Content-Type': 'application/json' },
    })

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer sk_test_123',
        }),
      })
    )
  })

  it('strips trailing slash from API URL', async () => {
    const configWithSlash: ResolvedConfig = {
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com/',
    }

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}),
    })

    await request(configWithSlash, 'GET', '/test')

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.test.com/test',
      expect.any(Object)
    )
  })
})

describe('publicRequest', () => {
  const config: ResolvedConfig = {
    apiUrl: 'https://api.test.com',
  }

  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('makes unauthenticated request', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    })

    await publicRequest(config, '/public/agents')

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.test.com/public/agents',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      })
    )
  })

  it('returns parsed JSON', async () => {
    const agents = [{ name: 'agent1' }, { name: 'agent2' }]
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(agents),
    })

    const result = await publicRequest(config, '/public/agents')

    expect(result).toEqual(agents)
  })

  it('throws ApiError on failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: () => Promise.resolve('{}'),
    })

    await expect(publicRequest(config, '/public/agents/missing'))
      .rejects.toThrow(ApiError)
  })
})

describe('getOrg', () => {
  const config: ResolvedConfig = {
    apiKey: 'sk_test_123',
    apiUrl: 'https://api.test.com',
  }

  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('calls GET /org endpoint', async () => {
    const orgData = { id: '123', slug: 'test-org', name: 'Test Org' }
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(orgData),
    })

    const result = await getOrg(config)

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.test.com/org',
      expect.objectContaining({ method: 'GET' })
    )
    expect(result).toEqual(orgData)
  })
})

describe('safeFetchWithRetryForCalls', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    // Suppress retry messages
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not retry when is_retryable is false', async () => {
    const errorBody = JSON.stringify({
      error: {
        code: 'SANDBOX_ERROR',
        message: 'Code execution failed with exit code 1: ModuleNotFoundError',
        is_retryable: false,
      },
      metadata: { request_id: 'req_test123' },
    })
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: () => Promise.resolve(errorBody),
      headers: new Headers(),
    })

    const response = await safeFetchWithRetryForCalls('https://api.test.com/run')

    // Should only call fetch once — no retries
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(500)

    // Response body should be preserved
    const text = await response.text()
    const parsed = JSON.parse(text)
    expect(parsed.error.code).toBe('SANDBOX_ERROR')
    expect(parsed.error.is_retryable).toBe(false)
  })

  it('retries when is_retryable is true', async () => {
    const errorBody = JSON.stringify({
      error: {
        code: 'SANDBOX_TIMEOUT',
        message: 'Execution timed out',
        is_retryable: true,
      },
    })
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 504,
        statusText: 'Gateway Timeout',
        text: () => Promise.resolve(errorBody),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: 'success' }),
      })

    const response = await safeFetchWithRetryForCalls('https://api.test.com/run')

    // Should retry and succeed on second attempt
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(response.ok).toBe(true)
  })

  it('retries when is_retryable is not present (backward compat)', async () => {
    // Old gateway versions don't include is_retryable
    const errorBody = JSON.stringify({
      error: { message: 'Something failed' },
    })
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: () => Promise.resolve(errorBody),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: 'success' }),
      })

    const response = await safeFetchWithRetryForCalls('https://api.test.com/run')

    // Should still retry (default behavior)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(response.ok).toBe(true)
  })

  it('does not include error detail in retry messages (BUG-4)', async () => {
    // BUG-4: retry messages included error detail (e.g. "Request failed (500: Internal error)")
    // which duplicated the error text that appears in the final CliError message.
    const errorBody = JSON.stringify({
      error: { message: 'Agent execution failed: ModuleNotFoundError' },
    })
    const stderrSpy = vi.spyOn(process.stderr, 'write')

    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: () => Promise.resolve(errorBody),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: () => Promise.resolve(errorBody),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: () => Promise.resolve(errorBody),
        headers: new Headers(),
      })

    const response = await safeFetchWithRetryForCalls('https://api.test.com/run')
    expect(response.status).toBe(500)

    // Retry messages should NOT contain the error detail text
    const retryMessages = stderrSpy.mock.calls
      .map(c => String(c[0]))
      .filter(m => m.includes('retrying'))
    expect(retryMessages.length).toBeGreaterThan(0)
    for (const msg of retryMessages) {
      expect(msg).not.toContain('Agent execution failed')
      expect(msg).not.toContain('ModuleNotFoundError')
      // Should still contain the status code
      expect(msg).toContain('500')
    }
  })
})

describe('resolveWorkspaceIdForOrg', () => {
  const config: ResolvedConfig = {
    apiKey: 'sk_test_123',
    apiUrl: 'https://api.test.com',
  }

  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('returns workspace ID when org slug matches', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        workspaces: [
          { id: 'ws-123', slug: 'team-org' },
          { id: 'ws-456', slug: 'other-org' },
        ],
      }),
    })

    const result = await resolveWorkspaceIdForOrg(config, 'team-org')
    expect(result).toBe('ws-123')
  })

  it('returns undefined when org slug not found in workspaces', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        workspaces: [{ id: 'ws-123', slug: 'other-org' }],
      }),
    })

    const result = await resolveWorkspaceIdForOrg(config, 'personal-org')
    expect(result).toBeUndefined()
  })

  it('returns undefined when not authenticated', async () => {
    const noKeyConfig: ResolvedConfig = {
      apiUrl: 'https://api.test.com',
    }

    const result = await resolveWorkspaceIdForOrg(noKeyConfig, 'team-org')
    expect(result).toBeUndefined()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns undefined on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'))

    const result = await resolveWorkspaceIdForOrg(config, 'team-org')
    expect(result).toBeUndefined()
  })
})

describe('listMyAgents with workspaceId', () => {
  const config: ResolvedConfig = {
    apiKey: 'sk_test_123',
    apiUrl: 'https://api.test.com',
  }

  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('sends X-Workspace-Id header when workspaceId provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    })

    await listMyAgents(config, 'ws-123')

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.test.com/agents',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Workspace-Id': 'ws-123',
        }),
      })
    )
  })

  it('does not send X-Workspace-Id when workspaceId not provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    })

    await listMyAgents(config)

    const callHeaders = mockFetch.mock.calls[0][1].headers
    expect(callHeaders['X-Workspace-Id']).toBeUndefined()
  })
})

describe('getAgentWithFallback with workspaceId', () => {
  const config: ResolvedConfig = {
    apiKey: 'sk_test_123',
    apiUrl: 'https://api.test.com',
  }

  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('passes workspaceId to getOrg and getMyAgent on fallback', async () => {
    // First call: getPublicAgent returns 404
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: () => Promise.resolve('{}'),
    })
    // Second call: getOrg with workspace header
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: 'org-123', slug: 'team-org' }),
    })
    // Third call: listMyAgents with workspace header
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([
        { id: 'agent-1', name: 'my-agent', version: 'v1', created_at: '2026-01-01' },
      ]),
    })

    const result = await getAgentWithFallback(config, 'team-org', 'my-agent', 'v1', 'ws-123')

    expect(result).toEqual(expect.objectContaining({ name: 'my-agent' }))

    // Verify getOrg was called with X-Workspace-Id
    const getOrgCall = mockFetch.mock.calls[1]
    expect(getOrgCall[1].headers['X-Workspace-Id']).toBe('ws-123')

    // Verify listMyAgents was called with X-Workspace-Id
    const listAgentsCall = mockFetch.mock.calls[2]
    expect(listAgentsCall[1].headers['X-Workspace-Id']).toBe('ws-123')
  })

  it('returns public agent when available (no workspace needed)', async () => {
    const publicAgent = { id: 'pub-1', name: 'public-agent', version: 'v1', is_public: true }
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(publicAgent),
    })

    const result = await getAgentWithFallback(config, 'any-org', 'public-agent', 'v1', 'ws-123')

    expect(result).toEqual(publicAgent)
    // Only one fetch call (public endpoint)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})
