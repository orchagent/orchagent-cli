import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { request, publicRequest, ApiError } from '../lib/api'
import type { ResolvedConfig } from '../types'

const CONFIG: ResolvedConfig = {
  apiKey: 'sk_test_123',
  apiUrl: 'https://api.test.com',
  defaultOrg: 'acme',
}

describe('error semantics contract', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('maps API error payloads into ApiError with status + message', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { message: "Agent 'acme/missing@latest' not found" } }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      )
    )

    await expect(request(CONFIG, 'GET', '/agents/acme/missing/latest')).rejects.toMatchObject<ApiError>({
      status: 404,
      message: "Agent 'acme/missing@latest' not found",
    })
  })

  it('preserves 403 semantics for public endpoints', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { message: 'Forbidden' } }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      )
    )

    await expect(publicRequest(CONFIG, '/public/agents/private-org/agent/latest')).rejects.toMatchObject<ApiError>({
      status: 403,
      message: 'Forbidden',
    })
  })

  it('throws 401 when authenticated requests are attempted without api key', async () => {
    const noAuthConfig: ResolvedConfig = { ...CONFIG, apiKey: undefined }

    await expect(request(noAuthConfig, 'GET', '/agents')).rejects.toMatchObject<ApiError>({
      status: 401,
    })
  })
})
