import { describe, it, expect, vi } from 'vitest'

import {
  getAgentCostEstimate,
  getAgentWithFallback,
  resolveWorkspaceIdForOrg,
} from '../../lib/api'
import type { ResolvedConfig } from '../../types'

const CONFIG: ResolvedConfig = {
  apiKey: 'sk_test_123',
  apiUrl: 'https://api.test.com',
  defaultOrg: 'acme',
}

describe('workspace resolution matrix (CLI core helpers)', () => {
  it('resolveWorkspaceIdForOrg returns matching workspace ID', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ workspaces: [{ id: 'ws-1', slug: 'acme' }, { id: 'ws-2', slug: 'team' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )

    vi.stubGlobal('fetch', fetchMock)
    const ws = await resolveWorkspaceIdForOrg(CONFIG, 'team')
    expect(ws).toBe('ws-2')
    vi.unstubAllGlobals()
  })

  it('cost estimate uses authenticated request in workspace context', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ agent: 'acme/tool@latest', type: 'tool', execution_engine: 'code_runtime', supported_providers: ['any'], estimate: { sample_size: 0 }, metadata: { request_id: 'r1' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )

    vi.stubGlobal('fetch', fetchMock)
    await getAgentCostEstimate(CONFIG, 'acme', 'tool', 'latest', 'ws-team')

    const [, options] = fetchMock.mock.calls[0]
    expect(options.headers.Authorization).toBe('Bearer sk_test_123')
    expect(options.headers['X-Workspace-Id']).toBe('ws-team')
    vi.unstubAllGlobals()
  })

  it('agent fallback returns own private agent when public endpoint 404s', async () => {
    const fetchMock = vi.fn()
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ slug: 'acme' }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 'a1', name: 'private-agent', version: 'v3', created_at: '2026-02-20T00:00:00Z', org_slug: 'acme' }]), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    vi.stubGlobal('fetch', fetchMock)

    const agent = await getAgentWithFallback(CONFIG, 'acme', 'private-agent', 'latest', 'ws-1')
    expect(agent).toMatchObject({ name: 'private-agent', version: 'v3' })

    vi.unstubAllGlobals()
  })
})
