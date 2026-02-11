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
import { registerPublishCommand, extractTemplateVariables, deriveInputSchema } from './publish'
import { getResolvedConfig } from '../lib/config'
import { createAgent, getOrg, previewAgentVersion, uploadCodeBundle } from '../lib/api'
import { detectEntrypoint, createCodeBundle, validateBundle, previewBundle } from '../lib/bundle'

const mockFs = vi.mocked(fs)
const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockCreateAgent = vi.mocked(createAgent)
const mockGetOrg = vi.mocked(getOrg)
const mockDetectEntrypoint = vi.mocked(detectEntrypoint)
const mockPreviewAgentVersion = vi.mocked(previewAgentVersion)
const mockUploadCodeBundle = vi.mocked(uploadCodeBundle)
const mockCreateCodeBundle = vi.mocked(createCodeBundle)
const mockValidateBundle = vi.mocked(validateBundle)
const mockPreviewBundle = vi.mocked(previewBundle)

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
          type: 'agent',
          run_mode: 'on_demand',
          callable: false,
          description: 'Test agent',
          prompt: 'You are a helpful assistant.\n\nAnalyze: {{input}}',
          url: 'https://prompt-agent.internal',
          tags: ['test'],
          is_public: false,
          supported_providers: ['any'],
          // Auto-derived from {{input}} template variable (no schema.json)
          input_schema: {
            type: 'object',
            properties: {
              input: { type: 'string', description: 'Value for the input template variable' },
            },
            required: ['input'],
          },
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

    it('requires URL or entrypoint for tool-type agents', async () => {
      const manifest = {
        name: 'my-tool',
        version: 'v1',
        type: 'tool',
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
        'Tool requires either --url'
      )
    })

    it('publishes tool with --url option', async () => {
      const manifest = {
        name: 'my-tool',
        version: 'v1',
        type: 'tool',
        description: 'A tool',
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
          name: 'my-tool',
          type: 'agent',
          run_mode: 'on_demand',
          runtime: { command: 'python main.py' },
          url: 'https://my-agent.run.app',
        })
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

    it('auto-derives input schema from template variables when no schema.json', async () => {
      const manifest = {
        name: 'custom-agent',
        type: 'prompt',
        description: 'Custom agent',
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
          return 'Humanize this text: {{text}}\n\nTone: {{tone}}'
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
          input_schema: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'Value for the text template variable' },
              tone: { type: 'string', description: 'Value for the tone template variable' },
            },
            required: ['text', 'tone'],
          },
        })
      )
    })

    it('warns when schema.json properties mismatch template variables', async () => {
      const manifest = {
        name: 'mismatch-agent',
        type: 'prompt',
        description: 'Mismatch agent',
      }

      const schemas = {
        input: {
          type: 'object',
          properties: {
            input: { type: 'string', description: 'The user input' },
          },
          required: ['input'],
        },
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
          // User changed prompt to use {{text}} but didn't update schema.json
          return 'Humanize: {{text}}'
        }
        if (path.includes('schema.json')) {
          return JSON.stringify(schemas)
        }
        throw new Error(`Unexpected file: ${path}`)
      })

      await program.parseAsync(['node', 'test', 'publish'])

      // Should warn about mismatch
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('Schema mismatch')
      )
      // Should still use the explicit schema.json (user's explicit file takes precedence)
      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          input_schema: schemas.input,
        })
      )
    })

    it('does not derive schema when prompt has no template variables', async () => {
      const manifest = {
        name: 'no-vars-agent',
        type: 'prompt',
        description: 'No vars agent',
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
          return 'You are a helpful assistant. Respond to any input.'
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
          input_schema: undefined,
        })
      )
    })
  })

  describe('extractTemplateVariables', () => {
    it('extracts simple variables', () => {
      expect(extractTemplateVariables('Hello {{name}}')).toEqual(['name'])
    })

    it('extracts multiple variables', () => {
      expect(extractTemplateVariables('{{text}} with {{tone}}')).toEqual(['text', 'tone'])
    })

    it('deduplicates repeated variables', () => {
      expect(extractTemplateVariables('{{x}} and {{x}} again')).toEqual(['x'])
    })

    it('returns empty array when no variables', () => {
      expect(extractTemplateVariables('No variables here')).toEqual([])
    })

    it('ignores malformed braces', () => {
      expect(extractTemplateVariables('{single} and {{{triple}}}')).toEqual(['triple'])
    })
  })

  describe('deriveInputSchema', () => {
    it('creates schema from variable names', () => {
      const schema = deriveInputSchema(['text', 'tone'])
      expect(schema).toEqual({
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Value for the text template variable' },
          tone: { type: 'string', description: 'Value for the tone template variable' },
        },
        required: ['text', 'tone'],
      })
    })

    it('handles single variable', () => {
      const schema = deriveInputSchema(['input']) as any
      expect(Object.keys(schema.properties)).toEqual(['input'])
      expect(schema.required).toEqual(['input'])
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
          type: 'agent',
          run_mode: 'on_demand',
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
          type: 'agent',
          run_mode: 'on_demand',
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

describe('publish command - schema auto-migration', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()

    program = new Command()
    program.exitOverride()
    registerPublishCommand(program)

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
    })

    mockGetOrg.mockResolvedValue({
      id: 'org-123',
      slug: 'test-org',
      name: 'Test Org',
    } as any)

    mockCreateAgent.mockResolvedValue({
      agent: { id: 'agent-1', version: 'v1' },
    } as any)

    mockDetectEntrypoint.mockResolvedValue('main.py')

    // Mock bundling infrastructure for tool-type agents
    mockFs.mkdtemp.mockResolvedValue('/tmp/orchagent-bundle-test' as any)
    mockFs.rm.mockResolvedValue(undefined)
    mockCreateCodeBundle.mockResolvedValue({ fileCount: 1, sizeBytes: 100 } as any)
    mockValidateBundle.mockResolvedValue({ valid: true } as any)
    mockUploadCodeBundle.mockResolvedValue({
      success: true,
      code_hash: 'abc123def456',
      bundle_size_bytes: 100,
    } as any)
    mockPreviewBundle.mockResolvedValue({
      fileCount: 1,
      totalSizeBytes: 100,
      entrypoint: 'main.py',
    } as any)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
  })

  it('creates schema.json when inline schemas exist and no schema.json', async () => {
    const manifest = {
      name: 'test-agent',
      type: 'tool',
      description: 'Test',
      input_schema: { type: 'object', properties: { query: { type: 'string' } } },
      output_schema: { type: 'object', properties: { result: { type: 'string' } } },
    }

    mockFs.readFile.mockImplementation(async (filePath: any) => {
      if (String(filePath).endsWith('orchagent.json')) return JSON.stringify(manifest)
      if (String(filePath).endsWith('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (String(filePath).endsWith('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return ''
    })

    // schema.json doesn't exist
    mockFs.access.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    mockFs.writeFile.mockResolvedValue(undefined)

    await program.parseAsync(['node', 'test', 'publish'])

    // Should have written schema.json
    const writeFileCalls = mockFs.writeFile.mock.calls
    const schemaWrite = writeFileCalls.find((c: any) => String(c[0]).endsWith('schema.json'))
    expect(schemaWrite).toBeTruthy()
    if (schemaWrite) {
      const written = JSON.parse(schemaWrite[1] as string)
      expect(written.input).toEqual(manifest.input_schema)
      expect(written.output).toEqual(manifest.output_schema)
    }

    // Should have printed migration message
    const stderrOutput = stderrSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(stderrOutput).toContain('Created schema.json')
  })

  it('warns when both inline schemas and schema.json exist', async () => {
    const manifest = {
      name: 'test-agent',
      type: 'tool',
      description: 'Test',
      input_schema: { type: 'object', properties: { query: { type: 'string' } } },
    }

    mockFs.readFile.mockImplementation(async (filePath: any) => {
      if (String(filePath).endsWith('orchagent.json')) return JSON.stringify(manifest)
      if (String(filePath).endsWith('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (String(filePath).endsWith('schema.json')) return JSON.stringify({ input: { type: 'object', properties: {} } })
      return ''
    })

    // schema.json exists
    mockFs.access.mockResolvedValue(undefined)

    await program.parseAsync(['node', 'test', 'publish'])

    const stderrOutput = stderrSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(stderrOutput).toContain('inline schemas')
    expect(stderrOutput).toContain('ignored')
  })

  it('does not write schema.json in dry-run mode', async () => {
    const manifest = {
      name: 'test-agent',
      type: 'tool',
      description: 'Test',
      input_schema: { type: 'object', properties: { query: { type: 'string' } } },
    }

    mockFs.readFile.mockImplementation(async (filePath: any) => {
      if (String(filePath).endsWith('orchagent.json')) return JSON.stringify(manifest)
      if (String(filePath).endsWith('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (String(filePath).endsWith('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return ''
    })

    mockFs.access.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    // Mock previewAgentVersion for dry-run
    mockPreviewAgentVersion.mockResolvedValue({
      name: 'test-agent',
      existing_versions: [],
      next_version: 'v1',
      org_slug: 'test-org',
    })

    await program.parseAsync(['node', 'test', 'publish', '--dry-run'])

    // Should NOT have written schema.json
    const schemaWrite = mockFs.writeFile.mock.calls.find((c: any) => String(c[0]).endsWith('schema.json'))
    expect(schemaWrite).toBeUndefined()

    // Should show "Would create" message
    const stderrOutput = stderrSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(stderrOutput).toContain('Would create schema.json')
  })
})
