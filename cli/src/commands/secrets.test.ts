/**
 * Tests for the secrets command.
 *
 * Tests cover:
 * - orch secrets list (empty, with secrets, --json)
 * - orch secrets set (create, update, invalid name, restarted services)
 * - orch secrets delete (success, not found)
 * - Auth check (no API key)
 * - Workspace resolution
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

vi.mock('../lib/config')
vi.mock('../lib/api')
vi.mock('../lib/output')

import { registerSecretsCommand } from './secrets'
import { getResolvedConfig, loadConfig } from '../lib/config'
import { request } from '../lib/api'
import { printJson } from '../lib/output'

const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockLoadConfig = vi.mocked(loadConfig)
const mockRequest = vi.mocked(request)
const mockPrintJson = vi.mocked(printJson)

const mockWorkspaces = {
  workspaces: [
    { id: 'ws-1', name: 'My Workspace', slug: 'my-ws' },
    { id: 'ws-2', name: 'Team Workspace', slug: 'team-ws' },
  ],
}

const mockSecrets = {
  secrets: [
    {
      id: 'sec-1',
      name: 'STRIPE_SECRET_KEY',
      description: 'Stripe API key for payments',
      secret_type: 'custom',
      llm_provider: null,
      created_by: 'user-1',
      created_at: '2026-02-10T00:00:00Z',
      updated_at: '2026-02-10T00:00:00Z',
    },
    {
      id: 'sec-2',
      name: 'DISCORD_TOKEN',
      description: null,
      secret_type: 'custom',
      llm_provider: null,
      created_by: 'user-1',
      created_at: '2026-02-11T00:00:00Z',
      updated_at: '2026-02-12T00:00:00Z',
    },
    {
      id: 'sec-3',
      name: 'OPENAI_KEY',
      description: 'OpenAI API key',
      secret_type: 'llm_key',
      llm_provider: 'openai',
      created_by: 'user-1',
      created_at: '2026-02-12T00:00:00Z',
      updated_at: '2026-02-12T00:00:00Z',
    },
  ],
}

describe('secrets command', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()

    program = new Command()
    program.exitOverride()
    registerSecretsCommand(program)

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
    })
    mockLoadConfig.mockResolvedValue({ workspace: 'my-ws' })
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    vi.restoreAllMocks()
  })

  describe('secrets list', () => {
    it('shows empty state with helpful hint', async () => {
      mockRequest
        .mockResolvedValueOnce(mockWorkspaces as any) // resolve workspace
        .mockResolvedValueOnce({ secrets: [] } as any) // list secrets

      await program.parseAsync(['node', 'test', 'secrets', 'list'])

      const output = stdoutSpy.mock.calls.map((c) => c[0]).join('')
      expect(output).toContain('No secrets found')
      expect(output).toContain('orch secrets set')
    })

    it('lists secrets as a table', async () => {
      mockRequest
        .mockResolvedValueOnce(mockWorkspaces as any)
        .mockResolvedValueOnce(mockSecrets as any)

      await program.parseAsync(['node', 'test', 'secrets', 'list'])

      const output = stdoutSpy.mock.calls.map((c) => c[0]).join('')
      expect(output).toContain('STRIPE_SECRET_KEY')
      expect(output).toContain('DISCORD_TOKEN')
      expect(output).toContain('OPENAI_KEY')
      expect(output).toContain('3 secret(s)')
    })

    it('shows secret type and description', async () => {
      mockRequest
        .mockResolvedValueOnce(mockWorkspaces as any)
        .mockResolvedValueOnce(mockSecrets as any)

      await program.parseAsync(['node', 'test', 'secrets', 'list'])

      const output = stdoutSpy.mock.calls.map((c) => c[0]).join('')
      expect(output).toContain('custom')
      expect(output).toContain('Stripe API key for payments')
      expect(output).toContain('llm_key')
    })

    it('outputs JSON with --json flag', async () => {
      mockRequest
        .mockResolvedValueOnce(mockWorkspaces as any)
        .mockResolvedValueOnce(mockSecrets as any)

      await program.parseAsync(['node', 'test', 'secrets', 'list', '--json'])

      expect(mockPrintJson).toHaveBeenCalledWith(mockSecrets)
    })

    it('uses --workspace flag to select workspace', async () => {
      mockRequest
        .mockResolvedValueOnce(mockWorkspaces as any)
        .mockResolvedValueOnce({ secrets: [] } as any)

      await program.parseAsync(['node', 'test', 'secrets', 'list', '--workspace', 'team-ws'])

      // Second call should use ws-2 (team-ws)
      expect(mockRequest).toHaveBeenNthCalledWith(
        2,
        expect.any(Object),
        'GET',
        '/workspaces/ws-2/secrets'
      )
    })

    it('throws when not logged in', async () => {
      mockGetResolvedConfig.mockResolvedValue({
        apiKey: '',
        apiUrl: 'https://api.test.com',
      })

      await expect(
        program.parseAsync(['node', 'test', 'secrets', 'list'])
      ).rejects.toThrow('Missing API key')
    })

    it('lists available workspaces when no workspace configured and multiple exist', async () => {
      mockLoadConfig.mockResolvedValue({})
      mockRequest.mockResolvedValueOnce(mockWorkspaces as any)

      await expect(
        program.parseAsync(['node', 'test', 'secrets', 'list'])
      ).rejects.toThrow('Multiple workspaces available')
    })

    it('throws when workspace not found', async () => {
      mockLoadConfig.mockResolvedValue({ workspace: 'nonexistent' })
      mockRequest.mockResolvedValueOnce(mockWorkspaces as any)

      await expect(
        program.parseAsync(['node', 'test', 'secrets', 'list'])
      ).rejects.toThrow("Workspace 'nonexistent' not found")
    })
  })

  describe('secrets set', () => {
    it('creates a new secret', async () => {
      mockRequest
        .mockResolvedValueOnce(mockWorkspaces as any)       // resolve workspace
        .mockResolvedValueOnce({ secrets: [] } as any)       // findSecretByName (list)
        .mockResolvedValueOnce({                              // create
          secret: {
            id: 'sec-new',
            name: 'NEW_SECRET',
            description: null,
            secret_type: 'custom',
            llm_provider: null,
            created_by: 'user-1',
            created_at: '2026-02-16T00:00:00Z',
            updated_at: '2026-02-16T00:00:00Z',
          },
        } as any)

      await program.parseAsync(['node', 'test', 'secrets', 'set', 'NEW_SECRET', 'my-value'])

      const output = stdoutSpy.mock.calls.map((c) => c[0]).join('')
      expect(output).toContain('Created secret')
      expect(output).toContain('NEW_SECRET')

      // Verify the POST body
      expect(mockRequest).toHaveBeenNthCalledWith(
        3,
        expect.any(Object),
        'POST',
        '/workspaces/ws-1/secrets',
        {
          body: JSON.stringify({ name: 'NEW_SECRET', value: 'my-value', secret_type: 'custom' }),
          headers: { 'Content-Type': 'application/json' },
        }
      )
    })

    it('creates with description', async () => {
      mockRequest
        .mockResolvedValueOnce(mockWorkspaces as any)
        .mockResolvedValueOnce({ secrets: [] } as any)
        .mockResolvedValueOnce({ secret: { id: 'sec-new', name: 'MY_KEY' } } as any)

      await program.parseAsync([
        'node', 'test', 'secrets', 'set', 'MY_KEY', 'val',
        '--description', 'My API key',
      ])

      expect(mockRequest).toHaveBeenNthCalledWith(
        3,
        expect.any(Object),
        'POST',
        '/workspaces/ws-1/secrets',
        {
          body: JSON.stringify({ name: 'MY_KEY', value: 'val', secret_type: 'custom', description: 'My API key' }),
          headers: { 'Content-Type': 'application/json' },
        }
      )
    })

    it('auto-classifies ANTHROPIC_API_KEY as llm_key with provider (B-2)', async () => {
      mockRequest
        .mockResolvedValueOnce(mockWorkspaces as any)
        .mockResolvedValueOnce({ secrets: [] } as any) // not existing
        .mockResolvedValueOnce({ secret: { id: 'sec-new', name: 'ANTHROPIC_API_KEY' } } as any)

      await program.parseAsync(['node', 'test', 'secrets', 'set', 'ANTHROPIC_API_KEY', 'sk-ant-xxx'])

      expect(mockRequest).toHaveBeenNthCalledWith(
        3,
        expect.any(Object),
        'POST',
        '/workspaces/ws-1/secrets',
        {
          body: JSON.stringify({
            name: 'ANTHROPIC_API_KEY',
            value: 'sk-ant-xxx',
            secret_type: 'llm_key',
            llm_provider: 'anthropic',
          }),
          headers: { 'Content-Type': 'application/json' },
        }
      )
    })

    it('auto-classifies OPENAI_API_KEY as llm_key with provider (B-2)', async () => {
      mockRequest
        .mockResolvedValueOnce(mockWorkspaces as any)
        .mockResolvedValueOnce({ secrets: [] } as any)
        .mockResolvedValueOnce({ secret: { id: 'sec-new', name: 'OPENAI_API_KEY' } } as any)

      await program.parseAsync(['node', 'test', 'secrets', 'set', 'OPENAI_API_KEY', 'sk-xxx'])

      expect(mockRequest).toHaveBeenNthCalledWith(
        3,
        expect.any(Object),
        'POST',
        '/workspaces/ws-1/secrets',
        {
          body: JSON.stringify({
            name: 'OPENAI_API_KEY',
            value: 'sk-xxx',
            secret_type: 'llm_key',
            llm_provider: 'openai',
          }),
          headers: { 'Content-Type': 'application/json' },
        }
      )
    })

    it('keeps custom type for non-LLM key names (B-2)', async () => {
      mockRequest
        .mockResolvedValueOnce(mockWorkspaces as any)
        .mockResolvedValueOnce({ secrets: [] } as any)
        .mockResolvedValueOnce({ secret: { id: 'sec-new', name: 'STRIPE_KEY' } } as any)

      await program.parseAsync(['node', 'test', 'secrets', 'set', 'STRIPE_KEY', 'sk-stripe'])

      expect(mockRequest).toHaveBeenNthCalledWith(
        3,
        expect.any(Object),
        'POST',
        '/workspaces/ws-1/secrets',
        {
          body: JSON.stringify({
            name: 'STRIPE_KEY',
            value: 'sk-stripe',
            secret_type: 'custom',
          }),
          headers: { 'Content-Type': 'application/json' },
        }
      )
    })

    it('updates an existing secret', async () => {
      mockRequest
        .mockResolvedValueOnce(mockWorkspaces as any)
        .mockResolvedValueOnce(mockSecrets as any) // findSecretByName finds STRIPE_SECRET_KEY
        .mockResolvedValueOnce({ updated: true } as any)

      await program.parseAsync(['node', 'test', 'secrets', 'set', 'STRIPE_SECRET_KEY', 'new-value'])

      const output = stdoutSpy.mock.calls.map((c) => c[0]).join('')
      expect(output).toContain('Updated secret')
      expect(output).toContain('STRIPE_SECRET_KEY')

      expect(mockRequest).toHaveBeenNthCalledWith(
        3,
        expect.any(Object),
        'PATCH',
        '/workspaces/ws-1/secrets/sec-1',
        {
          body: JSON.stringify({ value: 'new-value' }),
          headers: { 'Content-Type': 'application/json' },
        }
      )
    })

    it('updates with description', async () => {
      mockRequest
        .mockResolvedValueOnce(mockWorkspaces as any)
        .mockResolvedValueOnce(mockSecrets as any)
        .mockResolvedValueOnce({ updated: true } as any)

      await program.parseAsync([
        'node', 'test', 'secrets', 'set', 'STRIPE_SECRET_KEY', 'new-val',
        '--description', 'Updated key',
      ])

      expect(mockRequest).toHaveBeenNthCalledWith(
        3,
        expect.any(Object),
        'PATCH',
        '/workspaces/ws-1/secrets/sec-1',
        {
          body: JSON.stringify({ value: 'new-val', description: 'Updated key' }),
          headers: { 'Content-Type': 'application/json' },
        }
      )
    })

    it('shows restarted services on update', async () => {
      mockRequest
        .mockResolvedValueOnce(mockWorkspaces as any)
        .mockResolvedValueOnce(mockSecrets as any)
        .mockResolvedValueOnce({
          updated: true,
          restarted_services: [{ id: 'svc-1', service_name: 'discord-bot' }],
        } as any)

      await program.parseAsync(['node', 'test', 'secrets', 'set', 'STRIPE_SECRET_KEY', 'new-val'])

      const output = stdoutSpy.mock.calls.map((c) => c[0]).join('')
      expect(output).toContain('Restarted')
      expect(output).toContain('discord-bot')
    })

    it('rejects invalid secret name (lowercase)', async () => {
      await expect(
        program.parseAsync(['node', 'test', 'secrets', 'set', 'my_secret', 'value'])
      ).rejects.toThrow('Invalid secret name')
    })

    it('rejects invalid secret name (starts with number)', async () => {
      await expect(
        program.parseAsync(['node', 'test', 'secrets', 'set', '1SECRET', 'value'])
      ).rejects.toThrow('Invalid secret name')
    })

    it('rejects invalid secret name (contains dash)', async () => {
      await expect(
        program.parseAsync(['node', 'test', 'secrets', 'set', 'MY-SECRET', 'value'])
      ).rejects.toThrow('Invalid secret name')
    })

    it('accepts valid secret names', async () => {
      mockRequest
        .mockResolvedValueOnce(mockWorkspaces as any)
        .mockResolvedValueOnce({ secrets: [] } as any)
        .mockResolvedValueOnce({ secret: { id: 'sec-new', name: 'A' } } as any)

      // Single letter
      await program.parseAsync(['node', 'test', 'secrets', 'set', 'A', 'val'])

      const output = stdoutSpy.mock.calls.map((c) => c[0]).join('')
      expect(output).toContain('Created secret')
    })

    it('throws when not logged in', async () => {
      mockGetResolvedConfig.mockResolvedValue({
        apiKey: '',
        apiUrl: 'https://api.test.com',
      })

      await expect(
        program.parseAsync(['node', 'test', 'secrets', 'set', 'MY_KEY', 'val'])
      ).rejects.toThrow('Missing API key')
    })
  })

  describe('secrets delete', () => {
    it('deletes a secret by name', async () => {
      mockRequest
        .mockResolvedValueOnce(mockWorkspaces as any)
        .mockResolvedValueOnce(mockSecrets as any) // findSecretByName
        .mockResolvedValueOnce({ deleted: true } as any)

      await program.parseAsync(['node', 'test', 'secrets', 'delete', 'STRIPE_SECRET_KEY'])

      const output = stdoutSpy.mock.calls.map((c) => c[0]).join('')
      expect(output).toContain('Deleted secret')
      expect(output).toContain('STRIPE_SECRET_KEY')

      expect(mockRequest).toHaveBeenNthCalledWith(
        3,
        expect.any(Object),
        'DELETE',
        '/workspaces/ws-1/secrets/sec-1'
      )
    })

    it('throws when secret not found', async () => {
      mockRequest
        .mockResolvedValueOnce(mockWorkspaces as any)
        .mockResolvedValueOnce({ secrets: [] } as any)

      await expect(
        program.parseAsync(['node', 'test', 'secrets', 'delete', 'NONEXISTENT'])
      ).rejects.toThrow("Secret 'NONEXISTENT' not found")
    })

    it('suggests orch secrets list when secret not found', async () => {
      mockRequest
        .mockResolvedValueOnce(mockWorkspaces as any)
        .mockResolvedValueOnce({ secrets: [] } as any)

      await expect(
        program.parseAsync(['node', 'test', 'secrets', 'delete', 'NONEXISTENT'])
      ).rejects.toThrow('orch secrets list')
    })

    it('throws when not logged in', async () => {
      mockGetResolvedConfig.mockResolvedValue({
        apiKey: '',
        apiUrl: 'https://api.test.com',
      })

      await expect(
        program.parseAsync(['node', 'test', 'secrets', 'delete', 'MY_KEY'])
      ).rejects.toThrow('Missing API key')
    })

    it('uses --workspace flag', async () => {
      mockRequest
        .mockResolvedValueOnce(mockWorkspaces as any)
        .mockResolvedValueOnce(mockSecrets as any)
        .mockResolvedValueOnce({ deleted: true } as any)

      await program.parseAsync([
        'node', 'test', 'secrets', 'delete', 'STRIPE_SECRET_KEY',
        '--workspace', 'team-ws',
      ])

      // findSecretByName should use ws-2
      expect(mockRequest).toHaveBeenNthCalledWith(
        2,
        expect.any(Object),
        'GET',
        '/workspaces/ws-2/secrets'
      )
      // delete should use ws-2
      expect(mockRequest).toHaveBeenNthCalledWith(
        3,
        expect.any(Object),
        'DELETE',
        '/workspaces/ws-2/secrets/sec-1'
      )
    })
  })
})
