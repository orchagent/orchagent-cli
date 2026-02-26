import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { resolveJsonBody } from './json-input'

describe('resolveJsonBody', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'json-input-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  describe('plain JSON string', () => {
    it('parses valid JSON object', async () => {
      const result = await resolveJsonBody('{"key": "value"}')
      expect(result).toBe('{"key":"value"}')
    })

    it('parses valid JSON array', async () => {
      const result = await resolveJsonBody('[1, 2, 3]')
      expect(result).toBe('[1,2,3]')
    })

    it('normalizes whitespace in JSON', async () => {
      const result = await resolveJsonBody('{ "a" :  1 ,  "b" : 2 }')
      expect(result).toBe('{"a":1,"b":2}')
    })

    it('throws on invalid JSON', async () => {
      await expect(resolveJsonBody('{bad json}')).rejects.toThrow('Invalid JSON')
    })

    it('throws on empty string', async () => {
      await expect(resolveJsonBody('')).rejects.toThrow('Invalid JSON')
    })
  })

  describe('@file reference', () => {
    it('reads JSON from a file', async () => {
      const filePath = path.join(tmpDir, 'input.json')
      await fs.writeFile(filePath, '{"from": "file"}')
      const result = await resolveJsonBody(`@${filePath}`)
      expect(result).toBe('{"from":"file"}')
    })

    it('normalizes file JSON', async () => {
      const filePath = path.join(tmpDir, 'spaced.json')
      await fs.writeFile(filePath, '{\n  "key": "value"\n}')
      const result = await resolveJsonBody(`@${filePath}`)
      expect(result).toBe('{"key":"value"}')
    })

    it('throws on invalid JSON in file', async () => {
      const filePath = path.join(tmpDir, 'bad.json')
      await fs.writeFile(filePath, 'not json')
      await expect(resolveJsonBody(`@${filePath}`)).rejects.toThrow('Invalid JSON')
    })

    it('throws on nonexistent file', async () => {
      await expect(resolveJsonBody('@/nonexistent/file.json')).rejects.toThrow()
    })

    it('throws on directory path', async () => {
      await expect(resolveJsonBody(`@${tmpDir}`)).rejects.toThrow('directory')
    })

    it('throws on bare @ with no path', async () => {
      await expect(resolveJsonBody('@')).rejects.toThrow('Invalid JSON input')
    })
  })
})
