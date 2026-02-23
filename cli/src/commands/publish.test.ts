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
vi.mock('../lib/key-store')

import fs from 'fs/promises'
import { registerPublishCommand, extractTemplateVariables, deriveInputSchema, scanUndeclaredEnvVars, scanReservedPort, checkDependencies, detectSdkCompatible } from './publish'
import { CliError } from '../lib/errors'
import { getResolvedConfig, loadConfig } from '../lib/config'
import { createAgent, getOrg, previewAgentVersion, validateAgentPublish, uploadCodeBundle, request, getPublicAgent } from '../lib/api'
import { detectEntrypoint, createCodeBundle, validateBundle, previewBundle } from '../lib/bundle'
import { saveServiceKey } from '../lib/key-store'

const mockFs = vi.mocked(fs)
const mockSaveServiceKey = vi.mocked(saveServiceKey)
const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockLoadConfig = vi.mocked(loadConfig)
const mockRequest = vi.mocked(request)
const mockCreateAgent = vi.mocked(createAgent)
const mockGetOrg = vi.mocked(getOrg)
const mockGetPublicAgent = vi.mocked(getPublicAgent)
const mockDetectEntrypoint = vi.mocked(detectEntrypoint)
const mockPreviewAgentVersion = vi.mocked(previewAgentVersion)
const mockValidateAgentPublish = vi.mocked(validateAgentPublish)
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

    // Mock config (no workspace by default)
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
    })
    mockLoadConfig.mockResolvedValue({})

    // Mock getOrg
    mockGetOrg.mockResolvedValue({
      id: 'org-123',
      slug: 'test-org',
      name: 'Test Org',
    })

    // Mock createAgent
    mockCreateAgent.mockResolvedValue({ id: 'agent-123' })

    // Mock validateAgentPublish (used by dry-run server validation, BUG-11)
    mockValidateAgentPublish.mockResolvedValue({
      valid: true,
      errors: [],
      warnings: [],
    })

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
          run_mode: 'on_demand',
          callable: true,
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
        }),
        undefined
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
        }),
        undefined
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
        // Return ENOENT for any other file (prompt.md, schema.json, etc.)
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
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
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })

      await expect(program.parseAsync(['node', 'test', 'publish'])).rejects.toThrow(
        'must have name'
      )
    })

    it('throws CliError with non-zero exit code when name is missing (BUG-14)', async () => {
      const manifest = {}

      mockFs.readFile.mockImplementation(async (filePath: unknown) => {
        const path = String(filePath)
        if (path.includes('SKILL.md')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        if (path.includes('orchagent.json')) {
          return JSON.stringify(manifest)
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })

      try {
        await program.parseAsync(['node', 'test', 'publish'])
        expect.unreachable('Expected CliError to be thrown')
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(CliError)
        const cliErr = err as CliError
        expect(cliErr.exitCode).not.toBe(0)
        expect(cliErr.message).toContain('must have name')
      }
    })

    it('throws CliError with non-zero exit code for all name validation failures (BUG-14)', async () => {
      const validationCases = [
        { manifest: { name: '' }, expectedMessage: 'must have name' },
        { manifest: { name: 'x' }, expectedMessage: '2-50 characters' },
        { manifest: { name: 'My-Agent' }, expectedMessage: 'must be lowercase' },
        { manifest: { name: 'bad--name' }, expectedMessage: 'consecutive hyphens' },
      ]

      for (const { manifest, expectedMessage } of validationCases) {
        mockFs.readFile.mockImplementation(async (filePath: unknown) => {
          const path = String(filePath)
          if (path.includes('SKILL.md')) {
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
          }
          if (path.includes('orchagent.json')) {
            return JSON.stringify(manifest)
          }
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        })

        const freshProgram = new Command()
        freshProgram.exitOverride()
        registerPublishCommand(freshProgram)

        try {
          await freshProgram.parseAsync(['node', 'test', 'publish'])
          expect.unreachable(`Expected CliError for: ${JSON.stringify(manifest)}`)
        } catch (err: unknown) {
          expect(err).toBeInstanceOf(CliError)
          const cliErr = err as CliError
          expect(cliErr.exitCode).not.toBe(0)
          expect(cliErr.message).toContain(expectedMessage)
        }
      }
    })

    it('requires URL or entrypoint for tool-type agents', async () => {
      const manifest = {
        name: 'my-tool',
        version: 'v1',
        type: 'tool',
        required_secrets: [],
      }

      mockFs.readFile.mockImplementation(async (filePath: unknown) => {
        const path = String(filePath)
        if (path.includes('SKILL.md')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        if (path.includes('orchagent.json')) {
          return JSON.stringify(manifest)
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
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
        required_secrets: ['MY_API_KEY'],
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
          type: 'tool',
          run_mode: 'on_demand',
          runtime: { command: 'python main.py' },
          url: 'https://my-agent.run.app',
        }),
        undefined
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
        }),
        undefined
      )
    })

    it('forwards timeout_seconds from manifest', async () => {
      const manifest = {
        name: 'timeout-agent',
        version: 'v1',
        type: 'prompt',
        timeout_seconds: 5,
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
          return 'Handle input: {{input}}'
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
          timeout_seconds: 5,
        }),
        undefined
      )
    })

    it('rejects invalid timeout_seconds values', async () => {
      const manifest = {
        name: 'invalid-timeout-agent',
        version: 'v1',
        type: 'prompt',
        timeout_seconds: 0,
      }

      mockFs.readFile.mockImplementation(async (filePath: unknown) => {
        const path = String(filePath)
        if (path.includes('SKILL.md')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        if (path.includes('orchagent.json')) {
          return JSON.stringify(manifest)
        }
        // Return ENOENT for other files to support batched validation
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })

      await expect(program.parseAsync(['node', 'test', 'publish'])).rejects.toThrow(
        'timeout_seconds must be a positive integer'
      )
      expect(mockCreateAgent).not.toHaveBeenCalled()
    })

    it('outputs service key and saves it locally when returned', async () => {
      const manifest = {
        name: 'service-agent',
        version: 'v1',
        type: 'prompt',
      }

      mockCreateAgent.mockResolvedValue({
        id: 'agent-123',
        service_key: 'sk_service_abc123',
      })
      mockSaveServiceKey.mockResolvedValue('/home/.orchagent/keys/test-org/service-agent.json')

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
      expect(mockSaveServiceKey).toHaveBeenCalledWith(
        'test-org', 'service-agent', expect.any(String),
        'sk_service_abc123', 'sk_service_a'
      )
      // Shows saved path
      const allOutput = stdoutSpy.mock.calls.map((c: any) => c[0]).join('')
      expect(allOutput).toContain('Saved to')
      expect(allOutput).toContain('Retrieve later')
    })

    it('shows warning when key save fails but still displays the key', async () => {
      const manifest = {
        name: 'service-agent',
        version: 'v1',
        type: 'prompt',
      }

      mockCreateAgent.mockResolvedValue({
        id: 'agent-123',
        service_key: 'sk_service_abc123',
      })
      mockSaveServiceKey.mockRejectedValue(new Error('Permission denied'))

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

      // Key is still displayed
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('sk_service_abc123'))
      // Warning is shown
      const allOutput = stdoutSpy.mock.calls.map((c: any) => c[0]).join('')
      expect(allOutput).toContain('Could not save key locally')
    })

    it('shows orch run command with schema field names after publish', async () => {
      const manifest = {
        name: 'run-hint-agent',
        type: 'prompt',
        description: 'Test run hint',
      }

      const schemas = {
        input: { type: 'object', properties: { text: { type: 'string' }, tone: { type: 'string' } } },
        output: { type: 'object', properties: { result: { type: 'string' } } },
      }

      mockFs.readFile.mockImplementation(async (filePath: unknown) => {
        const path = String(filePath)
        if (path.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        if (path.includes('orchagent.json')) return JSON.stringify(manifest)
        if (path.includes('prompt.md')) return 'Rewrite {{text}} in {{tone}} tone'
        if (path.includes('schema.json')) return JSON.stringify(schemas)
        throw new Error(`Unexpected file: ${path}`)
      })

      await program.parseAsync(['node', 'test', 'publish'])

      const allOutput = stdoutSpy.mock.calls.map((c: any) => c[0]).join('')
      expect(allOutput).toContain('Run with CLI:')
      expect(allOutput).toContain('orch run test-org/run-hint-agent')
      expect(allOutput).toContain('"text": "..."')
      expect(allOutput).toContain('"tone": "..."')
    })

    it('shows generic run hint when no input schema', async () => {
      const manifest = {
        name: 'no-schema-agent',
        type: 'prompt',
        description: 'No schema',
      }

      mockFs.readFile.mockImplementation(async (filePath: unknown) => {
        const path = String(filePath)
        if (path.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        if (path.includes('orchagent.json')) return JSON.stringify(manifest)
        if (path.includes('prompt.md')) return 'You are a helpful assistant.'
        if (path.includes('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        throw new Error(`Unexpected file: ${path}`)
      })

      await program.parseAsync(['node', 'test', 'publish'])

      const allOutput = stdoutSpy.mock.calls.map((c: any) => c[0]).join('')
      expect(allOutput).toContain('Run with CLI:')
      expect(allOutput).toContain('orch run test-org/no-schema-agent')
      expect(allOutput).toContain('"input": "..."')
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
        }),
        undefined
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
        }),
        undefined
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
        }),
        undefined
      )
    })

    describe('execution_engine inference', () => {
      it('infers managed_loop for type=agent even without custom_tools or max_turns', async () => {
        const manifest = {
          name: 'plain-agent',
          version: 'v1',
          type: 'agent',
          description: 'Agent with no custom_tools or max_turns',
          required_secrets: [],
        }

        mockFs.readFile.mockImplementation(async (filePath: unknown) => {
          const path = String(filePath)
          if (path.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
          if (path.includes('orchagent.json')) return JSON.stringify(manifest)
          if (path.includes('prompt.md')) return 'You are an agent.'
          if (path.includes('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
          throw new Error(`Unexpected file: ${path}`)
        })

        await program.parseAsync(['node', 'test', 'publish'])

        // Should send loop config with default max_turns (managed_loop behavior)
        expect(mockCreateAgent).toHaveBeenCalledWith(
          expect.any(Object),
          expect.objectContaining({
            type: 'agent',
            loop: expect.objectContaining({ max_turns: 25 }),
          }),
          undefined
        )
        // Should display managed_loop in output
        const allOutput = stdoutSpy.mock.calls.map((c: any) => c[0]).join('')
        expect(allOutput).toContain('Execution engine: managed_loop')
      })

      it('infers managed_loop for type=agent with top-level custom_tools', async () => {
        const manifest = {
          name: 'tools-agent',
          version: 'v1',
          type: 'agent',
          description: 'Agent with custom_tools',
          required_secrets: [],
          custom_tools: [
            { name: 'get_stats', description: 'Get stats', command: 'joe/stats-tool@v1' },
          ],
        }

        mockFs.readFile.mockImplementation(async (filePath: unknown) => {
          const path = String(filePath)
          if (path.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
          if (path.includes('orchagent.json')) return JSON.stringify(manifest)
          if (path.includes('prompt.md')) return 'You are an orchestrator.'
          if (path.includes('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
          throw new Error(`Unexpected file: ${path}`)
        })

        await program.parseAsync(['node', 'test', 'publish'])

        expect(mockCreateAgent).toHaveBeenCalledWith(
          expect.any(Object),
          expect.objectContaining({
            type: 'agent',
            loop: expect.objectContaining({
              custom_tools: manifest.custom_tools,
            }),
          }),
          undefined
        )
      })

      it('infers managed_loop for type=agent with loop.custom_tools', async () => {
        const manifest = {
          name: 'loop-agent',
          version: 'v1',
          type: 'agent',
          description: 'Agent with loop config',
          required_secrets: [],
          loop: {
            custom_tools: [
              { name: 'scan', description: 'Scan code', command: 'joe/scanner@v1' },
            ],
            max_turns: 10,
          },
        }

        mockFs.readFile.mockImplementation(async (filePath: unknown) => {
          const path = String(filePath)
          if (path.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
          if (path.includes('orchagent.json')) return JSON.stringify(manifest)
          if (path.includes('prompt.md')) return 'You are a scanner.'
          if (path.includes('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
          throw new Error(`Unexpected file: ${path}`)
        })

        await program.parseAsync(['node', 'test', 'publish'])

        expect(mockCreateAgent).toHaveBeenCalledWith(
          expect.any(Object),
          expect.objectContaining({
            type: 'agent',
            loop: expect.objectContaining({ max_turns: 10 }),
          }),
          undefined
        )
      })

      it('infers direct_llm for type=prompt', async () => {
        const manifest = {
          name: 'prompt-agent',
          version: 'v1',
          type: 'prompt',
          description: 'A prompt agent',
        }

        mockFs.readFile.mockImplementation(async (filePath: unknown) => {
          const path = String(filePath)
          if (path.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
          if (path.includes('orchagent.json')) return JSON.stringify(manifest)
          if (path.includes('prompt.md')) return 'You are helpful.'
          if (path.includes('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
          throw new Error(`Unexpected file: ${path}`)
        })

        await program.parseAsync(['node', 'test', 'publish'])

        // Should NOT have loop config
        expect(mockCreateAgent).toHaveBeenCalledWith(
          expect.any(Object),
          expect.not.objectContaining({ loop: expect.anything() }),
          undefined
        )
        const allOutput = stdoutSpy.mock.calls.map((c: any) => c[0]).join('')
        expect(allOutput).toContain('Execution engine: direct_llm')
      })
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
        }),
        undefined
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

    it('sends callable=false for skills (BUG-001 regression)', async () => {
      const skillMd = `---
name: bug-001-skill
description: Reproduces BUG-001 callable regression
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

      const callArgs = mockCreateAgent.mock.calls[0][1]
      expect(callArgs.type).toBe('skill')
      // BUG-001: CLI was not sending callable field for skills.
      // Gateway defaults callable to true, then rejects skills with callable=true.
      expect(callArgs.callable).toBe(false)
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
          run_mode: 'on_demand',
        }),
        undefined
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
          run_mode: 'on_demand',
        }),
        undefined
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

      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Published'))
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('test-org/output-skill'))
      // Version comes from server response, not from metadata in SKILL.md
    })
  })

  describe('workspace context (F-5)', () => {
    it('publishes to workspace when workspace is set in config', async () => {
      const manifest = {
        name: 'team-agent',
        type: 'prompt',
        description: 'Team agent',
      }

      // Config has workspace set
      mockLoadConfig.mockResolvedValue({ workspace: 'team-ws' })

      // Mock workspace resolution
      mockRequest.mockResolvedValue({
        workspaces: [
          { id: 'ws-123', slug: 'team-ws', name: 'Team Workspace' },
        ],
      } as any)

      // getOrg returns workspace org when workspace header is sent
      mockGetOrg.mockResolvedValue({
        id: 'ws-123',
        slug: 'team-ws',
        name: 'Team Workspace',
      })

      mockFs.readFile.mockImplementation(async (filePath: unknown) => {
        const p = String(filePath)
        if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        if (p.includes('orchagent.json')) return JSON.stringify(manifest)
        if (p.includes('prompt.md')) return 'Hello {{name}}'
        if (p.includes('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        throw new Error(`Unexpected file: ${p}`)
      })

      await program.parseAsync(['node', 'test', 'publish'])

      // Should pass workspace ID to createAgent
      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ name: 'team-agent' }),
        'ws-123'
      )

      // Should pass workspace ID to getOrg
      expect(mockGetOrg).toHaveBeenCalledWith(expect.any(Object), 'ws-123')

      // Output should show workspace and correct org slug
      const allOutput = stdoutSpy.mock.calls.map((c: any) => c[0]).join('')
      expect(allOutput).toContain('Workspace: team-ws')
      expect(allOutput).toContain('team-ws/team-agent')
    })

    it('publishes to personal org when no workspace is set', async () => {
      const manifest = {
        name: 'personal-agent',
        type: 'prompt',
        description: 'Personal agent',
      }

      mockLoadConfig.mockResolvedValue({})

      mockFs.readFile.mockImplementation(async (filePath: unknown) => {
        const p = String(filePath)
        if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        if (p.includes('orchagent.json')) return JSON.stringify(manifest)
        if (p.includes('prompt.md')) return 'Hello'
        if (p.includes('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        throw new Error(`Unexpected file: ${p}`)
      })

      await program.parseAsync(['node', 'test', 'publish'])

      // Should NOT call request for workspace resolution
      expect(mockRequest).not.toHaveBeenCalled()

      // Should pass undefined workspace to createAgent
      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ name: 'personal-agent' }),
        undefined
      )

      // Output should NOT show workspace line
      const allOutput = stdoutSpy.mock.calls.map((c: any) => c[0]).join('')
      expect(allOutput).not.toContain('Workspace:')
      expect(allOutput).toContain('test-org/personal-agent')
    })

    it('throws error when configured workspace is not found', async () => {
      mockLoadConfig.mockResolvedValue({ workspace: 'deleted-ws' })
      mockRequest.mockResolvedValue({ workspaces: [] } as any)

      mockFs.readFile.mockImplementation(async (filePath: unknown) => {
        const p = String(filePath)
        if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        if (p.includes('orchagent.json')) return JSON.stringify({ name: 'agent', type: 'prompt' })
        if (p.includes('prompt.md')) return 'Hello'
        if (p.includes('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        throw new Error(`Unexpected file: ${p}`)
      })

      await expect(program.parseAsync(['node', 'test', 'publish'])).rejects.toThrow(
        "Workspace 'deleted-ws' not found"
      )
    })

    it('publishes skill to workspace when workspace is set', async () => {
      const skillMd = `---
name: team-skill
description: A team skill
---
Skill content.`

      mockLoadConfig.mockResolvedValue({ workspace: 'team-ws' })
      mockRequest.mockResolvedValue({
        workspaces: [{ id: 'ws-123', slug: 'team-ws', name: 'Team Workspace' }],
      } as any)
      mockGetOrg.mockResolvedValue({ id: 'ws-123', slug: 'team-ws', name: 'Team Workspace' })
      mockFs.readdir.mockResolvedValue([])

      mockFs.readFile.mockImplementation(async (filePath: unknown) => {
        const p = String(filePath)
        if (p.includes('SKILL.md')) return skillMd
        throw new Error(`Unexpected file: ${p}`)
      })

      await program.parseAsync(['node', 'test', 'publish'])

      // Skill should be created with workspace context
      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ name: 'team-skill', type: 'skill' }),
        'ws-123'
      )

      const allOutput = stdoutSpy.mock.calls.map((c: any) => c[0]).join('')
      expect(allOutput).toContain('Workspace: team-ws')
      expect(allOutput).toContain('team-ws/team-skill')
    })

    it('passes workspace ID to uploadCodeBundle for tool-type agents', async () => {
      const manifest = {
        name: 'team-tool',
        type: 'tool',
        description: 'Team tool agent',
        required_secrets: ['MY_API_KEY'],
      }

      mockLoadConfig.mockResolvedValue({ workspace: 'team-ws' })
      mockRequest.mockResolvedValue({
        workspaces: [{ id: 'ws-123', slug: 'team-ws', name: 'Team Workspace' }],
      } as any)
      mockGetOrg.mockResolvedValue({ id: 'ws-123', slug: 'team-ws', name: 'Team Workspace' })
      mockCreateAgent.mockResolvedValue({
        agent: { id: 'agent-1', version: 'v1' },
      } as any)

      mockDetectEntrypoint.mockResolvedValue('main.py')
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

      mockFs.readFile.mockImplementation(async (filePath: unknown) => {
        const p = String(filePath)
        if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        if (p.includes('orchagent.json')) return JSON.stringify(manifest)
        if (p.includes('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return ''
      })

      await program.parseAsync(['node', 'test', 'publish'])

      // Should pass workspace ID to createAgent
      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ name: 'team-tool', type: 'tool' }),
        'ws-123'
      )

      // Should pass workspace ID to uploadCodeBundle
      expect(mockUploadCodeBundle).toHaveBeenCalledWith(
        expect.any(Object),
        'agent-1',
        expect.stringContaining('orchagent-bundle'),
        'main.py',
        'ws-123'
      )
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
    mockLoadConfig.mockResolvedValue({})

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
      required_secrets: ['MY_API_KEY'],
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
      required_secrets: ['MY_API_KEY'],
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
      required_secrets: [],
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

  it('shows required_secrets with setup instructions after publish (F-18)', async () => {
    const manifest = {
      name: 'secret-agent',
      type: 'agent',
      description: 'Agent with secrets',
      required_secrets: ['DISCORD_WEBHOOK_URL', 'GITHUB_TOKEN'],
      runtime: { command: 'python main.py' },
    }

    mockFs.readFile.mockImplementation(async (filePath: unknown) => {
      const p = String(filePath)
      if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p.includes('orchagent.json')) return JSON.stringify(manifest)
      if (p.includes('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      throw new Error(`Unexpected file: ${p}`)
    })
    mockFs.readdir.mockResolvedValue([
      { name: 'main.py', isFile: () => true, isDirectory: () => false },
    ] as any)
    mockDetectEntrypoint.mockResolvedValue('main.py')
    mockCreateCodeBundle.mockResolvedValue({ fileCount: 1, sizeBytes: 512, entrypoint: 'main.py' })
    mockValidateBundle.mockResolvedValue({ valid: true })
    mockUploadCodeBundle.mockResolvedValue({ code_hash: 'abc123def456' })
    mockFs.mkdtemp.mockResolvedValue('/tmp/orchagent-bundle-123')
    mockFs.rm.mockResolvedValue(undefined)
    mockFs.access.mockResolvedValue(undefined)
    mockCreateAgent.mockResolvedValue({
      agent: { id: 'agent-123', version: 'v1', name: 'secret-agent' },
    })

    await program.parseAsync(['node', 'test', 'publish'])

    const output = stdoutSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(output).toContain('Required secrets:')
    expect(output).toContain('DISCORD_WEBHOOK_URL')
    expect(output).toContain('GITHUB_TOKEN')
    expect(output).toContain('orch secrets set DISCORD_WEBHOOK_URL <value>')
    expect(output).toContain('orch secrets set GITHUB_TOKEN <value>')
    expect(output).toContain('orch secrets list')
  })

  it('shows required_secrets in dry-run preview (F-18)', async () => {
    const manifest = {
      name: 'secret-agent',
      type: 'agent',
      description: 'Agent with secrets',
      required_secrets: ['API_KEY', 'DB_URL'],
      runtime: { command: 'python main.py' },
    }

    mockFs.readFile.mockImplementation(async (filePath: unknown) => {
      const p = String(filePath)
      if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p.includes('orchagent.json')) return JSON.stringify(manifest)
      if (p.includes('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      throw new Error(`Unexpected file: ${p}`)
    })
    mockDetectEntrypoint.mockResolvedValue('main.py')
    mockFs.access.mockResolvedValue(undefined)
    mockPreviewAgentVersion.mockResolvedValue({
      name: 'secret-agent',
      existing_versions: [],
      next_version: 'v1',
      org_slug: 'test-org',
    })
    mockPreviewBundle.mockResolvedValue({
      fileCount: 1,
      totalSizeBytes: 512,
      entrypoint: 'main.py',
      files: [],
    })

    await program.parseAsync(['node', 'test', 'publish', '--dry-run'])

    const output = stderrSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(output).toContain('Secrets:     API_KEY, DB_URL')
  })

  it('does not show secrets section when required_secrets is empty', async () => {
    const manifest = {
      name: 'no-secret-agent',
      type: 'prompt',
      description: 'Agent without secrets',
    }

    mockFs.readFile.mockImplementation(async (filePath: unknown) => {
      const p = String(filePath)
      if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p.includes('orchagent.json')) return JSON.stringify(manifest)
      if (p.includes('prompt.md')) return 'You are helpful.'
      if (p.includes('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      throw new Error(`Unexpected file: ${p}`)
    })
    mockCreateAgent.mockResolvedValue({
      agent: { id: 'agent-456', version: 'v1', name: 'no-secret-agent' },
    })

    await program.parseAsync(['node', 'test', 'publish'])

    const output = stdoutSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(output).not.toContain('Required secrets:')
    expect(output).not.toContain('orch secrets set')
  })
})

describe('scanUndeclaredEnvVars', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('detects os.environ["KEY"] references', async () => {
    mockFs.readdir.mockResolvedValue([
      { name: 'main.py', isFile: () => true, isDirectory: () => false },
    ] as any)
    mockFs.readFile.mockResolvedValue('api_key = os.environ["MY_API_KEY"]\ndb = os.environ["DB_URL"]')

    const result = await scanUndeclaredEnvVars('/test', [])
    expect(result).toEqual(['DB_URL', 'MY_API_KEY'])
  })

  it('detects os.getenv() references', async () => {
    mockFs.readdir.mockResolvedValue([
      { name: 'main.py', isFile: () => true, isDirectory: () => false },
    ] as any)
    mockFs.readFile.mockResolvedValue("key = os.getenv('SECRET_TOKEN')")

    const result = await scanUndeclaredEnvVars('/test', [])
    expect(result).toEqual(['SECRET_TOKEN'])
  })

  it('detects os.environ.get() references', async () => {
    mockFs.readdir.mockResolvedValue([
      { name: 'main.py', isFile: () => true, isDirectory: () => false },
    ] as any)
    mockFs.readFile.mockResolvedValue('val = os.environ.get("REDIS_URL", "localhost")')

    const result = await scanUndeclaredEnvVars('/test', [])
    expect(result).toEqual(['REDIS_URL'])
  })

  it('excludes vars already in required_secrets', async () => {
    mockFs.readdir.mockResolvedValue([
      { name: 'main.py', isFile: () => true, isDirectory: () => false },
    ] as any)
    mockFs.readFile.mockResolvedValue('os.environ["MY_SECRET"]\nos.environ["UNDECLARED"]')

    const result = await scanUndeclaredEnvVars('/test', ['MY_SECRET'])
    expect(result).toEqual(['UNDECLARED'])
  })

  it('excludes auto-injected platform vars', async () => {
    mockFs.readdir.mockResolvedValue([
      { name: 'main.py', isFile: () => true, isDirectory: () => false },
    ] as any)
    mockFs.readFile.mockResolvedValue(
      'os.environ["ANTHROPIC_API_KEY"]\nos.environ["ORCHAGENT_SERVICE_KEY"]\nos.environ["PATH"]'
    )

    const result = await scanUndeclaredEnvVars('/test', [])
    expect(result).toEqual([])
  })

  it('skips non-py files', async () => {
    mockFs.readdir.mockResolvedValue([
      { name: 'main.py', isFile: () => true, isDirectory: () => false },
      { name: 'readme.md', isFile: () => true, isDirectory: () => false },
    ] as any)
    mockFs.readFile.mockResolvedValue('os.environ["CUSTOM_VAR"]')

    const result = await scanUndeclaredEnvVars('/test', [])
    expect(result).toEqual(['CUSTOM_VAR'])
    // readFile should only be called for .py files (readdir also calls it for path arg)
  })

  it('returns empty array when no py files exist', async () => {
    mockFs.readdir.mockResolvedValue([
      { name: 'readme.md', isFile: () => true, isDirectory: () => false },
    ] as any)

    const result = await scanUndeclaredEnvVars('/test', [])
    expect(result).toEqual([])
  })

  it('handles directory read errors gracefully', async () => {
    mockFs.readdir.mockRejectedValue(new Error('ENOENT'))

    const result = await scanUndeclaredEnvVars('/test', [])
    expect(result).toEqual([])
  })

  it('detects process.env.VAR in .js files', async () => {
    mockFs.readdir.mockResolvedValue([
      { name: 'main.js', isFile: () => true, isDirectory: () => false },
    ] as any)
    mockFs.readFile.mockResolvedValue('const token = process.env.DISCORD_TOKEN\nconst key = process.env.API_KEY')

    const result = await scanUndeclaredEnvVars('/test', [])
    expect(result).toEqual(['API_KEY', 'DISCORD_TOKEN'])
  })

  it('detects process.env.VAR in .ts files', async () => {
    mockFs.readdir.mockResolvedValue([
      { name: 'main.ts', isFile: () => true, isDirectory: () => false },
    ] as any)
    mockFs.readFile.mockResolvedValue('const url: string = process.env.DATABASE_URL!')

    const result = await scanUndeclaredEnvVars('/test', [])
    expect(result).toEqual(['DATABASE_URL'])
  })

  it('detects env vars from both .py and .js files', async () => {
    mockFs.readdir.mockResolvedValue([
      { name: 'main.py', isFile: () => true, isDirectory: () => false },
      { name: 'helper.js', isFile: () => true, isDirectory: () => false },
    ] as any)
    mockFs.readFile.mockImplementation(async (p: any) => {
      if (String(p).endsWith('main.py')) return 'os.environ["PY_VAR"]'
      if (String(p).endsWith('helper.js')) return 'process.env.JS_VAR'
      return ''
    })

    const result = await scanUndeclaredEnvVars('/test', [])
    expect(result).toEqual(['JS_VAR', 'PY_VAR'])
  })
})

describe('scanReservedPort', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('detects Python app.run(port=8080)', async () => {
    mockFs.readdir.mockResolvedValue([
      { name: 'server.py', isFile: () => true, isDirectory: () => false },
    ] as any)
    mockFs.readFile.mockResolvedValue('app.run(host="0.0.0.0", port=8080)')

    expect(await scanReservedPort('/test')).toBe(true)
  })

  it('detects Python .listen(8080)', async () => {
    mockFs.readdir.mockResolvedValue([
      { name: 'main.py', isFile: () => true, isDirectory: () => false },
    ] as any)
    mockFs.readFile.mockResolvedValue('server.listen(8080)')

    expect(await scanReservedPort('/test')).toBe(true)
  })

  it('detects Python PORT = 8080', async () => {
    mockFs.readdir.mockResolvedValue([
      { name: 'main.py', isFile: () => true, isDirectory: () => false },
    ] as any)
    mockFs.readFile.mockResolvedValue('PORT = 8080\napp.run(port=PORT)')

    expect(await scanReservedPort('/test')).toBe(true)
  })

  it('detects Python bind(("0.0.0.0", 8080))', async () => {
    mockFs.readdir.mockResolvedValue([
      { name: 'main.py', isFile: () => true, isDirectory: () => false },
    ] as any)
    mockFs.readFile.mockResolvedValue('sock.bind(("0.0.0.0", 8080))')

    expect(await scanReservedPort('/test')).toBe(true)
  })

  it('detects JS app.listen(8080)', async () => {
    mockFs.readdir.mockResolvedValue([
      { name: 'server.js', isFile: () => true, isDirectory: () => false },
    ] as any)
    mockFs.readFile.mockResolvedValue('app.listen(8080, () => console.log("running"))')

    expect(await scanReservedPort('/test')).toBe(true)
  })

  it('detects JS port: 8080', async () => {
    mockFs.readdir.mockResolvedValue([
      { name: 'index.ts', isFile: () => true, isDirectory: () => false },
    ] as any)
    mockFs.readFile.mockResolvedValue('const config = { port: 8080 }')

    expect(await scanReservedPort('/test')).toBe(true)
  })

  it('returns false for port 3000', async () => {
    mockFs.readdir.mockResolvedValue([
      { name: 'server.py', isFile: () => true, isDirectory: () => false },
    ] as any)
    mockFs.readFile.mockResolvedValue('app.run(host="0.0.0.0", port=3000)')

    expect(await scanReservedPort('/test')).toBe(false)
  })

  it('returns false when no code files exist', async () => {
    mockFs.readdir.mockResolvedValue([
      { name: 'readme.md', isFile: () => true, isDirectory: () => false },
    ] as any)

    expect(await scanReservedPort('/test')).toBe(false)
  })

  it('handles directory read errors gracefully', async () => {
    mockFs.readdir.mockRejectedValue(new Error('ENOENT'))

    expect(await scanReservedPort('/test')).toBe(false)
  })

  it('scans subdirectories up to 2 levels deep', async () => {
    mockFs.readdir.mockImplementation(async (dir: any) => {
      if (String(dir) === '/test') {
        return [{ name: 'lib', isFile: () => false, isDirectory: () => true }] as any
      }
      if (String(dir).endsWith('/lib')) {
        return [{ name: 'app.py', isFile: () => true, isDirectory: () => false }] as any
      }
      return [] as any
    })
    mockFs.readFile.mockResolvedValue('app.run(port=8080)')

    expect(await scanReservedPort('/test')).toBe(true)
  })
})

describe('required_secrets enforcement (C-1)', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let originalCwd: () => string

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
    mockLoadConfig.mockResolvedValue({})
    mockGetOrg.mockResolvedValue({
      id: 'org-123',
      slug: 'test-org',
      name: 'Test Org',
    })
    mockCreateAgent.mockResolvedValue({ id: 'agent-123' })

    originalCwd = process.cwd
    process.cwd = () => '/test/project'
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    process.cwd = originalCwd
    vi.restoreAllMocks()
  })

  it('defaults required_secrets to [] for tool type when omitted (UX-2)', async () => {
    const manifest = {
      name: 'my-tool',
      type: 'tool',
      description: 'A tool agent',
    }

    mockFs.readFile.mockImplementation(async (filePath: any) => {
      const p = String(filePath)
      if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p.includes('orchagent.json')) return JSON.stringify(manifest)
      if (p.includes('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return ''
    })
    mockDetectEntrypoint.mockResolvedValue('main.py')
    mockFs.mkdtemp.mockResolvedValue('/tmp/orchagent-bundle-test' as any)
    mockFs.rm.mockResolvedValue(undefined)
    mockCreateCodeBundle.mockResolvedValue({ fileCount: 1, sizeBytes: 100 } as any)
    mockValidateBundle.mockResolvedValue({ valid: true } as any)
    mockUploadCodeBundle.mockResolvedValue({
      success: true, code_hash: 'abc123', bundle_size_bytes: 100,
    } as any)

    await program.parseAsync(['node', 'test', 'publish'])

    const stderrOutput = stderrSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(stderrOutput).toContain('defaulting to []')
    expect(stderrOutput).not.toContain('must declare required_secrets')
  })

  it('defaults required_secrets to [] for agent type when omitted (UX-2)', async () => {
    const manifest = {
      name: 'my-agent',
      type: 'agent',
      description: 'An agent',
      runtime: { command: 'python main.py' },
    }

    mockFs.readFile.mockImplementation(async (filePath: any) => {
      const p = String(filePath)
      if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p.includes('orchagent.json')) return JSON.stringify(manifest)
      if (p.includes('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return ''
    })
    mockDetectEntrypoint.mockResolvedValue('main.py')
    mockFs.mkdtemp.mockResolvedValue('/tmp/orchagent-bundle-test' as any)
    mockFs.rm.mockResolvedValue(undefined)
    mockCreateCodeBundle.mockResolvedValue({ fileCount: 1, sizeBytes: 100 } as any)
    mockValidateBundle.mockResolvedValue({ valid: true } as any)
    mockUploadCodeBundle.mockResolvedValue({
      success: true, code_hash: 'abc123', bundle_size_bytes: 100,
    } as any)

    await program.parseAsync(['node', 'test', 'publish'])

    const stderrOutput = stderrSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(stderrOutput).toContain('defaulting to []')
    expect(stderrOutput).not.toContain('must declare required_secrets')
  })

  it('allows tool type with explicit empty required_secrets array', async () => {
    const manifest = {
      name: 'my-tool',
      type: 'tool',
      description: 'A tool agent',
      required_secrets: [],
    }

    mockFs.readFile.mockImplementation(async (filePath: any) => {
      const p = String(filePath)
      if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p.includes('orchagent.json')) return JSON.stringify(manifest)
      if (p.includes('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return ''
    })
    mockDetectEntrypoint.mockResolvedValue('main.py')
    mockFs.mkdtemp.mockResolvedValue('/tmp/orchagent-bundle-test' as any)
    mockFs.rm.mockResolvedValue(undefined)
    mockCreateCodeBundle.mockResolvedValue({ fileCount: 1, sizeBytes: 100 } as any)
    mockValidateBundle.mockResolvedValue({ valid: true } as any)
    mockUploadCodeBundle.mockResolvedValue({
      success: true, code_hash: 'abc123', bundle_size_bytes: 100,
    } as any)

    await program.parseAsync(['node', 'test', 'publish'])

    const stderrOutput = stderrSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(stderrOutput).not.toContain('required_secrets')
  })

  it('allows agent type with explicit empty required_secrets array', async () => {
    const manifest = {
      name: 'my-agent',
      type: 'agent',
      description: 'An agent',
      runtime: { command: 'python main.py' },
      required_secrets: [],
    }

    mockFs.readFile.mockImplementation(async (filePath: any) => {
      const p = String(filePath)
      if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p.includes('orchagent.json')) return JSON.stringify(manifest)
      if (p.includes('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return ''
    })
    mockDetectEntrypoint.mockResolvedValue('main.py')
    mockFs.mkdtemp.mockResolvedValue('/tmp/orchagent-bundle-test' as any)
    mockFs.rm.mockResolvedValue(undefined)
    mockCreateCodeBundle.mockResolvedValue({ fileCount: 1, sizeBytes: 100 } as any)
    mockValidateBundle.mockResolvedValue({ valid: true } as any)
    mockUploadCodeBundle.mockResolvedValue({
      success: true, code_hash: 'abc123', bundle_size_bytes: 100,
    } as any)

    await program.parseAsync(['node', 'test', 'publish'])

    const stderrOutput = stderrSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(stderrOutput).not.toContain('required_secrets')
  })

  it('allows tool type with --no-required-secrets flag', async () => {
    const manifest = {
      name: 'my-tool',
      type: 'tool',
      description: 'A tool agent',
    }

    mockFs.readFile.mockImplementation(async (filePath: any) => {
      const p = String(filePath)
      if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p.includes('orchagent.json')) return JSON.stringify(manifest)
      if (p.includes('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return ''
    })
    mockDetectEntrypoint.mockResolvedValue('main.py')
    mockFs.mkdtemp.mockResolvedValue('/tmp/orchagent-bundle-test' as any)
    mockFs.rm.mockResolvedValue(undefined)
    mockCreateCodeBundle.mockResolvedValue({ fileCount: 1, sizeBytes: 100 } as any)
    mockValidateBundle.mockResolvedValue({ valid: true } as any)
    mockUploadCodeBundle.mockResolvedValue({
      success: true, code_hash: 'abc123', bundle_size_bytes: 100,
    } as any)

    await program.parseAsync(['node', 'test', 'publish', '--no-required-secrets'])

    const stderrOutput = stderrSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(stderrOutput).not.toContain('must declare required_secrets')
  })

  it('does not block prompt type without required_secrets', async () => {
    const manifest = {
      name: 'my-prompt',
      type: 'prompt',
      description: 'A prompt agent',
    }

    mockFs.readFile.mockImplementation(async (filePath: any) => {
      const p = String(filePath)
      if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p.includes('orchagent.json')) return JSON.stringify(manifest)
      if (p.includes('prompt.md')) return 'You are helpful.'
      if (p.includes('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      throw new Error(`Unexpected file: ${p}`)
    })

    await program.parseAsync(['node', 'test', 'publish'])

    const stderrOutput = stderrSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(stderrOutput).not.toContain('must declare required_secrets')
  })

  it('does not block skill type without required_secrets', async () => {
    const skillMd = `---
name: my-skill
description: A skill
---
Do something.`

    mockFs.readFile.mockImplementation(async (filePath: any) => {
      const p = String(filePath)
      if (p.includes('SKILL.md')) return skillMd
      throw new Error(`Unexpected file: ${p}`)
    })
    mockFs.readdir.mockResolvedValue([])

    await program.parseAsync(['node', 'test', 'publish'])

    const stderrOutput = stderrSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(stderrOutput).not.toContain('must declare required_secrets')
  })
})

describe('detectSdkCompatible', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns true when package.json has orchagent-sdk in dependencies', async () => {
    mockFs.readFile.mockImplementation(async (p: any) => {
      if (String(p).includes('requirements.txt')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (String(p).includes('pyproject.toml')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (String(p).includes('package.json')) return JSON.stringify({
        dependencies: { 'orchagent-sdk': '^0.1.0', 'discord.js': '^14.0.0' }
      })
      throw new Error(`Unexpected: ${p}`)
    })

    const result = await detectSdkCompatible('/test')
    expect(result).toBe(true)
  })

  it('returns true when package.json has @orchagent/sdk in dependencies', async () => {
    mockFs.readFile.mockImplementation(async (p: any) => {
      if (String(p).includes('requirements.txt')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (String(p).includes('pyproject.toml')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (String(p).includes('package.json')) return JSON.stringify({
        dependencies: { '@orchagent/sdk': '^0.1.0' }
      })
      throw new Error(`Unexpected: ${p}`)
    })

    const result = await detectSdkCompatible('/test')
    expect(result).toBe(true)
  })

  it('returns false when package.json has no SDK dependency', async () => {
    mockFs.readFile.mockImplementation(async (p: any) => {
      if (String(p).includes('requirements.txt')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (String(p).includes('pyproject.toml')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (String(p).includes('package.json')) return JSON.stringify({
        dependencies: { 'discord.js': '^14.0.0' }
      })
      throw new Error(`Unexpected: ${p}`)
    })

    const result = await detectSdkCompatible('/test')
    expect(result).toBe(false)
  })

  it('returns false when no dependency files exist', async () => {
    mockFs.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    const result = await detectSdkCompatible('/test')
    expect(result).toBe(false)
  })
})

describe('checkDependencies', () => {
  const config = { apiKey: 'sk_test_123', apiUrl: 'https://api.test.com' }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns found_callable for same-org dep that exists and is callable', async () => {
    mockRequest.mockResolvedValue([
      { name: 'worker', version: 'v1', callable: true },
    ] as any)

    const results = await checkDependencies(
      config,
      [{ id: 'myorg/worker', version: 'v1' }],
      'myorg'
    )

    expect(results).toEqual([
      { ref: 'myorg/worker@v1', status: 'found_callable' },
    ])
  })

  it('returns found_not_callable for same-org dep that exists but is not callable', async () => {
    mockRequest.mockResolvedValue([
      { name: 'worker', version: 'v1', callable: false },
    ] as any)

    const results = await checkDependencies(
      config,
      [{ id: 'myorg/worker', version: 'v1' }],
      'myorg'
    )

    expect(results).toEqual([
      { ref: 'myorg/worker@v1', status: 'found_not_callable' },
    ])
  })

  it('returns not_found for same-org dep that does not exist', async () => {
    mockRequest.mockResolvedValue([
      { name: 'other-agent', version: 'v1', callable: true },
    ] as any)

    const results = await checkDependencies(
      config,
      [{ id: 'myorg/missing-agent', version: 'v1' }],
      'myorg'
    )

    expect(results).toEqual([
      { ref: 'myorg/missing-agent@v1', status: 'not_found' },
    ])
  })

  it('returns not_found for same-org dep with wrong version', async () => {
    mockRequest.mockResolvedValue([
      { name: 'worker', version: 'v1', callable: true },
    ] as any)

    const results = await checkDependencies(
      config,
      [{ id: 'myorg/worker', version: 'v2' }],
      'myorg'
    )

    expect(results).toEqual([
      { ref: 'myorg/worker@v2', status: 'not_found' },
    ])
  })

  it('uses public endpoint for cross-org dependencies', async () => {
    mockGetPublicAgent.mockResolvedValue({
      id: 'agent-1', org_name: 'Other', org_slug: 'other-org',
      name: 'parser', version: 'v1', callable: true,
    } as any)

    const results = await checkDependencies(
      config,
      [{ id: 'other-org/parser', version: 'v1' }],
      'myorg'
    )

    expect(mockGetPublicAgent).toHaveBeenCalledWith(config, 'other-org', 'parser', 'v1')
    expect(results).toEqual([
      { ref: 'other-org/parser@v1', status: 'found_callable' },
    ])
    // Should NOT have fetched the user's agent list (no same-org deps)
    expect(mockRequest).not.toHaveBeenCalled()
  })

  it('returns not_found for cross-org dep that 404s on public endpoint', async () => {
    mockGetPublicAgent.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }))

    const results = await checkDependencies(
      config,
      [{ id: 'other-org/missing', version: 'v1' }],
      'myorg'
    )

    expect(results).toEqual([
      { ref: 'other-org/missing@v1', status: 'not_found' },
    ])
  })

  it('treats network errors as found to avoid false alarms', async () => {
    mockGetPublicAgent.mockRejectedValue(new Error('Network error'))

    const results = await checkDependencies(
      config,
      [{ id: 'other-org/flaky', version: 'v1' }],
      'myorg'
    )

    expect(results).toEqual([
      { ref: 'other-org/flaky@v1', status: 'found_callable' },
    ])
  })

  it('returns empty array when agent list fetch fails', async () => {
    mockRequest.mockRejectedValue(new Error('Network error'))

    const results = await checkDependencies(
      config,
      [{ id: 'myorg/worker', version: 'v1' }],
      'myorg'
    )

    expect(results).toEqual([])
  })

  it('handles mixed same-org and cross-org deps', async () => {
    mockRequest.mockResolvedValue([
      { name: 'local-worker', version: 'v1', callable: true },
    ] as any)
    mockGetPublicAgent.mockResolvedValue({
      id: 'agent-2', org_name: 'External', org_slug: 'external',
      name: 'service', version: 'v1', callable: true,
    } as any)

    const results = await checkDependencies(
      config,
      [
        { id: 'myorg/local-worker', version: 'v1' },
        { id: 'external/service', version: 'v1' },
      ],
      'myorg'
    )

    expect(results).toEqual([
      { ref: 'myorg/local-worker@v1', status: 'found_callable' },
      { ref: 'external/service@v1', status: 'found_callable' },
    ])
  })

  it('passes workspace header when checking same-org deps', async () => {
    mockRequest.mockResolvedValue([
      { name: 'worker', version: 'v1', callable: true },
    ] as any)

    await checkDependencies(
      config,
      [{ id: 'myorg/worker', version: 'v1' }],
      'myorg',
      'ws-123'
    )

    expect(mockRequest).toHaveBeenCalledWith(
      config, 'GET', '/agents',
      { headers: { 'X-Workspace-Id': 'ws-123' } }
    )
  })

  it('handles malformed dependency id', async () => {
    const results = await checkDependencies(
      config,
      [{ id: 'no-slash', version: 'v1' }],
      'myorg'
    )

    expect(results).toEqual([
      { ref: 'no-slash@v1', status: 'not_found' },
    ])
  })
})

describe('publish command - dependency warnings (F-9b)', () => {
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
    mockLoadConfig.mockResolvedValue({})
    mockGetOrg.mockResolvedValue({
      id: 'org-123',
      slug: 'test-org',
      name: 'Test Org',
    } as any)
    mockCreateAgent.mockResolvedValue({
      agent: { id: 'agent-1', version: 'v1' },
    } as any)

    process.cwd = () => '/test/project'
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('warns about unpublished dependencies', async () => {
    const manifest = {
      name: 'orchestrator',
      type: 'agent',
      required_secrets: ['ANTHROPIC_API_KEY'],
      runtime: { command: 'python main.py' },
      manifest: {
        manifest_version: 1,
        dependencies: [{ id: 'test-org/missing-worker', version: 'v1' }],
        max_hops: 2,
        timeout_ms: 60000,
        per_call_downstream_cap: 50,
      },
    }

    // Same-org dep: return empty agent list (dep not published)
    mockRequest.mockResolvedValue([] as any)

    mockFs.readFile.mockImplementation(async (filePath: any) => {
      const p = String(filePath)
      if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p.includes('orchagent.json')) return JSON.stringify(manifest)
      if (p.includes('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return ''
    })
    mockFs.access.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    mockDetectEntrypoint.mockResolvedValue('main.py')
    mockFs.mkdtemp.mockResolvedValue('/tmp/orchagent-bundle-test' as any)
    mockFs.rm.mockResolvedValue(undefined)
    mockCreateCodeBundle.mockResolvedValue({ fileCount: 1, sizeBytes: 100 } as any)
    mockValidateBundle.mockResolvedValue({ valid: true } as any)
    mockUploadCodeBundle.mockResolvedValue({
      success: true, code_hash: 'abc123', bundle_size_bytes: 100,
    } as any)

    await program.parseAsync(['node', 'test', 'publish'])

    const stderrOutput = stderrSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(stderrOutput).toContain('Unpublished dependencies')
    expect(stderrOutput).toContain('test-org/missing-worker@v1')
  })

  it('warns about dependencies not marked callable', async () => {
    const manifest = {
      name: 'orchestrator',
      type: 'agent',
      required_secrets: ['ANTHROPIC_API_KEY'],
      runtime: { command: 'python main.py' },
      manifest: {
        manifest_version: 1,
        dependencies: [{ id: 'test-org/not-callable-worker', version: 'v1' }],
        max_hops: 2,
        timeout_ms: 60000,
        per_call_downstream_cap: 50,
      },
    }

    // Same-org dep: return agent that exists but is NOT callable
    mockRequest.mockResolvedValue([
      { name: 'not-callable-worker', version: 'v1', callable: false },
    ] as any)

    mockFs.readFile.mockImplementation(async (filePath: any) => {
      const p = String(filePath)
      if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p.includes('orchagent.json')) return JSON.stringify(manifest)
      if (p.includes('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return ''
    })
    mockFs.access.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    mockDetectEntrypoint.mockResolvedValue('main.py')
    mockFs.mkdtemp.mockResolvedValue('/tmp/orchagent-bundle-test' as any)
    mockFs.rm.mockResolvedValue(undefined)
    mockCreateCodeBundle.mockResolvedValue({ fileCount: 1, sizeBytes: 100 } as any)
    mockValidateBundle.mockResolvedValue({ valid: true } as any)
    mockUploadCodeBundle.mockResolvedValue({
      success: true, code_hash: 'abc123', bundle_size_bytes: 100,
    } as any)

    await program.parseAsync(['node', 'test', 'publish'])

    const stderrOutput = stderrSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(stderrOutput).toContain('callable: false')
    expect(stderrOutput).toContain('test-org/not-callable-worker@v1')
  })

  it('shows no warning when dependencies are published and callable', async () => {
    const manifest = {
      name: 'orchestrator',
      type: 'agent',
      required_secrets: ['ANTHROPIC_API_KEY'],
      runtime: { command: 'python main.py' },
      manifest: {
        manifest_version: 1,
        dependencies: [{ id: 'test-org/good-worker', version: 'v1' }],
        max_hops: 2,
        timeout_ms: 60000,
        per_call_downstream_cap: 50,
      },
    }

    // Same-org dep: return agent that exists and is callable
    mockRequest.mockResolvedValue([
      { name: 'good-worker', version: 'v1', callable: true },
    ] as any)

    mockFs.readFile.mockImplementation(async (filePath: any) => {
      const p = String(filePath)
      if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p.includes('orchagent.json')) return JSON.stringify(manifest)
      if (p.includes('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return ''
    })
    mockFs.access.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    mockDetectEntrypoint.mockResolvedValue('main.py')
    mockFs.mkdtemp.mockResolvedValue('/tmp/orchagent-bundle-test' as any)
    mockFs.rm.mockResolvedValue(undefined)
    mockCreateCodeBundle.mockResolvedValue({ fileCount: 1, sizeBytes: 100 } as any)
    mockValidateBundle.mockResolvedValue({ valid: true } as any)
    mockUploadCodeBundle.mockResolvedValue({
      success: true, code_hash: 'abc123', bundle_size_bytes: 100,
    } as any)

    await program.parseAsync(['node', 'test', 'publish'])

    const stderrOutput = stderrSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(stderrOutput).not.toContain('Unpublished dependencies')
    expect(stderrOutput).not.toContain('callable: false')
  })

  it('shows no dependency warnings when agent has no manifest dependencies', async () => {
    const manifest = {
      name: 'simple-agent',
      type: 'prompt',
    }

    mockFs.readFile.mockImplementation(async (filePath: any) => {
      const p = String(filePath)
      if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p.includes('orchagent.json')) return JSON.stringify(manifest)
      if (p.includes('prompt.md')) return 'Hello'
      if (p.includes('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      throw new Error(`Unexpected file: ${p}`)
    })

    await program.parseAsync(['node', 'test', 'publish'])

    const stderrOutput = stderrSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(stderrOutput).not.toContain('Unpublished dependencies')
    expect(stderrOutput).not.toContain('callable: false')
    // Should not have fetched agent list
    expect(mockRequest).not.toHaveBeenCalled()
  })
})

describe('dry-run custom_tools display (BUG-15)', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let originalCwd: () => string

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerPublishCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockGetResolvedConfig.mockResolvedValue({ apiKey: 'sk_test_123', apiUrl: 'https://api.test.com' })
    mockLoadConfig.mockResolvedValue({})
    mockGetOrg.mockResolvedValue({ id: 'org-123', slug: 'test-org', name: 'Test Org' })
    mockPreviewAgentVersion.mockResolvedValue({ name: 'test-agent', existing_versions: [], next_version: 'v1', org_slug: 'test-org' })
    originalCwd = process.cwd
    process.cwd = () => '/test/project'
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    process.cwd = originalCwd
    vi.restoreAllMocks()
  })

  function mockManifest(manifest: object) {
    mockFs.readFile.mockImplementation(async (filePath: any) => {
      const p = String(filePath)
      if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p.includes('orchagent.json')) return JSON.stringify(manifest)
      if (p.includes('prompt.md')) return 'You are an agent.'
      if (p.includes('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      throw new Error(`Unexpected file: ${p}`)
    })
  }

  const tools3 = [
    { name: 'lint', description: 'Run linter', command: 'eslint .' },
    { name: 'test', description: 'Run tests', command: 'pytest' },
    { name: 'build', description: 'Build project', command: 'make build' },
  ]

  it('shows correct count when custom_tools defined at top level', async () => {
    mockManifest({ name: 'test-agent', type: 'agent', required_secrets: [], custom_tools: tools3 })
    await program.parseAsync(['node', 'test', 'publish', '--dry-run'])
    const output = stderrSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(output).toContain('Custom tools: 3')
  })

  it('shows correct count when custom_tools defined inside loop', async () => {
    mockManifest({ name: 'test-agent', type: 'agent', required_secrets: [], loop: { max_turns: 10, custom_tools: tools3 } })
    await program.parseAsync(['node', 'test', 'publish', '--dry-run'])
    const output = stderrSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(output).toContain('Custom tools: 3')
  })

  it('shows loop count when custom_tools in both top-level and loop', async () => {
    mockManifest({
      name: 'test-agent', type: 'agent', required_secrets: [],
      custom_tools: [{ name: 'lint', description: 'Run linter', command: 'eslint .' }],
      loop: { max_turns: 5, custom_tools: [
        { name: 'test', description: 'Run tests', command: 'pytest' },
        { name: 'build', description: 'Build project', command: 'make build' },
      ] },
    })
    await program.parseAsync(['node', 'test', 'publish', '--dry-run'])
    const output = stderrSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(output).toContain('Custom tools: 2')
  })

  it('shows 0 when no custom_tools defined', async () => {
    mockManifest({ name: 'test-agent', type: 'agent', required_secrets: [] })
    await program.parseAsync(['node', 'test', 'publish', '--dry-run'])
    const output = stderrSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(output).toContain('Custom tools: 0')
  })

  it('validates custom_tools from loop (rejects missing command)', async () => {
    mockManifest({ name: 'test-agent', type: 'agent', required_secrets: [], loop: { custom_tools: [{ name: 'broken-tool', description: 'No command' }] } })
    await expect(program.parseAsync(['node', 'test', 'publish', '--dry-run'])).rejects.toThrow(/must have 'name' and 'command'/)
  })

  it('validates custom_tools from loop (rejects reserved names)', async () => {
    mockManifest({ name: 'test-agent', type: 'agent', required_secrets: [], loop: { custom_tools: [{ name: 'bash', description: 'Reserved', command: 'bash' }] } })
    await expect(program.parseAsync(['node', 'test', 'publish', '--dry-run'])).rejects.toThrow(/conflicts with a built-in tool name/)
  })

  it('validates custom_tools from loop (rejects duplicates)', async () => {
    mockManifest({ name: 'test-agent', type: 'agent', required_secrets: [], loop: { custom_tools: [
      { name: 'lint', description: 'Run linter', command: 'eslint .' },
      { name: 'lint', description: 'Duplicate', command: 'pylint .' },
    ] } })
    await expect(program.parseAsync(['node', 'test', 'publish', '--dry-run'])).rejects.toThrow(/Duplicate custom tool name/)
  })
})

describe('IDEA-013: publish sends environment field', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let originalCwd: () => string

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerPublishCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockGetResolvedConfig.mockResolvedValue({ apiKey: 'sk_test_123', apiUrl: 'https://api.test.com' })
    mockLoadConfig.mockResolvedValue({})
    mockGetOrg.mockResolvedValue({ id: 'org-123', slug: 'test-org', name: 'Test Org' })
    mockCreateAgent.mockResolvedValue({ id: 'agent-123' })
    mockPreviewAgentVersion.mockResolvedValue({ name: 'test-agent', existing_versions: [], next_version: 'v1', org_slug: 'test-org' })
    mockValidateAgentPublish.mockResolvedValue({ valid: true, errors: [], warnings: [] })
    originalCwd = process.cwd
    process.cwd = () => '/test/project'
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    process.cwd = originalCwd
    vi.restoreAllMocks()
  })

  function mockManifest(manifest: object) {
    mockFs.readFile.mockImplementation(async (filePath: any) => {
      const p = String(filePath)
      if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p.includes('orchagent.json')) return JSON.stringify(manifest)
      if (p.includes('prompt.md')) return 'You are an agent.'
      if (p.includes('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      throw new Error(`Unexpected file: ${p}`)
    })
  }

  it('dry-run shows environment when set', async () => {
    mockManifest({
      name: 'env-agent',
      type: 'agent',
      required_secrets: [],
      environment: {
        python_version: '3.11',
        node_version: '20',
        pip_flags: '--no-deps --pre',
        npm_flags: '--legacy-peer-deps',
      },
    })

    await program.parseAsync(['node', 'test', 'publish', '--dry-run'])

    const output = stderrSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(output).toContain('Environment:')
    expect(output).toContain('Python 3.11')
    expect(output).toContain('Node 20')
    expect(output).toContain('pip: --no-deps --pre')
    expect(output).toContain('npm: --legacy-peer-deps')
  })

  it('dry-run does not show environment when not set', async () => {
    mockManifest({
      name: 'plain-agent',
      type: 'agent',
      required_secrets: [],
    })

    await program.parseAsync(['node', 'test', 'publish', '--dry-run'])

    const output = stderrSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(output).not.toContain('Environment:')
  })

  it('sends environment field to createAgent API', async () => {
    mockManifest({
      name: 'env-publish-agent',
      type: 'prompt',
      description: 'Agent with env',
      environment: {
        python_version: '3.11',
        node_version: '20',
      },
    })

    await program.parseAsync(['node', 'test', 'publish'])

    expect(mockCreateAgent).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        name: 'env-publish-agent',
        environment: {
          python_version: '3.11',
          node_version: '20',
        },
      }),
      undefined
    )
  })

  it('does not send environment field when not in manifest', async () => {
    mockManifest({
      name: 'no-env-agent',
      type: 'prompt',
      description: 'Agent without env',
    })

    await program.parseAsync(['node', 'test', 'publish'])

    const callArgs = mockCreateAgent.mock.calls[0][1]
    expect(callArgs.environment).toBeUndefined()
  })
})

describe('dry-run server-side validation (BUG-11)', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let originalCwd: () => string

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
    mockLoadConfig.mockResolvedValue({})
    mockGetOrg.mockResolvedValue({
      id: 'org-123',
      slug: 'test-org',
      name: 'Test Org',
    })

    originalCwd = process.cwd
    process.cwd = () => '/test/project'
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    process.cwd = originalCwd
    vi.restoreAllMocks()
  })

  it('calls server-side validation endpoint', async () => {
    const manifest = {
      name: 'validated-agent',
      type: 'prompt',
      description: 'Test agent',
    }

    mockFs.readFile.mockImplementation(async (filePath: any) => {
      const p = String(filePath)
      if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p.includes('orchagent.json')) return JSON.stringify(manifest)
      if (p.includes('prompt.md')) return 'You are a helpful assistant.'
      if (p.includes('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      throw new Error(`Unexpected file: ${p}`)
    })
    mockPreviewAgentVersion.mockResolvedValue({
      name: 'validated-agent',
      existing_versions: [],
      next_version: 'v1',
      org_slug: 'test-org',
    })
    mockValidateAgentPublish.mockResolvedValue({
      valid: true,
      errors: [],
      warnings: [],
    })

    await program.parseAsync(['node', 'test', 'publish', '--dry-run'])

    expect(mockValidateAgentPublish).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        name: 'validated-agent',
        type: 'prompt',
      }),
      undefined,
    )
    expect(mockCreateAgent).not.toHaveBeenCalled()

    const stderrOutput = stderrSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(stderrOutput).toContain('Server-side validation passed')
  })

  it('fails when server-side validation returns errors', async () => {
    const manifest = {
      name: 'bad-agent',
      type: 'prompt',
      description: 'Test agent',
    }

    mockFs.readFile.mockImplementation(async (filePath: any) => {
      const p = String(filePath)
      if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p.includes('orchagent.json')) return JSON.stringify(manifest)
      if (p.includes('prompt.md')) return 'You are a helpful assistant.'
      if (p.includes('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      throw new Error(`Unexpected file: ${p}`)
    })
    mockPreviewAgentVersion.mockResolvedValue({
      name: 'bad-agent',
      existing_versions: [],
      next_version: 'v1',
      org_slug: 'test-org',
    })
    mockValidateAgentPublish.mockResolvedValue({
      valid: false,
      errors: ['Private agent limit reached (3). Upgrade your plan for more.'],
      warnings: [],
    })

    await expect(
      program.parseAsync(['node', 'test', 'publish', '--dry-run'])
    ).rejects.toThrow(/Server-side validation failed/)

    expect(mockCreateAgent).not.toHaveBeenCalled()

    const stderrOutput = stderrSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(stderrOutput).toContain('Private agent limit reached')
    expect(stderrOutput).toContain('Dry run failed')
  })

  it('shows warnings from server-side validation', async () => {
    const manifest = {
      name: 'warn-agent',
      type: 'prompt',
      description: 'Test agent',
      required_secrets: ['MY_SECRET', 'ORCHAGENT_SERVICE_KEY'],
    }

    mockFs.readFile.mockImplementation(async (filePath: any) => {
      const p = String(filePath)
      if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p.includes('orchagent.json')) return JSON.stringify(manifest)
      if (p.includes('prompt.md')) return 'You are a helpful assistant.'
      if (p.includes('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      throw new Error(`Unexpected file: ${p}`)
    })
    mockPreviewAgentVersion.mockResolvedValue({
      name: 'warn-agent',
      existing_versions: [],
      next_version: 'v1',
      org_slug: 'test-org',
    })
    mockValidateAgentPublish.mockResolvedValue({
      valid: true,
      errors: [],
      warnings: ['ORCHAGENT_SERVICE_KEY will be removed from required_secrets.'],
    })

    await program.parseAsync(['node', 'test', 'publish', '--dry-run'])

    const stderrOutput = stderrSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(stderrOutput).toContain('ORCHAGENT_SERVICE_KEY will be removed')
    expect(stderrOutput).toContain('Server-side validation passed')
  })

  it('gracefully handles network failure during validation', async () => {
    const manifest = {
      name: 'offline-agent',
      type: 'prompt',
      description: 'Test agent',
    }

    mockFs.readFile.mockImplementation(async (filePath: any) => {
      const p = String(filePath)
      if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p.includes('orchagent.json')) return JSON.stringify(manifest)
      if (p.includes('prompt.md')) return 'You are a helpful assistant.'
      if (p.includes('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      throw new Error(`Unexpected file: ${p}`)
    })
    mockPreviewAgentVersion.mockResolvedValue({
      name: 'offline-agent',
      existing_versions: [],
      next_version: 'v1',
      org_slug: 'test-org',
    })
    mockValidateAgentPublish.mockRejectedValue(new Error('fetch failed'))

    await program.parseAsync(['node', 'test', 'publish', '--dry-run'])

    const stderrOutput = stderrSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(stderrOutput).toContain('Could not reach server for validation')
    expect(stderrOutput).toContain('No changes made (dry run)')
  })

  it('defaults required_secrets to [] for tool type during dry-run (UX-2)', async () => {
    const manifest = {
      name: 'my-tool',
      type: 'tool',
      description: 'A tool agent',
    }

    mockFs.readFile.mockImplementation(async (filePath: any) => {
      const p = String(filePath)
      if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p.includes('orchagent.json')) return JSON.stringify(manifest)
      if (p.includes('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return ''
    })
    mockDetectEntrypoint.mockResolvedValue('main.py')
    mockPreviewAgentVersion.mockResolvedValue({
      name: 'my-tool',
      existing_versions: [],
      next_version: 'v1',
      org_slug: 'test-org',
    })
    mockPreviewBundle.mockResolvedValue({
      fileCount: 1, totalSizeBytes: 100, entrypoint: 'main.py', files: [],
    } as any)
    mockValidateAgentPublish.mockResolvedValue({
      valid: true,
      errors: [],
      warnings: [],
    })

    await program.parseAsync(['node', 'test', 'publish', '--dry-run'])

    const stderrOutput = stderrSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(stderrOutput).toContain('defaulting to []')
    expect(stderrOutput).not.toContain('must declare required_secrets')
    expect(stderrOutput).toContain('No changes made (dry run)')
  })

  it('defaults required_secrets to [] for agent type during dry-run (UX-2)', async () => {
    const manifest = {
      name: 'my-agent',
      type: 'agent',
      description: 'An agent',
      runtime: { command: 'python main.py' },
    }

    mockFs.readFile.mockImplementation(async (filePath: any) => {
      const p = String(filePath)
      if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p.includes('orchagent.json')) return JSON.stringify(manifest)
      if (p.includes('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return ''
    })
    mockDetectEntrypoint.mockResolvedValue('main.py')
    mockPreviewAgentVersion.mockResolvedValue({
      name: 'my-agent',
      existing_versions: [],
      next_version: 'v1',
      org_slug: 'test-org',
    })
    mockPreviewBundle.mockResolvedValue({
      fileCount: 1, totalSizeBytes: 100, entrypoint: 'main.py', files: [],
    } as any)
    mockValidateAgentPublish.mockResolvedValue({
      valid: true,
      errors: [],
      warnings: [],
    })

    await program.parseAsync(['node', 'test', 'publish', '--dry-run'])

    const stderrOutput = stderrSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(stderrOutput).toContain('defaulting to []')
    expect(stderrOutput).not.toContain('must declare required_secrets')
    expect(stderrOutput).toContain('No changes made (dry run)')
  })

  it('allows tool type with empty required_secrets during dry-run', async () => {
    const manifest = {
      name: 'my-tool',
      type: 'tool',
      description: 'A tool agent',
      required_secrets: [],
    }

    mockFs.readFile.mockImplementation(async (filePath: any) => {
      const p = String(filePath)
      if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p.includes('orchagent.json')) return JSON.stringify(manifest)
      if (p.includes('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return ''
    })
    mockDetectEntrypoint.mockResolvedValue('main.py')
    mockPreviewAgentVersion.mockResolvedValue({
      name: 'my-tool',
      existing_versions: [],
      next_version: 'v1',
      org_slug: 'test-org',
    })
    mockPreviewBundle.mockResolvedValue({
      fileCount: 1, totalSizeBytes: 100, entrypoint: 'main.py', files: [],
    } as any)
    mockValidateAgentPublish.mockResolvedValue({
      valid: true,
      errors: [],
      warnings: [],
    })

    await program.parseAsync(['node', 'test', 'publish', '--dry-run'])

    const stderrOutput = stderrSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(stderrOutput).not.toContain('must declare required_secrets')
    expect(stderrOutput).toContain('No changes made (dry run)')
  })

  it('respects --no-required-secrets during dry-run', async () => {
    const manifest = {
      name: 'my-tool',
      type: 'tool',
      description: 'A tool agent',
    }

    mockFs.readFile.mockImplementation(async (filePath: any) => {
      const p = String(filePath)
      if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p.includes('orchagent.json')) return JSON.stringify(manifest)
      if (p.includes('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return ''
    })
    mockDetectEntrypoint.mockResolvedValue('main.py')
    mockPreviewAgentVersion.mockResolvedValue({
      name: 'my-tool',
      existing_versions: [],
      next_version: 'v1',
      org_slug: 'test-org',
    })
    mockPreviewBundle.mockResolvedValue({
      fileCount: 1, totalSizeBytes: 100, entrypoint: 'main.py', files: [],
    } as any)
    mockValidateAgentPublish.mockResolvedValue({
      valid: true,
      errors: [],
      warnings: [],
    })

    await program.parseAsync(['node', 'test', 'publish', '--dry-run', '--no-required-secrets'])

    const stderrOutput = stderrSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(stderrOutput).not.toContain('must declare required_secrets')
    expect(stderrOutput).toContain('No changes made (dry run)')
  })
})

describe('BUG-1: skill type in orchagent.json gives actionable error', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let originalCwd: () => string

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerPublishCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockGetResolvedConfig.mockResolvedValue({ apiKey: 'sk_test', apiUrl: 'https://api.test.com' })
    mockLoadConfig.mockResolvedValue({})
    originalCwd = process.cwd
    process.cwd = () => '/test/project'
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    process.cwd = originalCwd
    vi.restoreAllMocks()
  })

  it('suggests orch skill create instead of telling user to delete orchagent.json', async () => {
    const manifest = { name: 'my-skill', type: 'skill', description: 'A skill' }

    mockFs.readFile.mockImplementation(async (filePath: unknown) => {
      const p = String(filePath)
      if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p.includes('orchagent.json')) return JSON.stringify(manifest)
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    try {
      await program.parseAsync(['node', 'test', 'publish'])
      expect.unreachable('Expected CliError')
    } catch (err: unknown) {
      const msg = (err as Error).message
      // Should suggest the correct workflow
      expect(msg).toContain('orchagent skill create')
      expect(msg).toContain('SKILL.md')
      // Should NOT tell user to remove orchagent.json
      expect(msg).not.toContain('Remove orchagent.json')
    }
  })

  it('includes agent name in skill create suggestion', async () => {
    const manifest = { name: 'scan-rules', type: 'skill' }

    mockFs.readFile.mockImplementation(async (filePath: unknown) => {
      const p = String(filePath)
      if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p.includes('orchagent.json')) return JSON.stringify(manifest)
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    try {
      await program.parseAsync(['node', 'test', 'publish'])
      expect.unreachable('Expected CliError')
    } catch (err: unknown) {
      expect((err as Error).message).toContain('orchagent skill create scan-rules')
    }
  })
})

describe('UX-1: batch validation errors', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let originalCwd: () => string

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerPublishCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockGetResolvedConfig.mockResolvedValue({ apiKey: 'sk_test', apiUrl: 'https://api.test.com' })
    mockLoadConfig.mockResolvedValue({})
    mockGetOrg.mockResolvedValue({ id: 'org-1', slug: 'test-org', name: 'Test Org' })
    originalCwd = process.cwd
    process.cwd = () => '/test/project'
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    process.cwd = originalCwd
    vi.restoreAllMocks()
  })

  it('reports multiple errors at once instead of failing on the first', async () => {
    // Manifest with bad timeout AND bad name (two validation errors)
    const manifest = {
      name: 'BAD--NAME',
      type: 'tool',
      timeout_seconds: -5,
    }

    mockFs.readFile.mockImplementation(async (filePath: unknown) => {
      const p = String(filePath)
      if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p.includes('orchagent.json')) return JSON.stringify(manifest)
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockDetectEntrypoint.mockResolvedValue('main.py')

    try {
      await program.parseAsync(['node', 'test', 'publish'])
      expect.unreachable('Expected CliError')
    } catch (err: unknown) {
      const msg = (err as Error).message
      // Both errors should appear in the single error message
      expect(msg).toContain('timeout_seconds must be a positive integer')
      expect(msg).toContain('consecutive hyphens')
      expect(msg).toContain('validation errors')
    }
  })

  it('reports single validation error without batch formatting', async () => {
    // Only one error: bad timeout
    const manifest = {
      name: 'my-tool',
      type: 'tool',
      timeout_seconds: -5,
    }

    mockFs.readFile.mockImplementation(async (filePath: unknown) => {
      const p = String(filePath)
      if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p.includes('orchagent.json')) return JSON.stringify(manifest)
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockDetectEntrypoint.mockResolvedValue('main.py')

    try {
      await program.parseAsync(['node', 'test', 'publish'])
      expect.unreachable('Expected CliError')
    } catch (err: unknown) {
      const msg = (err as Error).message
      expect(msg).toContain('timeout_seconds must be a positive integer')
      // Single error should NOT have batch formatting
      expect(msg).not.toContain('validation errors')
    }
  })

  it('collects name errors along with other validation errors', async () => {
    // Bad name (type defaults to agent, required_secrets auto-defaults to [])
    const manifest = { name: 'BAD--NAME' }

    mockFs.readFile.mockImplementation(async (filePath: unknown) => {
      const p = String(filePath)
      if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p.includes('orchagent.json')) return JSON.stringify(manifest)
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    try {
      await program.parseAsync(['node', 'test', 'publish'])
      expect.unreachable('Expected CliError')
    } catch (err: unknown) {
      const msg = (err as Error).message
      // Should contain name errors
      expect(msg).toContain('lowercase')
      expect(msg).toContain('consecutive hyphens')
      // Should also contain other errors found later
      expect(msg).toContain('validation errors')
    }
  })
})

describe('UX-9: model vs default_models warning', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let originalCwd: () => string

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerPublishCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockGetResolvedConfig.mockResolvedValue({ apiKey: 'sk_test', apiUrl: 'https://api.test.com' })
    mockLoadConfig.mockResolvedValue({})
    mockGetOrg.mockResolvedValue({ id: 'org-1', slug: 'test-org', name: 'Test Org' })
    mockCreateAgent.mockResolvedValue({ id: 'agent-1' })
    originalCwd = process.cwd
    process.cwd = () => '/test/project'
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    process.cwd = originalCwd
    vi.restoreAllMocks()
  })

  it('warns when "model" field is used instead of "default_models"', async () => {
    const manifest = {
      name: 'my-agent',
      type: 'prompt',
      model: 'anthropic/claude-sonnet-4-20250514',
    }

    mockFs.readFile.mockImplementation(async (filePath: unknown) => {
      const p = String(filePath)
      if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p.includes('orchagent.json')) return JSON.stringify(manifest)
      if (p.includes('prompt.md')) return 'You are a helpful agent.'
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    await program.parseAsync(['node', 'test', 'publish'])

    const stderrOutput = stderrSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(stderrOutput).toContain('"model" field in orchagent.json is not recognized')
    expect(stderrOutput).toContain('default_models')
  })

  it('does not warn when "default_models" is set', async () => {
    const manifest = {
      name: 'my-agent',
      type: 'prompt',
      default_models: { anthropic: 'claude-sonnet-4-20250514' },
    }

    mockFs.readFile.mockImplementation(async (filePath: unknown) => {
      const p = String(filePath)
      if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p.includes('orchagent.json')) return JSON.stringify(manifest)
      if (p.includes('prompt.md')) return 'You are a helpful agent.'
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    await program.parseAsync(['node', 'test', 'publish'])

    const stderrOutput = stderrSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(stderrOutput).not.toContain('"model" field')
  })

  it('does not warn when neither "model" nor "default_models" is set', async () => {
    const manifest = {
      name: 'my-agent',
      type: 'prompt',
    }

    mockFs.readFile.mockImplementation(async (filePath: unknown) => {
      const p = String(filePath)
      if (p.includes('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p.includes('orchagent.json')) return JSON.stringify(manifest)
      if (p.includes('prompt.md')) return 'You are a helpful agent.'
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    await program.parseAsync(['node', 'test', 'publish'])

    const stderrOutput = stderrSpy.mock.calls.map((c: any) => c[0]).join('')
    expect(stderrOutput).not.toContain('"model" field')
  })
})
