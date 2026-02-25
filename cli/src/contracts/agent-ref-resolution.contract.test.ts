import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { parseAgentRef } from '../lib/agent-ref'
import { getAgentCostEstimate, downloadCodeBundleAuthenticated } from '../lib/api'
import type { ResolvedConfig } from '../types'

const CONFIG: ResolvedConfig = {
  apiKey: 'sk_test_123',
  apiUrl: 'https://api.test.com',
  defaultOrg: 'acme',
}

describe('agent-ref resolution contract', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('parses org/agent@version refs', () => {
    expect(parseAgentRef('acme/security@v2')).toEqual({ org: 'acme', agent: 'security', version: 'v2' })
  })

  it('defaults to latest when version omitted', () => {
    expect(parseAgentRef('acme/security')).toEqual({ org: 'acme', agent: 'security', version: 'latest' })
    expect(parseAgentRef('security')).toEqual({ org: undefined, agent: 'security', version: 'latest' })
  })

  it('uses authenticated request + workspace header for cost estimate when workspace is resolved', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ agent: 'acme/security@latest', type: 'agent', execution_engine: 'managed_loop', supported_providers: ['any'], estimate: { sample_size: 0 }, metadata: { request_id: 'r1' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )

    await getAgentCostEstimate(CONFIG, 'acme', 'security', 'latest', 'ws-team-1')

    const [url, options] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/public/agents/acme/security/latest/cost-estimate')
    expect(options.headers.Authorization).toBe('Bearer sk_test_123')
    expect(options.headers['X-Workspace-Id']).toBe('ws-team-1')
  })

  it('sends workspace header for authenticated bundle downloads', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([80, 75, 3, 4]), { status: 200 })
    )

    await downloadCodeBundleAuthenticated(CONFIG, 'agent-id-1', 'ws-team-2')

    const [, options] = fetchMock.mock.calls[0]
    expect(options.headers.Authorization).toBe('Bearer sk_test_123')
    expect(options.headers['X-Workspace-Id']).toBe('ws-team-2')
  })
})
