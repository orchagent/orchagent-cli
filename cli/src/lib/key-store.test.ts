import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('fs/promises')

import fs from 'fs/promises'
import path from 'path'
import os from 'os'

import { saveServiceKey, loadServiceKeys, listAllLocalKeys, deleteLocalKey, getKeysDir } from './key-store'

const mockFs = vi.mocked(fs)
const KEYS_DIR = path.join(os.homedir(), '.orchagent', 'keys')

describe('key-store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getKeysDir', () => {
    it('returns ~/.orchagent/keys/', () => {
      expect(getKeysDir()).toBe(KEYS_DIR)
    })
  })

  describe('saveServiceKey', () => {
    it('creates directory and saves key to per-agent JSON file', async () => {
      // No existing keys
      mockFs.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      mockFs.mkdir.mockResolvedValue(undefined)
      mockFs.writeFile.mockResolvedValue(undefined)
      mockFs.chmod.mockResolvedValue(undefined)

      const savedPath = await saveServiceKey('joe', 'my-agent', 'v1', 'sk_agent_abc123xyz', 'sk_agent_abc1')

      expect(savedPath).toBe(path.join(KEYS_DIR, 'joe', 'my-agent.json'))

      // Verify directory created with 0700
      expect(mockFs.mkdir).toHaveBeenCalledWith(
        path.join(KEYS_DIR, 'joe'),
        { recursive: true, mode: 0o700 }
      )

      // Verify file written with correct content and 0600 permissions
      const writeCall = mockFs.writeFile.mock.calls[0]
      expect(writeCall[0]).toBe(path.join(KEYS_DIR, 'joe', 'my-agent.json'))
      const written = JSON.parse((writeCall[1] as string).trim())
      expect(written).toHaveLength(1)
      expect(written[0].key).toBe('sk_agent_abc123xyz')
      expect(written[0].prefix).toBe('sk_agent_abc1')
      expect(written[0].agent_version).toBe('v1')
      expect(written[0].created_at).toBeDefined()
      expect(writeCall[2]).toEqual({ mode: 0o600 })

      // Verify chmod for extra safety
      expect(mockFs.chmod).toHaveBeenCalledWith(
        path.join(KEYS_DIR, 'joe', 'my-agent.json'),
        0o600
      )
    })

    it('appends to existing keys for the same agent', async () => {
      const existingKeys = [
        { key: 'sk_agent_old', prefix: 'sk_agent_old_', agent_version: 'v1', created_at: '2026-01-01T00:00:00.000Z' }
      ]
      mockFs.readFile.mockResolvedValue(JSON.stringify(existingKeys))
      mockFs.mkdir.mockResolvedValue(undefined)
      mockFs.writeFile.mockResolvedValue(undefined)
      mockFs.chmod.mockResolvedValue(undefined)

      await saveServiceKey('joe', 'my-agent', 'v2', 'sk_agent_new123', 'sk_agent_new1')

      const writeCall = mockFs.writeFile.mock.calls[0]
      const written = JSON.parse((writeCall[1] as string).trim())
      expect(written).toHaveLength(2)
      expect(written[0].key).toBe('sk_agent_old')
      expect(written[1].key).toBe('sk_agent_new123')
      expect(written[1].agent_version).toBe('v2')
    })

    it('returns the file path where key was saved', async () => {
      mockFs.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      mockFs.mkdir.mockResolvedValue(undefined)
      mockFs.writeFile.mockResolvedValue(undefined)
      mockFs.chmod.mockResolvedValue(undefined)

      const result = await saveServiceKey('acme', 'scanner', 'v3', 'sk_agent_test', 'sk_agent_test')
      expect(result).toBe(path.join(KEYS_DIR, 'acme', 'scanner.json'))
    })
  })

  describe('loadServiceKeys', () => {
    it('returns parsed keys from file', async () => {
      const keys = [
        { key: 'sk_agent_abc', prefix: 'sk_agent_abc_', agent_version: 'v1', created_at: '2026-01-01T00:00:00.000Z' }
      ]
      mockFs.readFile.mockResolvedValue(JSON.stringify(keys))

      const result = await loadServiceKeys('joe', 'my-agent')
      expect(result).toEqual(keys)
      expect(mockFs.readFile).toHaveBeenCalledWith(
        path.join(KEYS_DIR, 'joe', 'my-agent.json'),
        'utf-8'
      )
    })

    it('returns empty array when file does not exist', async () => {
      mockFs.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

      const result = await loadServiceKeys('joe', 'nonexistent')
      expect(result).toEqual([])
    })

    it('propagates non-ENOENT errors', async () => {
      mockFs.readFile.mockRejectedValue(new Error('Permission denied'))

      await expect(loadServiceKeys('joe', 'locked-agent')).rejects.toThrow('Permission denied')
    })
  })

  describe('listAllLocalKeys', () => {
    it('returns keys grouped by org/agent', async () => {
      // Keys dir has two org dirs
      mockFs.readdir.mockResolvedValueOnce(['joe', 'acme'] as any)

      // joe dir
      mockFs.stat.mockResolvedValueOnce({ isDirectory: () => true } as any)
      mockFs.readdir.mockResolvedValueOnce(['agent-a.json', 'agent-b.json'] as any)
      mockFs.readFile
        .mockResolvedValueOnce(JSON.stringify([
          { key: 'sk1', prefix: 'sk1_', agent_version: 'v1', created_at: '2026-01-01T00:00:00.000Z' }
        ]))
        .mockResolvedValueOnce(JSON.stringify([
          { key: 'sk2', prefix: 'sk2_', agent_version: 'v2', created_at: '2026-01-02T00:00:00.000Z' }
        ]))

      // acme dir
      mockFs.stat.mockResolvedValueOnce({ isDirectory: () => true } as any)
      mockFs.readdir.mockResolvedValueOnce(['scanner.json'] as any)
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify([
        { key: 'sk3', prefix: 'sk3_', agent_version: 'v1', created_at: '2026-01-03T00:00:00.000Z' }
      ]))

      const result = await listAllLocalKeys()
      expect(result).toHaveLength(3)
      expect(result[0]).toEqual({
        org: 'joe',
        agent: 'agent-a',
        keys: [{ key: 'sk1', prefix: 'sk1_', agent_version: 'v1', created_at: '2026-01-01T00:00:00.000Z' }]
      })
      expect(result[1].agent).toBe('agent-b')
      expect(result[2]).toEqual({
        org: 'acme',
        agent: 'scanner',
        keys: [{ key: 'sk3', prefix: 'sk3_', agent_version: 'v1', created_at: '2026-01-03T00:00:00.000Z' }]
      })
    })

    it('returns empty array when keys dir does not exist', async () => {
      mockFs.readdir.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

      const result = await listAllLocalKeys()
      expect(result).toEqual([])
    })

    it('skips non-directory entries in keys dir', async () => {
      mockFs.readdir.mockResolvedValueOnce(['some-file.txt'] as any)
      mockFs.stat.mockResolvedValueOnce({ isDirectory: () => false } as any)

      const result = await listAllLocalKeys()
      expect(result).toEqual([])
    })

    it('skips non-json files in org dirs', async () => {
      mockFs.readdir.mockResolvedValueOnce(['joe'] as any)
      mockFs.stat.mockResolvedValueOnce({ isDirectory: () => true } as any)
      mockFs.readdir.mockResolvedValueOnce(['readme.txt', 'agent.json'] as any)
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify([
        { key: 'sk1', prefix: 'sk1_', agent_version: 'v1', created_at: '2026-01-01T00:00:00.000Z' }
      ]))

      const result = await listAllLocalKeys()
      expect(result).toHaveLength(1)
      expect(result[0].agent).toBe('agent')
    })

    it('skips corrupted JSON files', async () => {
      mockFs.readdir.mockResolvedValueOnce(['joe'] as any)
      mockFs.stat.mockResolvedValueOnce({ isDirectory: () => true } as any)
      mockFs.readdir.mockResolvedValueOnce(['bad.json', 'good.json'] as any)
      mockFs.readFile
        .mockResolvedValueOnce('not-valid-json{{{')
        .mockResolvedValueOnce(JSON.stringify([
          { key: 'sk1', prefix: 'sk1_', agent_version: 'v1', created_at: '2026-01-01T00:00:00.000Z' }
        ]))

      const result = await listAllLocalKeys()
      expect(result).toHaveLength(1)
      expect(result[0].agent).toBe('good')
    })

    it('skips empty key arrays', async () => {
      mockFs.readdir.mockResolvedValueOnce(['joe'] as any)
      mockFs.stat.mockResolvedValueOnce({ isDirectory: () => true } as any)
      mockFs.readdir.mockResolvedValueOnce(['empty.json'] as any)
      mockFs.readFile.mockResolvedValueOnce('[]')

      const result = await listAllLocalKeys()
      expect(result).toEqual([])
    })
  })

  describe('deleteLocalKey', () => {
    it('removes key by prefix and rewrites file', async () => {
      const keys = [
        { key: 'sk1', prefix: 'prefix_a', agent_version: 'v1', created_at: '2026-01-01T00:00:00.000Z' },
        { key: 'sk2', prefix: 'prefix_b', agent_version: 'v2', created_at: '2026-01-02T00:00:00.000Z' }
      ]
      mockFs.readFile.mockResolvedValue(JSON.stringify(keys))
      mockFs.writeFile.mockResolvedValue(undefined)
      mockFs.chmod.mockResolvedValue(undefined)

      const removed = await deleteLocalKey('joe', 'my-agent', 'prefix_a')
      expect(removed).toBe(true)

      const writeCall = mockFs.writeFile.mock.calls[0]
      const written = JSON.parse((writeCall[1] as string).trim())
      expect(written).toHaveLength(1)
      expect(written[0].prefix).toBe('prefix_b')
    })

    it('deletes file when last key is removed', async () => {
      const keys = [
        { key: 'sk1', prefix: 'only_key', agent_version: 'v1', created_at: '2026-01-01T00:00:00.000Z' }
      ]
      mockFs.readFile.mockResolvedValue(JSON.stringify(keys))
      mockFs.unlink.mockResolvedValue(undefined)

      const removed = await deleteLocalKey('joe', 'my-agent', 'only_key')
      expect(removed).toBe(true)
      expect(mockFs.unlink).toHaveBeenCalledWith(
        path.join(KEYS_DIR, 'joe', 'my-agent.json')
      )
      expect(mockFs.writeFile).not.toHaveBeenCalled()
    })

    it('returns false when prefix not found', async () => {
      const keys = [
        { key: 'sk1', prefix: 'existing', agent_version: 'v1', created_at: '2026-01-01T00:00:00.000Z' }
      ]
      mockFs.readFile.mockResolvedValue(JSON.stringify(keys))

      const removed = await deleteLocalKey('joe', 'my-agent', 'nonexistent')
      expect(removed).toBe(false)
      expect(mockFs.writeFile).not.toHaveBeenCalled()
      expect(mockFs.unlink).not.toHaveBeenCalled()
    })

    it('returns false when no keys file exists', async () => {
      mockFs.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

      const removed = await deleteLocalKey('joe', 'nonexistent', 'any')
      expect(removed).toBe(false)
    })
  })
})
