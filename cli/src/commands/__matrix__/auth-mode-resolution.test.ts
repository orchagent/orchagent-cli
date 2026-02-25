import { describe, it, expect, vi } from 'vitest'

import { resolveWorkspaceIdForOrg, getAgentCostEstimate } from '../../lib/api'
import type { ResolvedConfig } from '../../types'

const AUTHED: ResolvedConfig = {
  apiKey: 'sk_test_123',
  apiUrl: 'https://api.test.com',
  defaultOrg: 'acme',
}

const UNAUTHED: ResolvedConfig = {
  apiKey: undefined,
  apiUrl: 'https://api.test.com',
  defaultOrg: 'acme',
}

describe('auth-mode resolution matrix', () => {
  it('returns undefined workspace id for unauthenticated callers', async () => {
    const ws = await resolveWorkspaceIdForOrg(UNAUTHED, 'team')
    expect(ws).toBeUndefined()
  })

  it('uses public endpoint (no auth header) when unauthenticated', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ agent: 'acme/scanner@latest', type: 'agent', execution_engine: 'managed_loop', supported_providers: ['any'], estimate: { sample_size: 0 }, metadata: { request_id: 'r' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )

    vi.stubGlobal('fetch', fetchMock)
    await getAgentCostEstimate(UNAUTHED, 'acme', 'scanner', 'latest', undefined)

    const [, options] = fetchMock.mock.calls[0]
    expect(options.headers.Authorization).toBeUndefined()
    expect(options.headers['X-Workspace-Id']).toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('falls back to public request when workspaceId is present but caller is unauthenticated', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ agent: 'acme/scanner@latest', type: 'agent', execution_engine: 'managed_loop', supported_providers: ['any'], estimate: { sample_size: 0 }, metadata: { request_id: 'r' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    await getAgentCostEstimate({ ...UNAUTHED, apiKey: undefined }, 'acme', 'scanner', 'latest', 'ws-team')

    const [, options] = fetchMock.mock.calls[0]
    expect(options.headers.Authorization).toBeUndefined()
    expect(options.headers['X-Workspace-Id']).toBeUndefined()

    vi.unstubAllGlobals()
  })

  it('sends auth + workspace headers when both are available', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ agent: 'acme/scanner@latest', type: 'agent', execution_engine: 'managed_loop', supported_providers: ['any'], estimate: { sample_size: 0 }, metadata: { request_id: 'r' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )

    vi.stubGlobal('fetch', fetchMock)
    await getAgentCostEstimate(AUTHED, 'acme', 'scanner', 'latest', 'ws-team')

    const [, options] = fetchMock.mock.calls[0]
    expect(options.headers.Authorization).toBe('Bearer sk_test_123')
    expect(options.headers['X-Workspace-Id']).toBe('ws-team')
    vi.unstubAllGlobals()
  })
})
