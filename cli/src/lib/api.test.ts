/**
 * Tests for API client functions.
 *
 * These tests cover the core API client that all CLI commands depend on:
 * - Request building and authentication
 * - Error parsing
 * - Public vs authenticated requests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { request, publicRequest, ApiError, getOrg, safeFetchWithRetryForCalls } from './api'
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
})

