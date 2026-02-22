import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

vi.mock('../lib/config')
vi.mock('../lib/api')
vi.mock('../lib/key-store')

import { registerAgentKeysCommand } from './agent-keys'
import { getResolvedConfig, loadConfig } from '../lib/config'
import { listMyAgents, listAgentKeys, createAgentKey, deleteAgentKey, resolveWorkspaceIdForOrg } from '../lib/api'
import { saveServiceKey, loadServiceKeys } from '../lib/key-store'

const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockLoadConfig = vi.mocked(loadConfig)
const mockListMyAgents = vi.mocked(listMyAgents)
const mockListAgentKeys = vi.mocked(listAgentKeys)
const mockCreateAgentKey = vi.mocked(createAgentKey)
const mockDeleteAgentKey = vi.mocked(deleteAgentKey)
const mockResolveWorkspaceIdForOrg = vi.mocked(resolveWorkspaceIdForOrg)
const mockSaveServiceKey = vi.mocked(saveServiceKey)
const mockLoadServiceKeys = vi.mocked(loadServiceKeys)

describe('agent-keys command', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  const fakeAgent = {
    id: 'agent-uuid-123',
    name: 'my-agent',
    version: 'v2',
    type: 'prompt' as const,
    org_slug: 'joe',
    created_at: '2026-02-20T00:00:00.000Z',
  }

  beforeEach(() => {
    vi.clearAllMocks()

    program = new Command()
    program.exitOverride()
    registerAgentKeysCommand(program)

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
    })
    mockLoadConfig.mockResolvedValue({})
    mockResolveWorkspaceIdForOrg.mockResolvedValue('ws-123')
    mockListMyAgents.mockResolvedValue([fakeAgent] as any)
    mockLoadServiceKeys.mockResolvedValue([])
    mockSaveServiceKey.mockResolvedValue('/home/.orchagent/keys/joe/my-agent.json')
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  describe('list', () => {
    it('shows message when no keys exist', async () => {
      mockListAgentKeys.mockResolvedValue({ keys: [] })

      await program.parseAsync(['node', 'test', 'agent-keys', 'list', 'joe/my-agent'])

      const output = stdoutSpy.mock.calls.map((c) => c[0]).join('')
      expect(output).toContain('No service keys for my-agent')
      expect(output).toContain('agent-keys create')
    })

    it('lists keys with SAVED column', async () => {
      mockListAgentKeys.mockResolvedValue({
        keys: [
          { id: 'key-uuid-1', prefix: 'sk_agent_abc1', created_at: '2026-02-20T10:00:00Z', last_used_at: null },
          { id: 'key-uuid-2', prefix: 'sk_agent_def2', created_at: '2026-02-21T10:00:00Z', last_used_at: '2026-02-22T08:00:00Z' },
        ]
      })
      mockLoadServiceKeys.mockResolvedValue([
        { key: 'sk_agent_abc1_fullkey', prefix: 'sk_agent_abc1', agent_version: 'v1', created_at: '2026-02-20T10:00:00Z' }
      ])

      await program.parseAsync(['node', 'test', 'agent-keys', 'list', 'joe/my-agent'])

      const output = stdoutSpy.mock.calls.map((c) => c[0]).join('')
      expect(output).toContain('Service keys for my-agent')
      expect(output).toContain('ID')
      expect(output).toContain('PREFIX')
      expect(output).toContain('SAVED')
      expect(output).toContain('key-uuid-1')
      expect(output).toContain('key-uuid-2')
      expect(output).toContain('sk_agent_abc1')
      expect(output).toContain('~/.orchagent/keys/')
    })

    it('throws when not logged in', async () => {
      mockGetResolvedConfig.mockResolvedValue({
        apiKey: '',
        apiUrl: 'https://api.test.com',
      })

      await expect(
        program.parseAsync(['node', 'test', 'agent-keys', 'list', 'joe/my-agent'])
      ).rejects.toThrow('Missing API key')
    })

    it('resolves agent by name without org prefix', async () => {
      mockListAgentKeys.mockResolvedValue({ keys: [] })

      await program.parseAsync(['node', 'test', 'agent-keys', 'list', 'my-agent'])

      expect(mockListMyAgents).toHaveBeenCalled()
    })
  })

  describe('create', () => {
    it('creates key and saves locally', async () => {
      mockCreateAgentKey.mockResolvedValue({ key: 'sk_agent_newkey12345', prefix: 'sk_agent_newk' })

      await program.parseAsync(['node', 'test', 'agent-keys', 'create', 'joe/my-agent'])

      expect(mockCreateAgentKey).toHaveBeenCalledWith(
        expect.any(Object), 'agent-uuid-123'
      )

      const output = stdoutSpy.mock.calls.map((c) => c[0]).join('')
      expect(output).toContain('sk_agent_newkey12345')
      expect(output).toContain('Saved to')

      expect(mockSaveServiceKey).toHaveBeenCalledWith(
        'joe', 'my-agent', 'v2', 'sk_agent_newkey12345', 'sk_agent_newk'
      )
    })

    it('shows warning when local save fails', async () => {
      mockCreateAgentKey.mockResolvedValue({ key: 'sk_agent_abc', prefix: 'sk_agent_abc_' })
      mockSaveServiceKey.mockRejectedValue(new Error('Permission denied'))

      await program.parseAsync(['node', 'test', 'agent-keys', 'create', 'joe/my-agent'])

      const output = stdoutSpy.mock.calls.map((c) => c[0]).join('')
      expect(output).toContain('sk_agent_abc')

      const errOutput = stderrSpy.mock.calls.map((c) => c[0]).join('')
      expect(errOutput).toContain('Could not save key locally')
    })

    it('throws when agent not found', async () => {
      mockListMyAgents.mockResolvedValue([])

      await expect(
        program.parseAsync(['node', 'test', 'agent-keys', 'create', 'joe/nonexistent'])
      ).rejects.toThrow("Agent 'joe/nonexistent' not found")
    })
  })

  describe('delete', () => {
    it('deletes a key by ID', async () => {
      mockDeleteAgentKey.mockResolvedValue({ deleted: true })

      await program.parseAsync(['node', 'test', 'agent-keys', 'delete', 'joe/my-agent', 'key-uuid-1'])

      expect(mockDeleteAgentKey).toHaveBeenCalledWith(
        expect.any(Object), 'agent-uuid-123', 'key-uuid-1'
      )

      const output = stdoutSpy.mock.calls.map((c) => c[0]).join('')
      expect(output).toContain('Deleted key key-uuid-1 from my-agent')
    })
  })
})
