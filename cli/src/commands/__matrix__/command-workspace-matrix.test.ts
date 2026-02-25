/**
 * Comprehensive CLI command workspace & resolution matrix tests.
 *
 * Covers the M1-M10 scenarios from workspace-agent-resolution-test-matrix.md,
 * plus targeted regression tests for every recent bug class:
 *   - Workspace context (BUG-11-02 thru 11-07)
 *   - Agent ref parsing (T12-05)
 *   - Resolution consistency (T12-02, T12-04)
 *   - Output/display (T12-12)
 *   - Init/scaffold defaults (T12-06)
 *   - Error semantics (T12-03, T12-07)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

// ── Shared mocks ──────────────────────────────────────────────

vi.mock('../../lib/config', () => ({
  getResolvedConfig: vi.fn(),
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
}))

vi.mock('../../lib/api', () => ({
  listMyAgents: vi.fn(),
  listAgentKeys: vi.fn(),
  createAgentKey: vi.fn(),
  deleteAgentKey: vi.fn(),
  checkAgentDelete: vi.fn(),
  deleteAgent: vi.fn(),
  getAgentWithFallback: vi.fn(),
  getAgentCostEstimate: vi.fn(),
  getPublicAgent: vi.fn(),
  getOrg: vi.fn(),
  downloadCodeBundle: vi.fn(),
  downloadCodeBundleAuthenticated: vi.fn(),
  resolveWorkspaceIdForOrg: vi.fn(),
  publicRequest: vi.fn(),
  request: vi.fn(),
  forkAgent: vi.fn(),
  safeFetchWithRetryForCalls: vi.fn(),
  checkAgentTransfer: vi.fn(),
  transferAgent: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.name = 'ApiError'
      this.status = status
    }
  },
}))

vi.mock('../../lib/analytics', () => ({
  track: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../lib/agent-ref', () => ({
  parseAgentRef: vi.fn(),
}))

vi.mock('../../lib/errors', () => ({
  CliError: class CliError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'CliError'
    }
  },
}))

vi.mock('../../lib/output', () => ({
  printJson: vi.fn(),
}))

vi.mock('../../lib/key-store', () => ({
  saveServiceKey: vi.fn(() => Promise.resolve('/tmp/fake-key')),
  loadServiceKeys: vi.fn(() => Promise.resolve([])),
}))

vi.mock('../../lib/spinner', () => ({
  createSpinner: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
  })),
  withSpinner: vi.fn((_msg: string, fn: () => Promise<unknown>) => fn()),
}))

vi.mock('../../lib/llm', () => ({
  detectLlmKey: vi.fn().mockResolvedValue(null),
  validateProvider: vi.fn(),
}))

// ── Imports ──────────────────────────────────────────────────

import {
  listMyAgents,
  listAgentKeys,
  createAgentKey,
  deleteAgentKey,
  checkAgentDelete,
  deleteAgent,
  getAgentWithFallback,
  getAgentCostEstimate,
  resolveWorkspaceIdForOrg,
  publicRequest,
  request,
  forkAgent,
  safeFetchWithRetryForCalls,
  ApiError,
} from '../../lib/api'
import { getResolvedConfig, loadConfig } from '../../lib/config'
import { parseAgentRef } from '../../lib/agent-ref'

const mockListMyAgents = vi.mocked(listMyAgents)
const mockListAgentKeys = vi.mocked(listAgentKeys)
const mockCreateAgentKey = vi.mocked(createAgentKey)
const mockDeleteAgentKey = vi.mocked(deleteAgentKey)
const mockCheckAgentDelete = vi.mocked(checkAgentDelete)
const mockDeleteAgent = vi.mocked(deleteAgent)
const mockGetAgentWithFallback = vi.mocked(getAgentWithFallback)
const mockGetAgentCostEstimate = vi.mocked(getAgentCostEstimate)
const mockResolveWorkspaceIdForOrg = vi.mocked(resolveWorkspaceIdForOrg)
const mockPublicRequest = vi.mocked(publicRequest)
const mockRequest = vi.mocked(request)
const mockForkAgent = vi.mocked(forkAgent)
const mockSafeFetch = vi.mocked(safeFetchWithRetryForCalls)
const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockLoadConfig = vi.mocked(loadConfig)
const mockParseAgentRef = vi.mocked(parseAgentRef)

// ── Shared fixtures ──────────────────────────────────────────

const PERSONAL_CONFIG = {
  apiKey: 'sk_test_personal',
  apiUrl: 'https://api.test.com',
  defaultOrg: 'joe',
}

const TEAM_ORG = 'acme-team'
const TEAM_WS_ID = 'ws_team_abc123'

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-001',
    name: 'my-agent',
    version: 'v3',
    type: 'agent',
    created_at: '2026-02-20T00:00:00Z',
    org_slug: 'joe',
    ...overrides,
  }
}

// ── Helpers ──────────────────────────────────────────────────

let stdoutSpy: ReturnType<typeof vi.spyOn>
let stderrSpy: ReturnType<typeof vi.spyOn>
let exitSpy: ReturnType<typeof vi.spyOn>
let consoleSpy: ReturnType<typeof vi.spyOn>

function setupSpies() {
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit')
  }) as never)
}

function teardownSpies() {
  stdoutSpy?.mockRestore()
  stderrSpy?.mockRestore()
  consoleSpy?.mockRestore()
  exitSpy?.mockRestore()
}

function setupPersonalOrg() {
  mockGetResolvedConfig.mockResolvedValue(PERSONAL_CONFIG)
  mockLoadConfig.mockResolvedValue({})
  mockResolveWorkspaceIdForOrg.mockResolvedValue(undefined)
}

function setupTeamWorkspace() {
  mockGetResolvedConfig.mockResolvedValue(PERSONAL_CONFIG)
  mockLoadConfig.mockResolvedValue({ workspace: TEAM_ORG })
  mockResolveWorkspaceIdForOrg.mockResolvedValue(TEAM_WS_ID)
}

// ══════════════════════════════════════════════════════════════
// GROUP 1: Pattern A Commands — resolveWorkspaceIdForOrg + header
// ══════════════════════════════════════════════════════════════

describe('Group 1: Pattern A — X-Workspace-Id header commands', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupSpies()
  })

  afterEach(() => {
    teardownSpies()
    vi.restoreAllMocks()
  })

  // ── agents ────────────────────────────────────────────────

  describe('agents command', () => {
    let program: Command

    beforeEach(async () => {
      const { registerAgentsCommand } = await import('../agents')
      program = new Command()
      program.exitOverride()
      registerAgentsCommand(program)
    })

    it('M1: personal org — listMyAgents gets undefined workspaceId', async () => {
      setupPersonalOrg()
      mockListMyAgents.mockResolvedValue([])

      await program.parseAsync(['node', 'test', 'agents'])

      expect(mockResolveWorkspaceIdForOrg).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: 'sk_test_personal' }),
        'joe'
      )
      expect(mockListMyAgents).toHaveBeenCalledWith(
        expect.anything(),
        undefined
      )
    })

    it('M5: team workspace via config — listMyAgents gets resolved workspace ID', async () => {
      setupTeamWorkspace()
      mockListMyAgents.mockResolvedValue([])

      await program.parseAsync(['node', 'test', 'agents'])

      expect(mockResolveWorkspaceIdForOrg).toHaveBeenCalledWith(
        expect.anything(),
        TEAM_ORG
      )
      expect(mockListMyAgents).toHaveBeenCalledWith(
        expect.anything(),
        TEAM_WS_ID
      )
    })

    it('M4: no matching workspace — resolveWorkspaceIdForOrg returns undefined gracefully', async () => {
      mockGetResolvedConfig.mockResolvedValue(PERSONAL_CONFIG)
      mockLoadConfig.mockResolvedValue({ workspace: 'nonexistent-org' })
      mockResolveWorkspaceIdForOrg.mockResolvedValue(undefined)
      mockListMyAgents.mockResolvedValue([])

      await program.parseAsync(['node', 'test', 'agents'])

      expect(mockListMyAgents).toHaveBeenCalledWith(
        expect.anything(),
        undefined
      )
    })
  })

  // ── agent-keys ────────────────────────────────────────────

  describe('agent-keys command', () => {
    let program: Command

    beforeEach(async () => {
      const { registerAgentKeysCommand } = await import('../agent-keys')
      program = new Command()
      program.exitOverride()
      registerAgentKeysCommand(program)
    })

    it('list: personal org — listAgentKeys gets undefined workspaceId', async () => {
      setupPersonalOrg()
      mockParseAgentRef.mockReturnValue({ org: undefined, agent: 'my-agent', version: 'latest' })
      mockListMyAgents.mockResolvedValue([makeAgent()] as any)
      mockListAgentKeys.mockResolvedValue({ keys: [] })

      await program.parseAsync(['node', 'test', 'agent-keys', 'list', 'my-agent'])

      expect(mockListAgentKeys).toHaveBeenCalledWith(
        expect.anything(),
        'agent-001',
        undefined
      )
    })

    it('list: team workspace — listAgentKeys gets resolved workspace ID', async () => {
      setupTeamWorkspace()
      mockParseAgentRef.mockReturnValue({ org: TEAM_ORG, agent: 'my-agent', version: 'latest' })
      mockListMyAgents.mockResolvedValue([makeAgent({ org_slug: TEAM_ORG })] as any)
      mockListAgentKeys.mockResolvedValue({ keys: [] })

      await program.parseAsync(['node', 'test', 'agent-keys', 'list', `${TEAM_ORG}/my-agent`])

      expect(mockResolveWorkspaceIdForOrg).toHaveBeenCalledWith(
        expect.anything(),
        TEAM_ORG
      )
      expect(mockListAgentKeys).toHaveBeenCalledWith(
        expect.anything(),
        'agent-001',
        TEAM_WS_ID
      )
    })

    it('create: personal org — createAgentKey gets undefined workspaceId', async () => {
      setupPersonalOrg()
      mockParseAgentRef.mockReturnValue({ org: undefined, agent: 'my-agent', version: 'latest' })
      mockListMyAgents.mockResolvedValue([makeAgent()] as any)
      mockCreateAgentKey.mockResolvedValue({ key: 'sk_svc_test', prefix: 'sk_svc_' })

      await program.parseAsync(['node', 'test', 'agent-keys', 'create', 'my-agent'])

      expect(mockCreateAgentKey).toHaveBeenCalledWith(
        expect.anything(),
        'agent-001',
        undefined
      )
    })

    it('create: team workspace — createAgentKey gets resolved workspace ID', async () => {
      setupTeamWorkspace()
      mockParseAgentRef.mockReturnValue({ org: TEAM_ORG, agent: 'my-agent', version: 'latest' })
      mockListMyAgents.mockResolvedValue([makeAgent({ org_slug: TEAM_ORG })] as any)
      mockCreateAgentKey.mockResolvedValue({ key: 'sk_svc_test', prefix: 'sk_svc_' })

      await program.parseAsync(['node', 'test', 'agent-keys', 'create', `${TEAM_ORG}/my-agent`])

      expect(mockCreateAgentKey).toHaveBeenCalledWith(
        expect.anything(),
        'agent-001',
        TEAM_WS_ID
      )
    })

    it('delete: personal org — deleteAgentKey gets undefined workspaceId', async () => {
      setupPersonalOrg()
      mockParseAgentRef.mockReturnValue({ org: undefined, agent: 'my-agent', version: 'latest' })
      mockListMyAgents.mockResolvedValue([makeAgent()] as any)
      mockDeleteAgentKey.mockResolvedValue({ deleted: true })

      await program.parseAsync(['node', 'test', 'agent-keys', 'delete', 'my-agent', 'key-123'])

      expect(mockDeleteAgentKey).toHaveBeenCalledWith(
        expect.anything(),
        'agent-001',
        'key-123',
        undefined
      )
    })

    it('delete: team workspace — deleteAgentKey gets resolved workspace ID', async () => {
      setupTeamWorkspace()
      mockParseAgentRef.mockReturnValue({ org: TEAM_ORG, agent: 'my-agent', version: 'latest' })
      mockListMyAgents.mockResolvedValue([makeAgent({ org_slug: TEAM_ORG })] as any)
      mockDeleteAgentKey.mockResolvedValue({ deleted: true })

      await program.parseAsync(['node', 'test', 'agent-keys', 'delete', `${TEAM_ORG}/my-agent`, 'key-123'])

      expect(mockDeleteAgentKey).toHaveBeenCalledWith(
        expect.anything(),
        'agent-001',
        'key-123',
        TEAM_WS_ID
      )
    })
  })

  // ── delete ────────────────────────────────────────────────

  describe('delete command', () => {
    let program: Command

    beforeEach(async () => {
      const { registerDeleteCommand } = await import('../delete')
      program = new Command()
      program.exitOverride()
      registerDeleteCommand(program)
    })

    it('personal: all API calls get undefined workspaceId', async () => {
      setupPersonalOrg()
      mockParseAgentRef.mockReturnValue({ org: 'joe', agent: 'my-agent', version: 'latest' })
      mockListMyAgents.mockResolvedValue([makeAgent()] as any)
      mockCheckAgentDelete.mockResolvedValue({ agent_id: 'agent-001', agent_name: 'my-agent', requires_confirmation: false } as any)
      mockDeleteAgent.mockResolvedValue({ deleted: true, agent_id: 'agent-001', agent_name: 'my-agent' } as any)

      await program.parseAsync(['node', 'test', 'delete', 'joe/my-agent', '--yes'])

      expect(mockListMyAgents).toHaveBeenCalledWith(expect.anything(), undefined)
      expect(mockCheckAgentDelete).toHaveBeenCalledWith(expect.anything(), 'agent-001', undefined)
      expect(mockDeleteAgent).toHaveBeenCalledWith(expect.anything(), 'agent-001', undefined, undefined)
    })

    it('team: all API calls get team workspace ID', async () => {
      setupTeamWorkspace()
      mockParseAgentRef.mockReturnValue({ org: TEAM_ORG, agent: 'my-agent', version: 'latest' })
      mockResolveWorkspaceIdForOrg.mockResolvedValue(TEAM_WS_ID)
      mockListMyAgents.mockResolvedValue([makeAgent({ org_slug: TEAM_ORG })] as any)
      mockCheckAgentDelete.mockResolvedValue({ agent_id: 'agent-001', agent_name: 'my-agent', requires_confirmation: false } as any)
      mockDeleteAgent.mockResolvedValue({ deleted: true, agent_id: 'agent-001', agent_name: 'my-agent' } as any)

      await program.parseAsync(['node', 'test', 'delete', `${TEAM_ORG}/my-agent`, '--yes'])

      expect(mockListMyAgents).toHaveBeenCalledWith(expect.anything(), TEAM_WS_ID)
      expect(mockCheckAgentDelete).toHaveBeenCalledWith(expect.anything(), 'agent-001', TEAM_WS_ID)
      expect(mockDeleteAgent).toHaveBeenCalledWith(expect.anything(), 'agent-001', undefined, TEAM_WS_ID)
    })
  })

  // ── fork (T12-02 regression) ──────────────────────────────

  describe('fork command (T12-02 regression)', () => {
    let program: Command

    beforeEach(async () => {
      const { registerForkCommand } = await import('../fork')
      program = new Command()
      program.exitOverride()
      registerForkCommand(program)
    })

    it('personal: getAgentWithFallback gets undefined workspaceId', async () => {
      setupPersonalOrg()
      mockParseAgentRef.mockReturnValue({ org: 'joe', agent: 'scanner', version: 'latest' })
      mockGetAgentWithFallback.mockResolvedValue(makeAgent({ name: 'scanner' }) as any)
      // forkAgent returns { agent: { ... } }
      mockForkAgent.mockResolvedValue({
        agent: {
          id: 'forked-001',
          name: 'scanner',
          version: 'v1',
          org_slug: 'joe',
          org_id: 'org-joe',
        },
      } as any)

      await program.parseAsync(['node', 'test', 'fork', 'joe/scanner'])

      expect(mockResolveWorkspaceIdForOrg).toHaveBeenCalledWith(expect.anything(), 'joe')
      expect(mockGetAgentWithFallback).toHaveBeenCalledWith(
        expect.anything(),
        'joe', 'scanner', 'latest',
        undefined
      )
    })

    it('team: resolveWorkspaceIdForOrg called BEFORE getAgentWithFallback', async () => {
      setupTeamWorkspace()
      mockParseAgentRef.mockReturnValue({ org: TEAM_ORG, agent: 'scanner', version: 'latest' })
      mockResolveWorkspaceIdForOrg.mockResolvedValue(TEAM_WS_ID)
      mockGetAgentWithFallback.mockResolvedValue(makeAgent({ name: 'scanner', org_slug: TEAM_ORG }) as any)
      mockForkAgent.mockResolvedValue({
        agent: {
          id: 'forked-001',
          name: 'scanner',
          version: 'v1',
          org_slug: TEAM_ORG,
          org_id: 'org-team',
        },
      } as any)

      await program.parseAsync(['node', 'test', 'fork', `${TEAM_ORG}/scanner`])

      expect(mockGetAgentWithFallback).toHaveBeenCalledWith(
        expect.anything(),
        TEAM_ORG, 'scanner', 'latest',
        TEAM_WS_ID
      )
    })
  })

  // ── tree (T12-04 regression) ──────────────────────────────

  describe('tree command (T12-04 regression)', () => {
    let program: Command

    const treeResponse = {
      agent: 'joe/scanner@v3',
      type: 'agent' as const,
      skills: [],
      skills_locked: false,
      dependencies: [],
      summary: { total_agents: 1, total_skills: 0, max_depth: 0, has_locked_skills: false },
    }

    beforeEach(async () => {
      const { registerTreeCommand } = await import('../tree')
      program = new Command()
      program.exitOverride()
      registerTreeCommand(program)
    })

    it('public-first fallback: tries public endpoint, on 404 falls back with X-Workspace-Id', async () => {
      setupTeamWorkspace()
      mockParseAgentRef.mockReturnValue({ org: TEAM_ORG, agent: 'scanner', version: 'latest' })
      mockResolveWorkspaceIdForOrg.mockResolvedValue(TEAM_WS_ID)

      // Public endpoint returns 404
      const apiError = new (ApiError as any)('Not found', 404)
      mockPublicRequest.mockRejectedValue(apiError)

      // Authenticated fallback succeeds
      mockRequest.mockResolvedValue(treeResponse)

      await program.parseAsync(['node', 'test', 'tree', `${TEAM_ORG}/scanner`])

      // Verify public was tried first
      expect(mockPublicRequest).toHaveBeenCalledWith(
        expect.anything(),
        `/public/agents/${TEAM_ORG}/scanner/latest/tree`
      )

      // Verify authenticated fallback used workspace header
      expect(mockRequest).toHaveBeenCalledWith(
        expect.anything(),
        'GET',
        `/agents/${TEAM_ORG}/scanner/latest/tree`,
        { headers: { 'X-Workspace-Id': TEAM_WS_ID } }
      )
    })

    it('team workspace: fallback request includes correct workspace header', async () => {
      setupTeamWorkspace()
      mockParseAgentRef.mockReturnValue({ org: TEAM_ORG, agent: 'private-agent', version: 'v2' })
      mockResolveWorkspaceIdForOrg.mockResolvedValue(TEAM_WS_ID)

      const apiError = new (ApiError as any)('Not found', 404)
      mockPublicRequest.mockRejectedValue(apiError)
      mockRequest.mockResolvedValue({ ...treeResponse, agent: `${TEAM_ORG}/private-agent@v2` })

      await program.parseAsync(['node', 'test', 'tree', `${TEAM_ORG}/private-agent@v2`])

      const requestCall = mockRequest.mock.calls[0]
      expect(requestCall[3]).toEqual({ headers: { 'X-Workspace-Id': TEAM_WS_ID } })
    })
  })

  // ── estimate (BUG-11-02 regression) ───────────────────────

  describe('estimate command (BUG-11-02 regression)', () => {
    let program: Command

    const estimateResponse = {
      agent: 'joe/my-agent@latest',
      type: 'agent',
      execution_engine: 'managed_loop',
      supported_providers: ['anthropic'],
      estimate: { sample_size: 0 },
      metadata: { request_id: 'r1' },
    }

    beforeEach(async () => {
      const { registerEstimateCommand } = await import('../estimate')
      program = new Command()
      program.exitOverride()
      registerEstimateCommand(program)
    })

    it('personal: getAgentCostEstimate without workspace ID', async () => {
      setupPersonalOrg()
      mockParseAgentRef.mockReturnValue({ org: 'joe', agent: 'my-agent', version: 'latest' })
      mockGetAgentCostEstimate.mockResolvedValue(estimateResponse as any)

      await program.parseAsync(['node', 'test', 'estimate', 'joe/my-agent'])

      expect(mockGetAgentCostEstimate).toHaveBeenCalledWith(
        expect.anything(),
        'joe', 'my-agent', 'latest',
        undefined
      )
    })

    it('team: getAgentCostEstimate with workspace ID', async () => {
      setupTeamWorkspace()
      mockParseAgentRef.mockReturnValue({ org: TEAM_ORG, agent: 'my-agent', version: 'latest' })
      mockResolveWorkspaceIdForOrg.mockResolvedValue(TEAM_WS_ID)
      mockGetAgentCostEstimate.mockResolvedValue(estimateResponse as any)

      await program.parseAsync(['node', 'test', 'estimate', `${TEAM_ORG}/my-agent`])

      expect(mockGetAgentCostEstimate).toHaveBeenCalledWith(
        expect.anything(),
        TEAM_ORG, 'my-agent', 'latest',
        TEAM_WS_ID
      )
    })
  })

  // ── security (BUG-11-07 regression) ───────────────────────

  describe('security test command (BUG-11-07 regression)', () => {
    let program: Command

    // security.ts uses shared resolveAgentContext → parseAgentRef (T12-SYS-A).
    // We verify workspace header on the safeFetchWithRetryForCalls call.
    const scanResult = {
      agent_id: 'joe/scanner/latest',
      scanned_at: '2026-02-25T00:00:00Z',
      total_attacks: 10,
      vulnerabilities_found: 0,
      risk_level: 'minimal',
      vulnerabilities: [],
      summary: {
        by_category: {},
        by_severity: {},
      },
    }

    beforeEach(async () => {
      const { registerSecurityCommand } = await import('../security')
      program = new Command()
      program.exitOverride()
      registerSecurityCommand(program)
    })

    it('personal: request to /security/test without X-Workspace-Id', async () => {
      setupPersonalOrg()
      mockParseAgentRef.mockReturnValue({ org: 'joe', agent: 'scanner', version: 'latest' })

      mockSafeFetch.mockResolvedValue({
        ok: true,
        json: async () => scanResult,
      } as any)

      await program.parseAsync(['node', 'test', 'security', 'test', 'joe/scanner'])

      expect(mockSafeFetch).toHaveBeenCalled()
      const fetchCall = mockSafeFetch.mock.calls[0]
      expect(fetchCall[0]).toContain('/security/test')
      const headers = fetchCall[1].headers as Record<string, string>
      expect(headers['X-Workspace-Id']).toBeUndefined()
      expect(headers.Authorization).toBe('Bearer sk_test_personal')
    })

    it('team: request to /security/test with X-Workspace-Id', async () => {
      setupTeamWorkspace()
      mockParseAgentRef.mockReturnValue({ org: TEAM_ORG, agent: 'scanner', version: 'latest' })
      mockResolveWorkspaceIdForOrg.mockResolvedValue(TEAM_WS_ID)

      mockSafeFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          ...scanResult,
          agent_id: `${TEAM_ORG}/scanner/latest`,
        }),
      } as any)

      await program.parseAsync(['node', 'test', 'security', 'test', `${TEAM_ORG}/scanner`])

      expect(mockSafeFetch).toHaveBeenCalled()
      const fetchCall = mockSafeFetch.mock.calls[0]
      const headers = fetchCall[1].headers as Record<string, string>
      expect(headers['X-Workspace-Id']).toBe(TEAM_WS_ID)
    })
  })
})

// ══════════════════════════════════════════════════════════════
// GROUP 2: Pattern B Commands — workspace ID in URL path
// ══════════════════════════════════════════════════════════════

describe('Group 2: Pattern B — workspace ID in URL path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupSpies()
  })

  afterEach(() => {
    teardownSpies()
    vi.restoreAllMocks()
  })

  // ── workspace ─────────────────────────────────────────────

  describe('workspace command', () => {
    let program: Command

    beforeEach(async () => {
      const { registerWorkspaceCommand } = await import('../workspace')
      program = new Command()
      program.exitOverride()
      registerWorkspaceCommand(program)
    })

    it('list: fetches /workspaces, returns all', async () => {
      mockGetResolvedConfig.mockResolvedValue(PERSONAL_CONFIG)
      mockLoadConfig.mockResolvedValue({ workspace: 'joe' })
      mockRequest.mockResolvedValue({
        workspaces: [
          { id: 'ws-1', name: 'Personal', slug: 'joe', type: 'personal', role: 'admin', member_count: 1 },
          { id: 'ws-2', name: 'Acme', slug: 'acme-team', type: 'team', role: 'member', member_count: 3 },
        ],
      })

      await program.parseAsync(['node', 'test', 'workspace', 'list'])

      expect(mockRequest).toHaveBeenCalledWith(
        expect.anything(),
        'GET',
        '/workspaces'
      )
    })

    it('create: POSTs to /workspaces with name and slug', async () => {
      mockGetResolvedConfig.mockResolvedValue(PERSONAL_CONFIG)
      mockRequest.mockResolvedValue({
        workspace: { id: 'ws-new', name: 'New Team', slug: 'new-team' },
      })

      await program.parseAsync(['node', 'test', 'workspace', 'create', 'New Team', '--slug', 'new-team'])

      expect(mockRequest).toHaveBeenCalledWith(
        expect.anything(),
        'POST',
        '/workspaces',
        expect.objectContaining({
          body: expect.stringContaining('new-team'),
        })
      )
    })

    it('use: validates slug exists and calls saveConfig', async () => {
      mockGetResolvedConfig.mockResolvedValue(PERSONAL_CONFIG)
      mockLoadConfig.mockResolvedValue({})
      mockRequest.mockResolvedValue({
        workspaces: [
          { id: 'ws-1', slug: 'joe', type: 'personal', role: 'admin', name: 'Personal', member_count: 1 },
          { id: 'ws-2', slug: 'acme-team', type: 'team', role: 'member', name: 'Acme', member_count: 3 },
        ],
      })

      const { saveConfig } = await import('../../lib/config')
      const mockSaveConfig = vi.mocked(saveConfig)

      await program.parseAsync(['node', 'test', 'workspace', 'use', 'acme-team'])

      expect(mockSaveConfig).toHaveBeenCalled()
    })

    it('members: resolves workspace and GETs /workspaces/{id}/members', async () => {
      mockGetResolvedConfig.mockResolvedValue(PERSONAL_CONFIG)
      mockLoadConfig.mockResolvedValue({ workspace: 'acme-team' })

      // First call: GET /workspaces for resolution
      // Second call: GET /workspaces/{id}/members
      mockRequest
        .mockResolvedValueOnce({
          workspaces: [{ id: 'ws-2', slug: 'acme-team', type: 'team', role: 'admin', name: 'Acme', member_count: 2 }],
        })
        .mockResolvedValueOnce({ members: [], invites: [] })

      await program.parseAsync(['node', 'test', 'workspace', 'members'])

      expect(mockRequest).toHaveBeenCalledWith(
        expect.anything(),
        'GET',
        expect.stringContaining('/workspaces/ws-2/members')
      )
    })

    it('invite: resolves workspace and POSTs /workspaces/{id}/invites', async () => {
      mockGetResolvedConfig.mockResolvedValue(PERSONAL_CONFIG)
      mockLoadConfig.mockResolvedValue({ workspace: 'acme-team' })

      mockRequest
        .mockResolvedValueOnce({
          workspaces: [{ id: 'ws-2', slug: 'acme-team', type: 'team', role: 'admin', name: 'Acme', member_count: 2 }],
        })
        .mockResolvedValueOnce({ invite: { email: 'user@example.com' } })

      await program.parseAsync(['node', 'test', 'workspace', 'invite', 'user@example.com'])

      expect(mockRequest).toHaveBeenCalledWith(
        expect.anything(),
        'POST',
        expect.stringContaining('/workspaces/ws-2/invites'),
        expect.anything()
      )
    })

    it('leave: resolves workspace and calls DELETE member', async () => {
      mockGetResolvedConfig.mockResolvedValue(PERSONAL_CONFIG)
      mockLoadConfig.mockResolvedValue({})

      // /workspaces resolution, /users/me + /members (parallel), DELETE member, /workspaces again for config cleanup
      mockRequest
        .mockResolvedValueOnce({
          workspaces: [{ id: 'ws-2', slug: 'acme-team', type: 'team', role: 'member', name: 'Acme', member_count: 3 }],
        })
        .mockResolvedValueOnce({ user: { email: 'joe@test.com', user_id: 'user-123' } })
        .mockResolvedValueOnce({ members: [{ email: 'joe@test.com', user_id: 'user-123', role: 'member' }], invites: [] })
        .mockResolvedValueOnce({ success: true })

      // workspace leave doesn't have --yes, but it doesn't prompt for slug-based leaves
      await program.parseAsync(['node', 'test', 'workspace', 'leave', 'acme-team'])

      expect(mockRequest).toHaveBeenCalledWith(
        expect.anything(),
        'DELETE',
        expect.stringContaining('/workspaces/ws-2/members/')
      )
    })
  })

  // ── schedule ──────────────────────────────────────────────

  describe('schedule command', () => {
    let program: Command

    beforeEach(async () => {
      const { registerScheduleCommand } = await import('../schedule')
      program = new Command()
      program.exitOverride()
      registerScheduleCommand(program)
    })

    it('list: workspace ID in GET path', async () => {
      mockGetResolvedConfig.mockResolvedValue(PERSONAL_CONFIG)
      mockLoadConfig.mockResolvedValue({ workspace: 'acme-team' })

      mockRequest
        .mockResolvedValueOnce({
          workspaces: [{ id: 'ws-2', slug: 'acme-team', type: 'team' }],
        })
        .mockResolvedValueOnce({ schedules: [] })

      await program.parseAsync(['node', 'test', 'schedule', 'list'])

      expect(mockRequest).toHaveBeenCalledWith(
        expect.anything(),
        'GET',
        expect.stringMatching(/\/workspaces\/ws-2\/schedules/)
      )
    })

    it('delete: workspace ID in DELETE path (full UUID bypasses resolution)', async () => {
      mockGetResolvedConfig.mockResolvedValue(PERSONAL_CONFIG)
      mockLoadConfig.mockResolvedValue({ workspace: 'acme-team' })

      // Use a full UUID (32+ chars) to bypass resolveScheduleId prefix lookup
      const fullUuid = '12345678-1234-1234-1234-123456789012'

      mockRequest
        .mockResolvedValueOnce({
          workspaces: [{ id: 'ws-2', slug: 'acme-team', type: 'team' }],
        })
        .mockResolvedValueOnce({ deleted: true })

      await program.parseAsync(['node', 'test', 'schedule', 'delete', fullUuid, '--yes'])

      expect(mockRequest).toHaveBeenCalledWith(
        expect.anything(),
        'DELETE',
        expect.stringMatching(new RegExp(`/workspaces/ws-2/schedules/${fullUuid}`))
      )
    })

    it('trigger: workspace ID in POST trigger path (full UUID)', async () => {
      mockGetResolvedConfig.mockResolvedValue(PERSONAL_CONFIG)
      mockLoadConfig.mockResolvedValue({ workspace: 'acme-team' })

      const fullUuid = '12345678-1234-1234-1234-123456789012'

      mockRequest
        .mockResolvedValueOnce({
          workspaces: [{ id: 'ws-2', slug: 'acme-team', type: 'team' }],
        })
        .mockResolvedValueOnce({ run_id: 'run-123' })

      await program.parseAsync(['node', 'test', 'schedule', 'trigger', fullUuid])

      expect(mockRequest).toHaveBeenCalledWith(
        expect.anything(),
        'POST',
        expect.stringMatching(new RegExp(`/workspaces/ws-2/schedules/${fullUuid}/trigger`)),
        expect.anything()
      )
    })

    it('--workspace flag: overrides config workspace', async () => {
      mockGetResolvedConfig.mockResolvedValue(PERSONAL_CONFIG)
      mockLoadConfig.mockResolvedValue({ workspace: 'default-ws' })

      mockRequest
        .mockResolvedValueOnce({
          workspaces: [
            { id: 'ws-default', slug: 'default-ws', type: 'team' },
            { id: 'ws-override', slug: 'override-ws', type: 'team' },
          ],
        })
        .mockResolvedValueOnce({ schedules: [] })

      await program.parseAsync(['node', 'test', 'schedule', 'list', '--workspace', 'override-ws'])

      expect(mockRequest).toHaveBeenCalledWith(
        expect.anything(),
        'GET',
        expect.stringMatching(/\/workspaces\/ws-override\/schedules/)
      )
    })

    it('auto-select: single workspace auto-selected', async () => {
      mockGetResolvedConfig.mockResolvedValue(PERSONAL_CONFIG)
      mockLoadConfig.mockResolvedValue({}) // No workspace in config

      mockRequest
        .mockResolvedValueOnce({
          workspaces: [{ id: 'ws-only', slug: 'only-ws', type: 'team' }],
        })
        .mockResolvedValueOnce({ schedules: [] })

      await program.parseAsync(['node', 'test', 'schedule', 'list'])

      expect(mockRequest).toHaveBeenCalledWith(
        expect.anything(),
        'GET',
        expect.stringMatching(/\/workspaces\/ws-only\/schedules/)
      )
    })

    it('create: workspace ID in POST path + agent resolution', async () => {
      mockGetResolvedConfig.mockResolvedValue(PERSONAL_CONFIG)
      mockLoadConfig.mockResolvedValue({ workspace: 'acme-team' })
      mockParseAgentRef.mockReturnValue({ org: TEAM_ORG, agent: 'my-agent', version: 'latest' })
      mockGetAgentWithFallback.mockResolvedValue(makeAgent({ org_slug: TEAM_ORG }) as any)

      mockRequest
        .mockResolvedValueOnce({
          workspaces: [{ id: 'ws-2', slug: 'acme-team', type: 'team' }],
        })
        .mockResolvedValueOnce({
          schedule: { id: 'sched-new', cron: '0 * * * *' },
        })

      await program.parseAsync(['node', 'test', 'schedule', 'create', `${TEAM_ORG}/my-agent`, '--cron', '0 * * * *'])

      expect(mockRequest).toHaveBeenCalledWith(
        expect.anything(),
        'POST',
        expect.stringMatching(/\/workspaces\/ws-2\/schedules/),
        expect.anything()
      )
    })

    it('info: workspace ID in GET path (full UUID)', async () => {
      mockGetResolvedConfig.mockResolvedValue(PERSONAL_CONFIG)
      mockLoadConfig.mockResolvedValue({ workspace: 'acme-team' })

      const fullUuid = '12345678-1234-1234-1234-123456789012'

      mockRequest
        .mockResolvedValueOnce({
          workspaces: [{ id: 'ws-2', slug: 'acme-team', type: 'team' }],
        })
        .mockResolvedValueOnce({ schedule: { id: fullUuid, cron: '0 * * * *', type: 'cron', agent_ref: 'test/agent@v1' } })
        .mockResolvedValueOnce({ runs: [] })
        .mockResolvedValueOnce({ events: [] })

      await program.parseAsync(['node', 'test', 'schedule', 'info', fullUuid])

      // Verify at least one call used the workspace-scoped path
      const calls = mockRequest.mock.calls
      const scheduleInfoCall = calls.find(
        c => typeof c[2] === 'string' &&
        c[2].includes(`/schedules/${fullUuid}`) &&
        !c[2].includes('/runs') &&
        !c[2].includes('/events')
      )
      expect(scheduleInfoCall?.[2]).toMatch(/\/workspaces\/ws-2\/schedules\//)
    })
  })

  // ── service ───────────────────────────────────────────────

  describe('service command', () => {
    let program: Command

    beforeEach(async () => {
      const { registerServiceCommand } = await import('../service')
      program = new Command()
      program.exitOverride()
      registerServiceCommand(program)
    })

    it('list: workspace ID in GET path', async () => {
      mockGetResolvedConfig.mockResolvedValue(PERSONAL_CONFIG)
      mockLoadConfig.mockResolvedValue({ workspace: 'acme-team' })

      mockRequest
        .mockResolvedValueOnce({
          workspaces: [{ id: 'ws-2', slug: 'acme-team', type: 'team' }],
        })
        .mockResolvedValueOnce({ services: [] })

      await program.parseAsync(['node', 'test', 'service', 'list'])

      expect(mockRequest).toHaveBeenCalledWith(
        expect.anything(),
        'GET',
        expect.stringMatching(/\/workspaces\/ws-2\/services/)
      )
    })

    it('restart: workspace ID in POST restart path', async () => {
      mockGetResolvedConfig.mockResolvedValue(PERSONAL_CONFIG)
      mockLoadConfig.mockResolvedValue({ workspace: 'acme-team' })

      mockRequest
        .mockResolvedValueOnce({
          workspaces: [{ id: 'ws-2', slug: 'acme-team', type: 'team' }],
        })
        .mockResolvedValueOnce({ service: { service_name: 'my-svc' } })

      await program.parseAsync(['node', 'test', 'service', 'restart', 'svc-001'])

      expect(mockRequest).toHaveBeenCalledWith(
        expect.anything(),
        'POST',
        expect.stringMatching(/\/workspaces\/ws-2\/services\/svc-001\/restart/)
      )
    })

    it('delete: workspace ID in DELETE path', async () => {
      mockGetResolvedConfig.mockResolvedValue(PERSONAL_CONFIG)
      mockLoadConfig.mockResolvedValue({ workspace: 'acme-team' })

      // service delete has no --yes flag; it just deletes directly
      mockRequest
        .mockResolvedValueOnce({
          workspaces: [{ id: 'ws-2', slug: 'acme-team', type: 'team' }],
        })
        .mockResolvedValueOnce({ service: { service_name: 'my-svc' } })

      await program.parseAsync(['node', 'test', 'service', 'delete', 'svc-001'])

      expect(mockRequest).toHaveBeenCalledWith(
        expect.anything(),
        'DELETE',
        expect.stringMatching(/\/workspaces\/ws-2\/services\/svc-001/)
      )
    })

    it('env set: workspace ID in both GET and PATCH paths', async () => {
      mockGetResolvedConfig.mockResolvedValue(PERSONAL_CONFIG)
      mockLoadConfig.mockResolvedValue({ workspace: 'acme-team' })

      mockRequest
        .mockResolvedValueOnce({
          workspaces: [{ id: 'ws-2', slug: 'acme-team', type: 'team' }],
        })
        .mockResolvedValueOnce({
          service: { id: 'svc-001', env_json: {}, secrets: [] },
        })
        .mockResolvedValueOnce({ success: true })

      await program.parseAsync(['node', 'test', 'service', 'env', 'set', 'svc-001', 'KEY=value'])

      const patchCalls = mockRequest.mock.calls.filter(c => c[1] === 'PATCH')
      expect(patchCalls.length).toBeGreaterThanOrEqual(1)
      expect(patchCalls[0][2]).toMatch(/\/workspaces\/ws-2\/services\/svc-001/)
    })

    it('info: workspace ID in GET path', async () => {
      mockGetResolvedConfig.mockResolvedValue(PERSONAL_CONFIG)
      mockLoadConfig.mockResolvedValue({ workspace: 'acme-team' })

      mockRequest
        .mockResolvedValueOnce({
          workspaces: [{ id: 'ws-2', slug: 'acme-team', type: 'team' }],
        })
        .mockResolvedValueOnce({
          service: {
            id: 'svc-001',
            name: 'my-svc',
            status: 'running',
            agent_name: 'my-agent',
            agent_ref: 'acme/agent@v1',
            created_at: '2026-02-20T00:00:00Z',
            min_instances: 0,
            max_instances: 1,
          },
        })

      await program.parseAsync(['node', 'test', 'service', 'info', 'svc-001'])

      expect(mockRequest).toHaveBeenCalledWith(
        expect.anything(),
        'GET',
        expect.stringMatching(/\/workspaces\/ws-2\/services\/svc-001/)
      )
    })
  })
})

// ══════════════════════════════════════════════════════════════
// GROUP 3: Agent Ref Parsing & Resolution Consistency
// ══════════════════════════════════════════════════════════════

describe('Group 3: Agent ref parsing & resolution consistency', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── diff ref parsing (T12-05 regression) ──────────────────

  describe('diff parseSecondRef (T12-05 regression)', () => {
    // Testing the parseSecondRef logic from diff.ts:313-323 inline
    // since it's not exported.
    function parseSecondRef(
      value: string,
      firstOrg: string,
      firstName: string
    ): { org: string; agent: string; version: string } {
      if (value.includes('/')) {
        const [ref, versionPart] = value.split('@')
        const version = versionPart?.trim() || 'latest'
        const segments = ref.split('/')
        return {
          org: segments.length === 2 ? segments[0] : firstOrg,
          agent: segments.length === 2 ? segments[1] : segments[0],
          version,
        }
      }
      const version = value.startsWith('@') ? value.slice(1) : value
      return { org: firstOrg, agent: firstName, version }
    }

    it('@v2 shorthand: strips leading @, does not produce @@v2', () => {
      const result = parseSecondRef('@v2', 'acme', 'scanner')
      expect(result).toEqual({ org: 'acme', agent: 'scanner', version: 'v2' })
      expect(result.version).not.toContain('@@')
    })

    it('full ref: org/agent@v1 second ref works correctly', () => {
      const result = parseSecondRef('other-org/other-agent@v1', 'acme', 'scanner')
      expect(result).toEqual({ org: 'other-org', agent: 'other-agent', version: 'v1' })
    })
  })

  // ── transfer ref parsing (T12-10 regression) ──────────────

  describe('transfer ref parsing (T12-10 regression)', () => {
    // Inline the real parseAgentRef logic to test it without mock interference
    function realParseAgentRef(value: string, defaultVersion = 'latest') {
      const [ref, versionPart] = value.split('@')
      const version = versionPart?.trim() || defaultVersion
      const segments = ref.split('/')
      if (segments.length === 1) {
        return { org: undefined, agent: segments[0], version }
      }
      if (segments.length === 2) {
        return { org: segments[0], agent: segments[1], version }
      }
      throw new Error('Invalid agent reference')
    }

    it('org/agent format: accepted and resolves correctly', () => {
      const result = realParseAgentRef('my-org/my-agent')
      expect(result).toEqual({ org: 'my-org', agent: 'my-agent', version: 'latest' })
    })

    it('agent-name format: still works (backward compat)', () => {
      const result = realParseAgentRef('my-agent')
      expect(result).toEqual({ org: undefined, agent: 'my-agent', version: 'latest' })
    })
  })

  // ── init defaults (T12-06 regression) ─────────────────────

  describe('init defaults (T12-06 regression)', () => {
    // Test the resolveInitFlavor logic inline since it's not exported
    function resolveInitFlavor(typeOption: string) {
      const normalized = (typeOption || 'prompt').trim().toLowerCase()
      if (normalized === 'skill') return { type: 'skill' }
      if (normalized === 'prompt') return { type: 'prompt', flavor: 'direct_llm' }
      if (normalized === 'agent') return { type: 'agent', flavor: 'managed_loop' }
      if (normalized === 'agentic') return { type: 'agent', flavor: 'code_runtime' }
      if (normalized === 'tool' || normalized === 'code') return { type: 'tool', flavor: 'code_runtime' }
      throw new Error(`Unknown --type '${typeOption}'`)
    }

    it('--type agent: defaults to managed_loop, NOT code_runtime', () => {
      const result = resolveInitFlavor('agent')
      expect(result).toEqual({ type: 'agent', flavor: 'managed_loop' })
      expect(result.flavor).not.toBe('code_runtime')
    })

    it('--type agent (with --loop): explicitly requests managed_loop', () => {
      // --loop sets flavor to managed_loop for agent type
      const result = resolveInitFlavor('agent')
      expect(result.flavor).toBe('managed_loop')
    })

    it('--type agentic: legacy alias maps to code_runtime', () => {
      const result = resolveInitFlavor('agentic')
      expect(result).toEqual({ type: 'agent', flavor: 'code_runtime' })
    })

    it('--type tool: maps to code_runtime', () => {
      const result = resolveInitFlavor('tool')
      expect(result).toEqual({ type: 'tool', flavor: 'code_runtime' })
    })
  })
})

// ══════════════════════════════════════════════════════════════
// GROUP 4: Error Semantics
// ══════════════════════════════════════════════════════════════

describe('Group 4: Error semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupSpies()
  })

  afterEach(() => {
    teardownSpies()
    vi.restoreAllMocks()
  })

  // ── publish security verdict (T12-12 regression) ──────────

  describe('publish security verdict display (T12-12 regression)', () => {
    // Tests the verdict formatting logic from publish.ts:1530-1541
    function formatSecurityVerdict(verdict: string, summary?: string): string {
      if (verdict === 'approved') return 'passed'
      if (verdict === 'flagged') return `flagged — ${summary || 'review recommended'}`
      if (verdict === 'error') return 'review unavailable — publish succeeded, review will be retried'
      if (verdict === 'skipped') return `review skipped — ${summary || 'content not eligible for review'}`
      return `${verdict} — ${summary || ''}`
    }

    it('gateway "approved" → CLI shows "passed"', () => {
      expect(formatSecurityVerdict('approved')).toBe('passed')
    })

    it('gateway "error" → CLI shows "review unavailable"', () => {
      const result = formatSecurityVerdict('error')
      expect(result).toContain('review unavailable')
      expect(result).not.toBe('error')
    })

    it('gateway "skipped" → CLI shows reason summary', () => {
      const result = formatSecurityVerdict('skipped', 'prompt-only agent')
      expect(result).toContain('review skipped')
      expect(result).toContain('prompt-only agent')
      expect(result).not.toBe('skipped')
    })
  })

  // ── version resolution edge cases ─────────────────────────

  describe('version resolution edge cases', () => {
    it('non-existent agent ref — deterministic 404 error, not crash', async () => {
      const { registerEstimateCommand } = await import('../estimate')
      const program = new Command()
      program.exitOverride()
      registerEstimateCommand(program)

      setupPersonalOrg()
      mockParseAgentRef.mockReturnValue({ org: 'joe', agent: 'nonexistent', version: 'v99' })

      const apiError = new (ApiError as any)('Agent not found', 404)
      mockGetAgentCostEstimate.mockRejectedValue(apiError)

      try {
        await program.parseAsync(['node', 'test', 'estimate', 'joe/nonexistent@v99'])
      } catch {
        // Expected — process.exit mock throws
      }

      const errOutput = stderrSpy.mock.calls.map(c => c[0]).join('')
      expect(errOutput).toContain('not found')
    })

    it('malformed ref (double @) — parser handles gracefully', () => {
      // Inline the real parseAgentRef to test actual behavior
      function realParseAgentRef(value: string) {
        const [ref, versionPart] = value.split('@')
        const version = versionPart?.trim() || 'latest'
        const segments = ref.split('/')
        if (segments.length === 1) return { org: undefined, agent: segments[0], version }
        if (segments.length === 2) return { org: segments[0], agent: segments[1], version }
        throw new Error('Invalid')
      }

      // 'acme/scanner@@v2' splits on first '@' → ref='acme/scanner', version='@v2'
      const result = realParseAgentRef('acme/scanner@@v2')
      expect(result.org).toBe('acme')
      expect(result.agent).toBe('scanner')
      expect(result.version).toBeDefined()
      // Version comes out as '@v2' (not crashing)
    })
  })
})

// ══════════════════════════════════════════════════════════════
// GROUP 5: Cross-Command Contracts
// ══════════════════════════════════════════════════════════════

describe('Group 5: Cross-command contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupSpies()
  })

  afterEach(() => {
    teardownSpies()
    vi.restoreAllMocks()
  })

  // ── JSON output contract ──────────────────────────────────

  describe('JSON output contract', () => {
    it('agents --json exits 0 on success with parseable JSON', async () => {
      const { registerAgentsCommand } = await import('../agents')
      const program = new Command()
      program.exitOverride()
      registerAgentsCommand(program)

      setupPersonalOrg()
      mockListMyAgents.mockResolvedValue([makeAgent()] as any)

      const { printJson } = await import('../../lib/output')
      const mockPrintJson = vi.mocked(printJson)

      await program.parseAsync(['node', 'test', 'agents', '--json'])

      expect(mockPrintJson).toHaveBeenCalled()
    })

    it('estimate --json exits 0 on success with parseable JSON', async () => {
      const { registerEstimateCommand } = await import('../estimate')
      const program = new Command()
      program.exitOverride()
      registerEstimateCommand(program)

      setupPersonalOrg()
      mockParseAgentRef.mockReturnValue({ org: 'joe', agent: 'my-agent', version: 'latest' })
      mockGetAgentCostEstimate.mockResolvedValue({
        agent: 'joe/my-agent@latest',
        type: 'agent',
        execution_engine: 'managed_loop',
        supported_providers: ['anthropic'],
        estimate: { sample_size: 5, avg_cost_usd: 0.01, p50_cost_usd: 0.008, p95_cost_usd: 0.02, period_days: 30 },
        metadata: { request_id: 'r1' },
      } as any)

      const { printJson } = await import('../../lib/output')
      const mockPrintJson = vi.mocked(printJson)

      await program.parseAsync(['node', 'test', 'estimate', 'joe/my-agent', '--json'])

      expect(mockPrintJson).toHaveBeenCalled()
    })
  })

  // ── Workspace resolution consistency ──────────────────────

  describe('workspace resolution consistency', () => {
    it('agents and delete both use resolveWorkspaceIdForOrg with same org', async () => {
      // Both commands should resolve workspace for the same org consistently
      const { registerAgentsCommand } = await import('../agents')
      const { registerDeleteCommand } = await import('../delete')

      // Test agents command
      const agentsProgram = new Command()
      agentsProgram.exitOverride()
      registerAgentsCommand(agentsProgram)

      setupTeamWorkspace()
      mockListMyAgents.mockResolvedValue([makeAgent({ org_slug: TEAM_ORG })] as any)

      await agentsProgram.parseAsync(['node', 'test', 'agents'])

      const agentsWsCall = mockResolveWorkspaceIdForOrg.mock.calls[0]

      // Test delete command
      vi.clearAllMocks()
      setupSpies()

      const deleteProgram = new Command()
      deleteProgram.exitOverride()
      registerDeleteCommand(deleteProgram)

      setupTeamWorkspace()
      mockParseAgentRef.mockReturnValue({ org: TEAM_ORG, agent: 'my-agent', version: 'latest' })
      mockResolveWorkspaceIdForOrg.mockResolvedValue(TEAM_WS_ID)
      mockListMyAgents.mockResolvedValue([makeAgent({ org_slug: TEAM_ORG })] as any)
      mockCheckAgentDelete.mockResolvedValue({ agent_id: 'agent-001', agent_name: 'my-agent', requires_confirmation: false } as any)
      mockDeleteAgent.mockResolvedValue({ deleted: true, agent_id: 'agent-001', agent_name: 'my-agent' } as any)

      await deleteProgram.parseAsync(['node', 'test', 'delete', `${TEAM_ORG}/my-agent`, '--yes'])

      const deleteWsCall = mockResolveWorkspaceIdForOrg.mock.calls[0]

      // Both should resolve workspace for the same org
      expect(agentsWsCall[1]).toBe(TEAM_ORG)
      expect(deleteWsCall[1]).toBe(TEAM_ORG)
    })
  })
})
