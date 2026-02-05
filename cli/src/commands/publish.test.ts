/**
 * Tests for the publish command.
 *
 * These tests cover publishing agents and skills from local files:
 * - Reading orchagent.json manifest
 * - Reading prompt.md for prompt agents
 * - Reading SKILL.md for skills
 * - Calling createAgent API with correct payload
 * - Error handling for missing files
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

// Mock modules before importing the command
vi.mock('fs/promises')
vi.mock('../lib/config')
vi.mock('../lib/api')
vi.mock('../lib/bundle')

import fs from 'fs/promises'
import { registerPublishCommand } from './publish'
import { getResolvedConfig } from '../lib/config'
import { createAgent, getOrg } from '../lib/api'
import { detectEntrypoint } from '../lib/bundle'

const mockFs = vi.mocked(fs)
const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockCreateAgent = vi.mocked(createAgent)
const mockGetOrg = vi.mocked(getOrg)
const mockDetectEntrypoint = vi.mocked(detectEntrypoint)

describe('publish command', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let originalCwd: () => string

  beforeEach(() => {
    vi.clearAllMocks()

    program = new Command()
    program.exitOverride()
    registerPublishCommand(program)

    // Mock stdout/stderr
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    // Mock config
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
    })

    // Mock getOrg
    mockGetOrg.mockResolvedValue({
      id: 'org-123',
      slug: 'test-org',
      name: 'Test Org',
    })

    // Mock createAgent
    mockCreateAgent.mockResolvedValue({ id: 'agent-123' })

    // Store original cwd
    originalCwd = process.cwd
    process.cwd = () => '/test/project'
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    process.cwd = originalCwd
    vi.restoreAllMocks()
  })

  describe('publishing from orchagent.json', () => {
    it('reads manifest and publishes prompt agent', async () => {
      const manifest = {
        name: 'my-agent',
        version: 'v1',
        type: 'prompt',
        description: 'Test agent',
        tags: ['test'],
      }

      mockFs.readFile.mockImplementation(async (filePath: unknown) => {
        const path = String(filePath)
        if (path.includes('SKILL.md')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        if (path.includes('orchagent.json')) {
          return JSON.stringify(manifest)
        }
        if (path.includes('prompt.md')) {
          return 'You are a helpful assistant.\n\nAnalyze: {{input}}'
        }
        if (path.includes('schema.json')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        throw new Error(`Unexpected file: ${path}`)
      })

      await program.parseAsync(['node', 'test', 'publish'])

      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          name: 'my-agent',
          type: 'prompt',
          description: 'Test agent',
          prompt: 'You are a helpful assistant.\n\nAnalyze: {{input}}',
          tags: ['test'],
          is_public: false,
          supported_providers: ['any'],
        })
      )
      // Note: version is NOT sent to createAgent - server auto-assigns it
    })

    it('reads schema.json when present', async () => {
      const manifest = {
        name: 'schema-agent',
        version: 'v1',
        type: 'prompt',
        description: 'Agent with schemas',
      }

      const schemas = {
        input: { type: 'object', properties: { text: { type: 'string' } } },
        output: { type: 'object', properties: { result: { type: 'string' } } },
      }

      mockFs.readFile.mockImplementation(async (filePath: unknown) => {
        const path = String(filePath)
        if (path.includes('SKILL.md')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        if (path.includes('orchagent.json')) {
          return JSON.stringify(manifest)
        }
        if (path.includes('prompt.md')) {
          return 'Process: {{text}}'
        }
        if (path.includes('schema.json')) {
          return JSON.stringify(schemas)
        }
        throw new Error(`Unexpected file: ${path}`)
      })

      await program.parseAsync(['node', 'test', 'publish'])

      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          input_schema: schemas.input,
          output_schema: schemas.output,
        })
      )
    })

    it('throws error when orchagent.json is missing', async () => {
      mockFs.readFile.mockImplementation(async (filePath: unknown) => {
        const path = String(filePath)
        if (path.includes('SKILL.md')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        if (path.includes('orchagent.json')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        throw new Error(`Unexpected file: ${path}`)
      })

      await expect(program.parseAsync(['node', 'test', 'publish'])).rejects.toThrow(
        'No orchagent.json found'
      )
    })

    it('throws error when prompt.md is missing for prompt agent', async () => {
      const manifest = {
        name: 'prompt-agent',
        version: 'v1',
        type: 'prompt',
      }

      mockFs.readFile.mockImplementation(async (filePath: unknown) => {
        const path = String(filePath)
        if (path.includes('SKILL.md')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        if (path.includes('orchagent.json')) {
          return JSON.stringify(manifest)
        }
        if (path.includes('prompt.md')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        throw new Error(`Unexpected file: ${path}`)
      })

      await expect(program.parseAsync(['node', 'test', 'publish'])).rejects.toThrow(
        'No prompt.md found'
      )
    })

    it('throws error when manifest missing required fields', async () => {
      const manifest = {
        // missing name
      }

      mockFs.readFile.mockImplementation(async (filePath: unknown) => {
        const path = String(filePath)
        if (path.includes('SKILL.md')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        if (path.includes('orchagent.json')) {
          return JSON.stringify(manifest)
        }
        throw new Error(`Unexpected file: ${path}`)
      })

      await expect(program.parseAsync(['node', 'test', 'publish'])).rejects.toThrow(
        'must have name'
      )
    })

    it('requires URL or entrypoint for code-based agents', async () => {
      const manifest = {
        name: 'code-agent',
        version: 'v1',
        type: 'code',
      }

      mockFs.readFile.mockImplementation(async (filePath: unknown) => {
        const path = String(filePath)
        if (path.includes('SKILL.md')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        if (path.includes('orchagent.json')) {
          return JSON.stringify(manifest)
        }
        if (path.includes('schema.json')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        throw new Error(`Unexpected file: ${path}`)
      })

      // Mock detectEntrypoint to return null (no entrypoint found)
      mockDetectEntrypoint.mockResolvedValue(null)

      await expect(program.parseAsync(['node', 'test', 'publish'])).rejects.toThrow(
        'Code agent requires either --url'
      )
    })

    it('publishes code agent with --url option', async () => {
      const manifest = {
        name: 'code-agent',
        version: 'v1',
        type: 'code',
        description: 'Code agent',
      }

      mockFs.readFile.mockImplementation(async (filePath: unknown) => {
        const path = String(filePath)
        if (path.includes('SKILL.md')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        if (path.includes('orchagent.json')) {
          return JSON.stringify(manifest)
        }
        if (path.includes('schema.json')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        throw new Error(`Unexpected file: ${path}`)
      })

      await program.parseAsync([
        'node',
        'test',
        'publish',
        '--url',
        'https://my-agent.run.app',
      ])

      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          name: 'code-agent',
          type: 'code',
          url: 'https://my-agent.run.app',
        })
      )
    })

    it('respects --private flag', async () => {
      const manifest = {
        name: 'private-agent',
        version: 'v1',
        type: 'prompt',
      }

      mockFs.readFile.mockImplementation(async (filePath: unknown) => {
        const path = String(filePath)
        if (path.includes('SKILL.md')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        if (path.includes('orchagent.json')) {
          return JSON.stringify(manifest)
        }
        if (path.includes('prompt.md')) {
          return 'Private prompt'
        }
        if (path.includes('schema.json')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        throw new Error(`Unexpected file: ${path}`)
      })

      await program.parseAsync(['node', 'test', 'publish', '--private'])

      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          is_public: false,
        })
      )
    })

    it('respects --public flag', async () => {
      const manifest = {
        name: 'public-agent',
        version: 'v1',
        type: 'prompt',
      }

      mockFs.readFile.mockImplementation(async (filePath: unknown) => {
        const path = String(filePath)
        if (path.includes('SKILL.md')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        if (path.includes('orchagent.json')) {
          return JSON.stringify(manifest)
        }
        if (path.includes('prompt.md')) {
          return 'Public prompt'
        }
        if (path.includes('schema.json')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        throw new Error(`Unexpected file: ${path}`)
      })

      await program.parseAsync(['node', 'test', 'publish', '--public'])

      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          is_public: true,
        })
      )
    })

    it('shows deprecation warning for --private flag', async () => {
      const manifest = {
        name: 'deprecated-flag-agent',
        version: 'v1',
        type: 'prompt',
      }

      mockFs.readFile.mockImplementation(async (filePath: unknown) => {
        const path = String(filePath)
        if (path.includes('SKILL.md')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        if (path.includes('orchagent.json')) {
          return JSON.stringify(manifest)
        }
        if (path.includes('prompt.md')) {
          return 'Private prompt'
        }
        if (path.includes('schema.json')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        throw new Error(`Unexpected file: ${path}`)
      })

      await program.parseAsync(['node', 'test', 'publish', '--private'])

      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('--private is deprecated')
      )
    })

    it('uses manifest supported_providers', async () => {
      const manifest = {
        name: 'openai-agent',
        version: 'v1',
        type: 'prompt',
        supported_providers: ['openai', 'anthropic'],
      }

      mockFs.readFile.mockImplementation(async (filePath: unknown) => {
        const path = String(filePath)
        if (path.includes('SKILL.md')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        if (path.includes('orchagent.json')) {
          return JSON.stringify(manifest)
        }
        if (path.includes('prompt.md')) {
          return 'Provider-specific prompt'
        }
        if (path.includes('schema.json')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        throw new Error(`Unexpected file: ${path}`)
      })

      await program.parseAsync(['node', 'test', 'publish'])

      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          supported_providers: ['openai', 'anthropic'],
        })
      )
    })

    it('outputs service key when returned', async () => {
      const manifest = {
        name: 'service-agent',
        version: 'v1',
        type: 'prompt',
      }

      mockCreateAgent.mockResolvedValue({
        id: 'agent-123',
        service_key: 'sk_service_abc123',
      })

      mockFs.readFile.mockImplementation(async (filePath: unknown) => {
        const path = String(filePath)
        if (path.includes('SKILL.md')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        if (path.includes('orchagent.json')) {
          return JSON.stringify(manifest)
        }
        if (path.includes('prompt.md')) {
          return 'Service prompt'
        }
        if (path.includes('schema.json')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        throw new Error(`Unexpected file: ${path}`)
      })

      await program.parseAsync(['node', 'test', 'publish'])

      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('sk_service_abc123'))
    })
  })

  describe('publishing from SKILL.md', () => {
    beforeEach(() => {
      // collectSkillFiles calls fs.readdir - mock to return empty array
      // Tests focus on publishing flow, not file collection
      mockFs.readdir.mockResolvedValue([])
    })

    it('publishes skill from SKILL.md with frontmatter', async () => {
      const skillMd = `---
name: my-skill
description: A helpful skill
metadata:
  version: v2
---
You are a helpful skill that does specific things.

Use this prompt to guide the agent.`

      mockFs.readFile.mockImplementation(async (filePath: unknown) => {
        const path = String(filePath)
        if (path.includes('SKILL.md')) {
          return skillMd
        }
        throw new Error(`Unexpected file: ${path}`)
      })

      await program.parseAsync(['node', 'test', 'publish'])

      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          name: 'my-skill',
          type: 'skill',
          description: 'A helpful skill',
          prompt: expect.stringContaining('You are a helpful skill'),
          is_public: false,
          supported_providers: ['any'],
        })
      )
      // Note: version is NOT sent to createAgent - server auto-assigns it
    })

    it('publishes skill without version (server assigns it)', async () => {
      const skillMd = `---
name: simple-skill
description: Simple skill
---
Skill content here.`

      mockFs.readFile.mockImplementation(async (filePath: unknown) => {
        const path = String(filePath)
        if (path.includes('SKILL.md')) {
          return skillMd
        }
        throw new Error(`Unexpected file: ${path}`)
      })

      await program.parseAsync(['node', 'test', 'publish'])

      // Version is NOT sent to createAgent - server auto-assigns it
      const callArgs = mockCreateAgent.mock.calls[0][1]
      expect(callArgs.name).toBe('simple-skill')
      expect(callArgs.type).toBe('skill')
      expect(callArgs).not.toHaveProperty('version')
    })

    it('respects --private flag for skills', async () => {
      const skillMd = `---
name: private-skill
description: Private skill
---
Private skill content.`

      mockFs.readFile.mockImplementation(async (filePath: unknown) => {
        const path = String(filePath)
        if (path.includes('SKILL.md')) {
          return skillMd
        }
        throw new Error(`Unexpected file: ${path}`)
      })

      await program.parseAsync(['node', 'test', 'publish', '--private'])

      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          is_public: false,
        })
      )
    })

    it('falls back to manifest if SKILL.md has no frontmatter', async () => {
      const manifest = {
        name: 'fallback-agent',
        version: 'v1',
        type: 'prompt',
      }

      mockFs.readFile.mockImplementation(async (filePath: unknown) => {
        const path = String(filePath)
        if (path.includes('SKILL.md')) {
          // No frontmatter - just content
          return 'Just some content without frontmatter'
        }
        if (path.includes('orchagent.json')) {
          return JSON.stringify(manifest)
        }
        if (path.includes('prompt.md')) {
          return 'Fallback prompt'
        }
        if (path.includes('schema.json')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        throw new Error(`Unexpected file: ${path}`)
      })

      await program.parseAsync(['node', 'test', 'publish'])

      // Should fall back to manifest
      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          name: 'fallback-agent',
          type: 'prompt',
        })
      )
    })

    it('falls back to manifest if SKILL.md missing required fields', async () => {
      const skillMd = `---
name: incomplete-skill
---
Missing description field.`

      const manifest = {
        name: 'manifest-agent',
        version: 'v1',
        type: 'prompt',
      }

      mockFs.readFile.mockImplementation(async (filePath: unknown) => {
        const path = String(filePath)
        if (path.includes('SKILL.md')) {
          return skillMd
        }
        if (path.includes('orchagent.json')) {
          return JSON.stringify(manifest)
        }
        if (path.includes('prompt.md')) {
          return 'Manifest prompt'
        }
        if (path.includes('schema.json')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        throw new Error(`Unexpected file: ${path}`)
      })

      await program.parseAsync(['node', 'test', 'publish'])

      // Should fall back to manifest since SKILL.md is incomplete
      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          name: 'manifest-agent',
          type: 'prompt',
        })
      )
    })

    it('outputs correct skill publish message', async () => {
      const skillMd = `---
name: output-skill
description: Test output
metadata:
  version: v3
---
Skill prompt.`

      // Mock server response with assigned version
      mockCreateAgent.mockResolvedValue({
        id: 'agent-123',
        agent: { id: 'agent-123', version: 'v1' },
      })

      mockFs.readFile.mockImplementation(async (filePath: unknown) => {
        const path = String(filePath)
        if (path.includes('SKILL.md')) {
          return skillMd
        }
        throw new Error(`Unexpected file: ${path}`)
      })

      await program.parseAsync(['node', 'test', 'publish'])

      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Published skill'))
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('test-org/output-skill'))
      // Version comes from server response, not from metadata in SKILL.md
    })
  })
})
