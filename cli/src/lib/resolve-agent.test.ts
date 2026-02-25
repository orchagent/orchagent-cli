import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolveAgentContext, resolveOrg } from './resolve-agent'
import { parseAgentRef } from './agent-ref'
import type { ResolvedConfig } from '../types'

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('./config', () => ({
  loadConfig: vi.fn(),
}))

vi.mock('./api', () => ({
  resolveWorkspaceIdForOrg: vi.fn(),
}))

import { loadConfig } from './config'
import { resolveWorkspaceIdForOrg } from './api'

const mockLoadConfig = vi.mocked(loadConfig)
const mockResolveWorkspaceId = vi.mocked(resolveWorkspaceIdForOrg)

// ─── Fixtures ───────────────────────────────────────────────────────────────

const BASE_CONFIG: ResolvedConfig = {
  apiKey: 'sk_test_key',
  apiUrl: 'https://api.test.com',
  defaultOrg: 'default-org',
}

const CONFIG_NO_ORG: ResolvedConfig = {
  apiKey: 'sk_test_key',
  apiUrl: 'https://api.test.com',
  defaultOrg: undefined,
}

const CONFIG_NO_KEY: ResolvedConfig = {
  apiUrl: 'https://api.test.com',
  defaultOrg: 'default-org',
}

// ─── resolveOrg ─────────────────────────────────────────────────────────────

describe('resolveOrg', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadConfig.mockResolvedValue({})
  })

  it('uses org from parsed ref when provided', async () => {
    const parsed = parseAgentRef('acme/my-agent@v2')
    const org = await resolveOrg(parsed, BASE_CONFIG)
    expect(org).toBe('acme')
    // Should NOT call loadConfig since org was in ref
    expect(mockLoadConfig).not.toHaveBeenCalled()
  })

  it('falls back to configFile.workspace when ref has no org', async () => {
    mockLoadConfig.mockResolvedValue({ workspace: 'team-workspace' })
    const parsed = parseAgentRef('my-agent')
    const org = await resolveOrg(parsed, BASE_CONFIG)
    expect(org).toBe('team-workspace')
  })

  it('falls back to config.defaultOrg when ref has no org and no workspace', async () => {
    mockLoadConfig.mockResolvedValue({})
    const parsed = parseAgentRef('my-agent')
    const org = await resolveOrg(parsed, BASE_CONFIG)
    expect(org).toBe('default-org')
  })

  it('throws CliError when no org can be resolved', async () => {
    mockLoadConfig.mockResolvedValue({})
    const parsed = parseAgentRef('my-agent')
    await expect(resolveOrg(parsed, CONFIG_NO_ORG)).rejects.toThrow(
      'Missing org. Use org/agent format or set default org.'
    )
  })

  it('uses custom error message when provided', async () => {
    mockLoadConfig.mockResolvedValue({})
    const parsed = parseAgentRef('my-agent')
    await expect(
      resolveOrg(parsed, CONFIG_NO_ORG, { missingOrgMessage: 'Custom error' })
    ).rejects.toThrow('Custom error')
  })

  it('prefers configFile.workspace over config.defaultOrg', async () => {
    mockLoadConfig.mockResolvedValue({ workspace: 'ws-org' })
    const parsed = parseAgentRef('my-agent')
    const org = await resolveOrg(parsed, BASE_CONFIG)
    expect(org).toBe('ws-org')
  })
})

// ─── resolveAgentContext ────────────────────────────────────────────────────

describe('resolveAgentContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadConfig.mockResolvedValue({})
    mockResolveWorkspaceId.mockResolvedValue(undefined)
  })

  // --- Parsing correctness ---

  it('resolves full org/agent@version ref', async () => {
    const ctx = await resolveAgentContext('acme/security@v2', BASE_CONFIG)
    expect(ctx).toEqual({
      org: 'acme',
      agent: 'security',
      version: 'v2',
      workspaceId: undefined,
    })
  })

  it('resolves org/agent ref (defaults to latest)', async () => {
    const ctx = await resolveAgentContext('acme/scanner', BASE_CONFIG)
    expect(ctx).toEqual({
      org: 'acme',
      agent: 'scanner',
      version: 'latest',
      workspaceId: undefined,
    })
  })

  it('resolves agent-only ref using defaultOrg', async () => {
    const ctx = await resolveAgentContext('my-agent', BASE_CONFIG)
    expect(ctx).toEqual({
      org: 'default-org',
      agent: 'my-agent',
      version: 'latest',
      workspaceId: undefined,
    })
  })

  it('resolves agent@version ref using defaultOrg', async () => {
    const ctx = await resolveAgentContext('my-agent@v3', BASE_CONFIG)
    expect(ctx).toEqual({
      org: 'default-org',
      agent: 'my-agent',
      version: 'v3',
      workspaceId: undefined,
    })
  })

  // --- Org fallback chain ---

  it('uses configFile.workspace when ref has no org', async () => {
    mockLoadConfig.mockResolvedValue({ workspace: 'team-ws' })
    const ctx = await resolveAgentContext('my-agent', CONFIG_NO_ORG)
    expect(ctx.org).toBe('team-ws')
  })

  it('throws when no org can be resolved', async () => {
    mockLoadConfig.mockResolvedValue({})
    await expect(resolveAgentContext('my-agent', CONFIG_NO_ORG)).rejects.toThrow(
      'Missing org'
    )
  })

  it('uses custom missingOrgMessage', async () => {
    mockLoadConfig.mockResolvedValue({})
    await expect(
      resolveAgentContext('my-agent', CONFIG_NO_ORG, {
        missingOrgMessage: 'Set default-org first',
      })
    ).rejects.toThrow('Set default-org first')
  })

  // --- Workspace resolution ---

  it('resolves workspace ID for team orgs', async () => {
    mockResolveWorkspaceId.mockResolvedValue('ws-team-123')
    const ctx = await resolveAgentContext('team-org/agent@v1', BASE_CONFIG)
    expect(ctx.workspaceId).toBe('ws-team-123')
    expect(mockResolveWorkspaceId).toHaveBeenCalledWith(BASE_CONFIG, 'team-org')
  })

  it('returns undefined workspaceId for personal orgs', async () => {
    mockResolveWorkspaceId.mockResolvedValue(undefined)
    const ctx = await resolveAgentContext('personal/agent', BASE_CONFIG)
    expect(ctx.workspaceId).toBeUndefined()
  })

  it('skips workspace resolution when option set', async () => {
    const ctx = await resolveAgentContext('acme/agent@v1', BASE_CONFIG, {
      skipWorkspaceResolution: true,
    })
    expect(ctx.workspaceId).toBeUndefined()
    expect(mockResolveWorkspaceId).not.toHaveBeenCalled()
  })

  it('resolves workspace from defaultOrg when ref has no org', async () => {
    mockResolveWorkspaceId.mockResolvedValue('ws-default')
    const ctx = await resolveAgentContext('my-agent', BASE_CONFIG)
    expect(mockResolveWorkspaceId).toHaveBeenCalledWith(BASE_CONFIG, 'default-org')
    expect(ctx.workspaceId).toBe('ws-default')
  })

  // --- Unauthenticated ---

  it('returns undefined workspaceId when unauthenticated', async () => {
    mockResolveWorkspaceId.mockResolvedValue(undefined)
    const ctx = await resolveAgentContext('acme/agent', CONFIG_NO_KEY)
    expect(ctx.workspaceId).toBeUndefined()
  })

  // --- Invalid refs ---

  it('throws on too many segments', async () => {
    await expect(resolveAgentContext('a/b/c', BASE_CONFIG)).rejects.toThrow(
      'Invalid agent reference'
    )
  })

  it('throws on empty string segments', async () => {
    // parseAgentRef will return empty strings as agent name; this tests integration
    const ctx = await resolveAgentContext('acme/@v1', BASE_CONFIG)
    expect(ctx.agent).toBe('')
    expect(ctx.version).toBe('v1')
  })

  // --- Integration: workspace from config fallback with team workspace ---

  it('resolves workspace for org resolved from config workspace', async () => {
    mockLoadConfig.mockResolvedValue({ workspace: 'team-slug' })
    mockResolveWorkspaceId.mockResolvedValue('ws-team-456')
    const ctx = await resolveAgentContext('my-agent@v2', CONFIG_NO_ORG)
    expect(ctx.org).toBe('team-slug')
    expect(ctx.workspaceId).toBe('ws-team-456')
    expect(mockResolveWorkspaceId).toHaveBeenCalledWith(CONFIG_NO_ORG, 'team-slug')
  })
})
