/**
 * Tests for the agents command (UX-002: latest-only by default).
 *
 * Validates: latest-only default, --all-versions flag, --filter,
 * --json output, version count display, edge cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

vi.mock('../lib/config', () => ({
  getResolvedConfig: vi.fn(),
  loadConfig: vi.fn().mockResolvedValue({}),
}))

vi.mock('../lib/api', () => ({
  listMyAgents: vi.fn(),
  resolveWorkspaceIdForOrg: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../lib/output', () => ({
  printJson: vi.fn(),
}))

import { registerAgentsCommand, latestOnly } from './agents'
import { getResolvedConfig, loadConfig } from '../lib/config'
import { listMyAgents, resolveWorkspaceIdForOrg } from '../lib/api'
import { printJson } from '../lib/output'
import type { Agent } from '../types'

const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockLoadConfig = vi.mocked(loadConfig)
const mockListMyAgents = vi.mocked(listMyAgents)
const mockResolveWorkspaceId = vi.mocked(resolveWorkspaceIdForOrg)
const mockPrintJson = vi.mocked(printJson)

function makeAgent(overrides: Partial<Agent> & { name: string; version: string; created_at: string }): Agent {
  return {
    id: `id-${overrides.name}-${overrides.version}`,
    type: 'prompt',
    ...overrides,
  } as Agent
}

function allStdout(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map(c => c[0]).join('')
}

describe('latestOnly', () => {
  it('returns the latest version of each agent by created_at', () => {
    const agents: Agent[] = [
      makeAgent({ name: 'scanner', version: 'v1', created_at: '2026-01-01T00:00:00Z' }),
      makeAgent({ name: 'scanner', version: 'v2', created_at: '2026-02-01T00:00:00Z' }),
      makeAgent({ name: 'scanner', version: 'v3', created_at: '2026-03-01T00:00:00Z' }),
      makeAgent({ name: 'reviewer', version: 'v1', created_at: '2026-01-15T00:00:00Z' }),
    ]

    const result = latestOnly(agents)
    expect(result.agents).toHaveLength(2)
    expect(result.agents.map(a => `${a.name}@${a.version}`)).toEqual([
      'reviewer@v1',
      'scanner@v3',
    ])
    expect(result.versionCounts.get('scanner')).toBe(3)
    expect(result.versionCounts.get('reviewer')).toBe(1)
  })

  it('returns empty for empty input', () => {
    const result = latestOnly([])
    expect(result.agents).toHaveLength(0)
    expect(result.versionCounts.size).toBe(0)
  })

  it('handles single agent with single version', () => {
    const agents = [makeAgent({ name: 'solo', version: 'v1', created_at: '2026-01-01T00:00:00Z' })]
    const result = latestOnly(agents)
    expect(result.agents).toHaveLength(1)
    expect(result.agents[0].version).toBe('v1')
    expect(result.versionCounts.get('solo')).toBe(1)
  })

  it('sorts output alphabetically by name', () => {
    const agents = [
      makeAgent({ name: 'zebra', version: 'v1', created_at: '2026-01-01T00:00:00Z' }),
      makeAgent({ name: 'alpha', version: 'v1', created_at: '2026-01-01T00:00:00Z' }),
      makeAgent({ name: 'mid', version: 'v1', created_at: '2026-01-01T00:00:00Z' }),
    ]
    const result = latestOnly(agents)
    expect(result.agents.map(a => a.name)).toEqual(['alpha', 'mid', 'zebra'])
  })
})

describe('orch agents', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerAgentsCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'joe',
    })
    mockLoadConfig.mockResolvedValue({})
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    vi.restoreAllMocks()
  })

  const multiVersionAgents: Agent[] = [
    makeAgent({ name: 'scanner', version: 'v1', type: 'tool', created_at: '2026-01-01T00:00:00Z', description: 'Code scanner' }),
    makeAgent({ name: 'scanner', version: 'v2', type: 'tool', created_at: '2026-02-01T00:00:00Z', description: 'Code scanner v2' }),
    makeAgent({ name: 'scanner', version: 'v3', type: 'tool', created_at: '2026-03-01T00:00:00Z', description: 'Code scanner v3' }),
    makeAgent({ name: 'reviewer', version: 'v1', type: 'agent', created_at: '2026-01-15T00:00:00Z', description: 'Code reviewer' }),
    makeAgent({ name: 'reviewer', version: 'v2', type: 'agent', created_at: '2026-02-15T00:00:00Z', description: 'Code reviewer v2' }),
    makeAgent({ name: 'formatter', version: 'v1', type: 'prompt', created_at: '2026-01-10T00:00:00Z', description: 'Code formatter' }),
  ]

  describe('default (latest-only)', () => {
    it('shows only the latest version per agent', async () => {
      mockListMyAgents.mockResolvedValue(multiVersionAgents)
      await program.parseAsync(['node', 'test', 'agents'])

      const output = allStdout(stdoutSpy)
      // Should show 3 agents (formatter, reviewer, scanner) — one row each
      expect(output).toContain('formatter')
      expect(output).toContain('reviewer')
      expect(output).toContain('scanner')
      expect(output).toContain('3 agents')
    })

    it('shows latest version for each agent', async () => {
      mockListMyAgents.mockResolvedValue(multiVersionAgents)
      await program.parseAsync(['node', 'test', 'agents'])

      const output = allStdout(stdoutSpy)
      // scanner should show v3 (latest), reviewer should show v2
      expect(output).toContain('v3')
      expect(output).toContain('v2')
      // v1 should still appear for formatter (only version)
      expect(output).toContain('v1')
    })

    it('shows version count when agent has multiple versions', async () => {
      mockListMyAgents.mockResolvedValue(multiVersionAgents)
      await program.parseAsync(['node', 'test', 'agents'])

      const output = allStdout(stdoutSpy)
      expect(output).toContain('3 total')  // scanner has 3 versions
      expect(output).toContain('2 total')  // reviewer has 2 versions
      // formatter has 1 version — no count suffix
    })

    it('shows hint about --all-versions when versions are hidden', async () => {
      mockListMyAgents.mockResolvedValue(multiVersionAgents)
      await program.parseAsync(['node', 'test', 'agents'])

      const output = allStdout(stdoutSpy)
      expect(output).toContain('6 versions total')
      expect(output).toContain('--all-versions')
    })

    it('does not show --all-versions hint when each agent has one version', async () => {
      const singleVersionAgents = [
        makeAgent({ name: 'alpha', version: 'v1', created_at: '2026-01-01T00:00:00Z' }),
        makeAgent({ name: 'beta', version: 'v1', created_at: '2026-01-01T00:00:00Z' }),
      ]
      mockListMyAgents.mockResolvedValue(singleVersionAgents)
      await program.parseAsync(['node', 'test', 'agents'])

      const output = allStdout(stdoutSpy)
      expect(output).not.toContain('--all-versions')
      expect(output).toContain('2 agents')
    })
  })

  describe('--all-versions', () => {
    it('shows all versions of all agents', async () => {
      mockListMyAgents.mockResolvedValue(multiVersionAgents)
      await program.parseAsync(['node', 'test', 'agents', '--all-versions'])

      const output = allStdout(stdoutSpy)
      expect(output).toContain('6 versions')
    })

    it('shows each version as a separate row', async () => {
      mockListMyAgents.mockResolvedValue(multiVersionAgents)
      await program.parseAsync(['node', 'test', 'agents', '--all-versions'])

      const output = allStdout(stdoutSpy)
      // All versions should be in the table
      expect(output).toContain('v1')
      expect(output).toContain('v2')
      expect(output).toContain('v3')
      // No "(X total)" annotations
      expect(output).not.toContain('total)')
    })
  })

  describe('--filter', () => {
    it('filters agents by name', async () => {
      mockListMyAgents.mockResolvedValue(multiVersionAgents)
      await program.parseAsync(['node', 'test', 'agents', '--filter', 'scanner'])

      const output = allStdout(stdoutSpy)
      expect(output).toContain('scanner')
      expect(output).not.toContain('reviewer')
      expect(output).not.toContain('formatter')
    })

    it('filter applies before latest-only grouping', async () => {
      mockListMyAgents.mockResolvedValue(multiVersionAgents)
      await program.parseAsync(['node', 'test', 'agents', '--filter', 'scanner'])

      const output = allStdout(stdoutSpy)
      expect(output).toContain('1 agent')
      expect(output).toContain('3 versions total')
    })

    it('filter + --all-versions shows all matching versions', async () => {
      mockListMyAgents.mockResolvedValue(multiVersionAgents)
      await program.parseAsync(['node', 'test', 'agents', '--filter', 'scanner', '--all-versions'])

      const output = allStdout(stdoutSpy)
      expect(output).toContain('3 versions')
    })

    it('shows message when filter matches nothing', async () => {
      mockListMyAgents.mockResolvedValue(multiVersionAgents)
      await program.parseAsync(['node', 'test', 'agents', '--filter', 'nonexistent'])

      const output = allStdout(stdoutSpy)
      expect(output).toContain('No agents found matching "nonexistent"')
    })

    it('filter is case-insensitive', async () => {
      mockListMyAgents.mockResolvedValue(multiVersionAgents)
      await program.parseAsync(['node', 'test', 'agents', '--filter', 'SCANNER'])

      const output = allStdout(stdoutSpy)
      expect(output).toContain('scanner')
    })
  })

  describe('--json', () => {
    it('outputs latest-only agents as JSON by default', async () => {
      mockListMyAgents.mockResolvedValue(multiVersionAgents)
      await program.parseAsync(['node', 'test', 'agents', '--json'])

      expect(mockPrintJson).toHaveBeenCalledTimes(1)
      const jsonArg = mockPrintJson.mock.calls[0][0] as Agent[]
      expect(jsonArg).toHaveLength(3)  // 3 unique agents
      const names = jsonArg.map((a: Agent) => a.name)
      expect(names).toContain('scanner')
      expect(names).toContain('reviewer')
      expect(names).toContain('formatter')
    })

    it('outputs all versions as JSON with --all-versions', async () => {
      mockListMyAgents.mockResolvedValue(multiVersionAgents)
      await program.parseAsync(['node', 'test', 'agents', '--json', '--all-versions'])

      expect(mockPrintJson).toHaveBeenCalledTimes(1)
      const jsonArg = mockPrintJson.mock.calls[0][0] as Agent[]
      expect(jsonArg).toHaveLength(6)  // all 6 agent versions
    })

    it('json + filter shows only filtered agents', async () => {
      mockListMyAgents.mockResolvedValue(multiVersionAgents)
      await program.parseAsync(['node', 'test', 'agents', '--json', '--filter', 'reviewer'])

      expect(mockPrintJson).toHaveBeenCalledTimes(1)
      const jsonArg = mockPrintJson.mock.calls[0][0] as Agent[]
      // Latest only by default, so 1 reviewer
      expect(jsonArg).toHaveLength(1)
      expect((jsonArg[0] as Agent).name).toBe('reviewer')
      expect((jsonArg[0] as Agent).version).toBe('v2')
    })
  })

  describe('empty state', () => {
    it('shows empty message with no agents', async () => {
      mockListMyAgents.mockResolvedValue([])
      await program.parseAsync(['node', 'test', 'agents'])

      const output = allStdout(stdoutSpy)
      expect(output).toContain('No agents published yet')
      expect(output).toContain('orch publish')
    })
  })

  describe('description truncation', () => {
    it('truncates long descriptions at 60 chars', async () => {
      const agents = [
        makeAgent({
          name: 'long-desc',
          version: 'v1',
          created_at: '2026-01-01T00:00:00Z',
          description: 'A very long description that goes on and on and should definitely be truncated at some point',
        }),
      ]
      mockListMyAgents.mockResolvedValue(agents)
      await program.parseAsync(['node', 'test', 'agents'])

      const output = allStdout(stdoutSpy)
      expect(output).toContain('...')
    })

    it('does not truncate short descriptions', async () => {
      const agents = [
        makeAgent({
          name: 'short-desc',
          version: 'v1',
          created_at: '2026-01-01T00:00:00Z',
          description: 'Short desc',
        }),
      ]
      mockListMyAgents.mockResolvedValue(agents)
      await program.parseAsync(['node', 'test', 'agents'])

      const output = allStdout(stdoutSpy)
      expect(output).toContain('Short desc')
      expect(output).not.toContain('...')
    })

    it('shows dash when description is missing', async () => {
      const agents = [
        makeAgent({ name: 'no-desc', version: 'v1', created_at: '2026-01-01T00:00:00Z' }),
      ]
      mockListMyAgents.mockResolvedValue(agents)
      await program.parseAsync(['node', 'test', 'agents'])

      const output = allStdout(stdoutSpy)
      expect(output).toContain('-')
    })
  })

  describe('singular/plural', () => {
    it('uses singular "agent" for one agent', async () => {
      const agents = [
        makeAgent({ name: 'only-one', version: 'v1', created_at: '2026-01-01T00:00:00Z' }),
      ]
      mockListMyAgents.mockResolvedValue(agents)
      await program.parseAsync(['node', 'test', 'agents'])

      const output = allStdout(stdoutSpy)
      expect(output).toMatch(/\b1 agent\b/)
      expect(output).not.toContain('1 agents')
    })

    it('uses singular "version" for one version with --all-versions', async () => {
      const agents = [
        makeAgent({ name: 'solo', version: 'v1', created_at: '2026-01-01T00:00:00Z' }),
      ]
      mockListMyAgents.mockResolvedValue(agents)
      await program.parseAsync(['node', 'test', 'agents', '--all-versions'])

      const output = allStdout(stdoutSpy)
      expect(output).toMatch(/1 version\b/)
    })
  })

  describe('--fields', () => {
    it('filters JSON output to specified fields', async () => {
      mockListMyAgents.mockResolvedValue(multiVersionAgents)
      await program.parseAsync(['node', 'test', 'agents', '--fields', 'name,version'])

      expect(mockPrintJson).toHaveBeenCalledTimes(1)
      const jsonArg = mockPrintJson.mock.calls[0][0] as Record<string, unknown>[]
      expect(jsonArg).toHaveLength(3) // latest-only by default
      for (const agent of jsonArg) {
        expect(Object.keys(agent)).toEqual(['name', 'version'])
      }
    })

    it('implies --json output (no table rendered)', async () => {
      mockListMyAgents.mockResolvedValue(multiVersionAgents)
      await program.parseAsync(['node', 'test', 'agents', '--fields', 'name'])

      expect(mockPrintJson).toHaveBeenCalledTimes(1)
      // Should not render table to stdout (only printJson called)
      const output = allStdout(stdoutSpy)
      expect(output).toBe('')
    })

    it('handles fields that do not exist on the agent', async () => {
      const agents = [makeAgent({ name: 'solo', version: 'v1', created_at: '2026-01-01T00:00:00Z' })]
      mockListMyAgents.mockResolvedValue(agents)
      await program.parseAsync(['node', 'test', 'agents', '--fields', 'name,nonexistent'])

      const jsonArg = mockPrintJson.mock.calls[0][0] as Record<string, unknown>[]
      expect(jsonArg[0]).toEqual({ name: 'solo' })
    })

    it('works with --all-versions', async () => {
      mockListMyAgents.mockResolvedValue(multiVersionAgents)
      await program.parseAsync(['node', 'test', 'agents', '--fields', 'name,type', '--all-versions'])

      const jsonArg = mockPrintJson.mock.calls[0][0] as Record<string, unknown>[]
      expect(jsonArg).toHaveLength(6) // all versions
      for (const agent of jsonArg) {
        expect(Object.keys(agent).sort()).toEqual(['name', 'type'])
      }
    })

    it('works with --filter', async () => {
      mockListMyAgents.mockResolvedValue(multiVersionAgents)
      await program.parseAsync(['node', 'test', 'agents', '--fields', 'name', '--filter', 'scanner'])

      const jsonArg = mockPrintJson.mock.calls[0][0] as Record<string, unknown>[]
      expect(jsonArg).toHaveLength(1)
      expect(jsonArg[0]).toEqual({ name: 'scanner' })
    })

    it('can be combined with --json (--fields takes precedence)', async () => {
      mockListMyAgents.mockResolvedValue(multiVersionAgents)
      await program.parseAsync(['node', 'test', 'agents', '--json', '--fields', 'name'])

      const jsonArg = mockPrintJson.mock.calls[0][0] as Record<string, unknown>[]
      for (const agent of jsonArg) {
        expect(Object.keys(agent)).toEqual(['name'])
      }
    })
  })

  describe('--limit and --offset', () => {
    it('limits the number of results', async () => {
      mockListMyAgents.mockResolvedValue(multiVersionAgents)
      await program.parseAsync(['node', 'test', 'agents', '--json', '--limit', '2'])

      const jsonArg = mockPrintJson.mock.calls[0][0] as Agent[]
      expect(jsonArg).toHaveLength(2)
    })

    it('offsets skips items from the start', async () => {
      mockListMyAgents.mockResolvedValue(multiVersionAgents)
      await program.parseAsync(['node', 'test', 'agents', '--json', '--offset', '1'])

      const jsonArg = mockPrintJson.mock.calls[0][0] as Agent[]
      // 3 unique agents in latest-only mode, offset 1 = 2 remaining
      expect(jsonArg).toHaveLength(2)
    })

    it('combines limit and offset', async () => {
      mockListMyAgents.mockResolvedValue(multiVersionAgents)
      await program.parseAsync(['node', 'test', 'agents', '--json', '--limit', '1', '--offset', '1'])

      const jsonArg = mockPrintJson.mock.calls[0][0] as Agent[]
      expect(jsonArg).toHaveLength(1)
    })

    it('limit applies in table mode too', async () => {
      mockListMyAgents.mockResolvedValue(multiVersionAgents)
      await program.parseAsync(['node', 'test', 'agents', '--limit', '1'])

      const output = allStdout(stdoutSpy)
      // Should still show a table, but only 1 row
      expect(output).toContain('1 agent')
    })

    it('limit + fields work together', async () => {
      mockListMyAgents.mockResolvedValue(multiVersionAgents)
      await program.parseAsync(['node', 'test', 'agents', '--fields', 'name', '--limit', '2'])

      const jsonArg = mockPrintJson.mock.calls[0][0] as Record<string, unknown>[]
      expect(jsonArg).toHaveLength(2)
      for (const agent of jsonArg) {
        expect(Object.keys(agent)).toEqual(['name'])
      }
    })
  })

  describe('workspace resolution', () => {
    it('passes workspace ID to API call', async () => {
      mockLoadConfig.mockResolvedValue({ workspace: 'team-org' })
      mockResolveWorkspaceId.mockResolvedValue('ws_team123')
      mockListMyAgents.mockResolvedValue([])

      await program.parseAsync(['node', 'test', 'agents'])

      expect(mockListMyAgents).toHaveBeenCalledWith(
        expect.any(Object),
        'ws_team123'
      )
    })
  })
})
