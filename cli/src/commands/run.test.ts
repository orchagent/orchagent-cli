/**
 * Tests for the run command and LLM utilities.
 *
 * These tests cover:
 * - parseAgentRef() parsing org/agent@version formats
 * - Local execution (--local) path: downloading and running agents locally
 * - LLM key detection from environment
 * - Building prompts with variable substitution
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

// Mock modules before importing
vi.mock('fs/promises')
vi.mock('../lib/config')
vi.mock('../lib/api')
vi.mock('../lib/analytics', () => ({
  track: vi.fn().mockResolvedValue(undefined),
}))

import fs from 'fs/promises'
import { registerRunCommand, renderProgress, isKeyedFileArg, mountDirectory, buildInjectedPayload, localCommandForEntrypoint, validateInputSchema, tryParseJsonObject, inferFileField, canonicalAgentType } from './run'
import { getResolvedConfig, loadConfig, getDefaultProvider } from '../lib/config'
import { publicRequest, getPublicAgent, getAgentWithFallback, safeFetchWithRetryForCalls, request, resolveWorkspaceIdForOrg, getAgentCostEstimate, downloadCodeBundle, downloadCodeBundleAuthenticated, ApiError } from '../lib/api'
import {
  detectLlmKeyFromEnv,
  getDefaultModel,
  buildPrompt,
  PROVIDER_ENV_VARS,
  DEFAULT_MODELS,
} from '../lib/llm'

const mockFs = vi.mocked(fs)
const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockLoadConfig = vi.mocked(loadConfig)
const mockGetDefaultProvider = vi.mocked(getDefaultProvider)
const mockPublicRequest = vi.mocked(publicRequest)
const mockGetPublicAgent = vi.mocked(getPublicAgent)
const mockGetAgentWithFallback = vi.mocked(getAgentWithFallback)
const mockSafeFetchWithRetryForCalls = vi.mocked(safeFetchWithRetryForCalls)
const mockRequest = vi.mocked(request)
const mockResolveWorkspaceIdForOrg = vi.mocked(resolveWorkspaceIdForOrg)
const mockGetAgentCostEstimate = vi.mocked(getAgentCostEstimate)
const mockDownloadCodeBundle = vi.mocked(downloadCodeBundle)
const mockDownloadCodeBundleAuthenticated = vi.mocked(downloadCodeBundleAuthenticated)

describe('run command --local - agent ref parsing', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()

    program = new Command()
    program.exitOverride()
    registerRunCommand(program)

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'default-org',
    })

    mockLoadConfig.mockResolvedValue({})
    mockGetDefaultProvider.mockResolvedValue(undefined)

    mockFs.mkdir.mockResolvedValue(undefined)
    mockFs.writeFile.mockResolvedValue(undefined)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('parses org/agent@version format', async () => {
    mockPublicRequest.mockResolvedValue({
      type: 'tool',
      name: 'my-agent',
      version: 'v2',
      supported_providers: ['any'],
    })

    await program.parseAsync(['node', 'test', 'run', 'myorg/my-agent@v2', '--local'])

    expect(mockPublicRequest).toHaveBeenCalledWith(
      expect.any(Object),
      '/public/agents/myorg/my-agent/v2/download'
    )
  })

  it('parses org/agent format with default version', async () => {
    mockPublicRequest.mockResolvedValue({
      type: 'tool',
      name: 'my-agent',
      version: 'latest',
      supported_providers: ['any'],
    })

    await program.parseAsync(['node', 'test', 'run', 'myorg/my-agent', '--local'])

    expect(mockPublicRequest).toHaveBeenCalledWith(
      expect.any(Object),
      '/public/agents/myorg/my-agent/latest/download'
    )
  })

  it('uses defaultOrg when no org specified', async () => {
    mockPublicRequest.mockResolvedValue({
      type: 'tool',
      name: 'my-agent',
      version: 'latest',
      supported_providers: ['any'],
    })

    await program.parseAsync(['node', 'test', 'run', 'my-agent', '--local'])

    expect(mockPublicRequest).toHaveBeenCalledWith(
      expect.any(Object),
      '/public/agents/default-org/my-agent/latest/download'
    )
  })

  it('parses agent@version format', async () => {
    mockPublicRequest.mockResolvedValue({
      type: 'tool',
      name: 'my-agent',
      version: 'v3',
      supported_providers: ['any'],
    })

    await program.parseAsync(['node', 'test', 'run', 'my-agent@v3', '--local'])

    expect(mockPublicRequest).toHaveBeenCalledWith(
      expect.any(Object),
      '/public/agents/default-org/my-agent/v3/download'
    )
  })

  it('throws error for invalid agent ref format', async () => {
    mockGetResolvedConfig.mockResolvedValue({
      apiUrl: 'https://api.test.com',
      // No defaultOrg
    })

    await expect(
      program.parseAsync(['node', 'test', 'run', 'just-agent', '--local'])
    ).rejects.toThrow('Missing org')
  })

  it('throws error for too many segments', async () => {
    await expect(
      program.parseAsync(['node', 'test', 'run', 'a/b/c/d', '--local'])
    ).rejects.toThrow('Invalid agent reference')
  })
})

describe('run command --local - download agent', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()

    program = new Command()
    program.exitOverride()
    registerRunCommand(program)

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'test-org',
    })

    mockLoadConfig.mockResolvedValue({})
    mockGetDefaultProvider.mockResolvedValue(undefined)

    mockFs.mkdir.mockResolvedValue(undefined)
    mockFs.writeFile.mockResolvedValue(undefined)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('downloads agent via public API', async () => {
    mockPublicRequest.mockResolvedValue({
      type: 'prompt',
      name: 'test-agent',
      version: 'v1',
      description: 'A test agent',
      prompt: 'You are a test assistant.',
      supported_providers: ['openai'],
    })

    await program.parseAsync(['node', 'test', 'run', 'test-org/test-agent@v1', '--local'])

    expect(mockPublicRequest).toHaveBeenCalledWith(
      { apiKey: 'sk_test_123', apiUrl: 'https://api.test.com', defaultOrg: 'test-org' },
      '/public/agents/test-org/test-agent/v1/download'
    )
  })

  it('falls back to getPublicAgent if download fails', async () => {
    mockPublicRequest.mockRejectedValue(new Error('Not found'))
    mockGetPublicAgent.mockResolvedValue({
      id: 'agent-123',
      org_id: 'org-123',
      name: 'fallback-agent',
      version: 'v1',
      type: 'tool',
      supported_providers: ['any'],
      is_public: true,
    })

    await program.parseAsync(['node', 'test', 'run', 'test-org/fallback-agent@v1', '--local'])

    expect(mockGetPublicAgent).toHaveBeenCalledWith(
      expect.any(Object),
      'test-org',
      'fallback-agent',
      'v1'
    )
  })

  it('saves agent metadata locally', async () => {
    mockPublicRequest.mockResolvedValue({
      type: 'prompt',
      name: 'saved-agent',
      version: 'v1',
      prompt: 'Test prompt',
      supported_providers: ['any'],
    })

    await program.parseAsync(['node', 'test', 'run', 'test-org/saved-agent@v1', '--local'])

    expect(mockFs.mkdir).toHaveBeenCalled()
    expect(mockFs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('agent.json'),
      expect.stringContaining('"name": "saved-agent"')
    )
  })

  it('saves prompt.md for prompt agents', async () => {
    mockPublicRequest.mockResolvedValue({
      type: 'prompt',
      name: 'prompt-agent',
      version: 'v1',
      prompt: 'You are a helpful assistant.',
      supported_providers: ['any'],
    })

    await program.parseAsync(['node', 'test', 'run', 'test-org/prompt-agent@v1', '--local'])

    expect(mockFs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('prompt.md'),
      'You are a helpful assistant.'
    )
  })

  it('handles --download-only flag', async () => {
    mockPublicRequest.mockResolvedValue({
      type: 'prompt',
      name: 'download-only-agent',
      version: 'v1',
      prompt: 'Test',
      supported_providers: ['any'],
    })

    await program.parseAsync([
      'node',
      'test',
      'run',
      'test-org/download-only-agent@v1',
      '--local',
      '--download-only',
    ])

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Agent downloaded'))
  })
})

describe('run command - cloud execution (default)', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()

    program = new Command()
    program.exitOverride()
    registerRunCommand(program)

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'test-org',
    })

    mockLoadConfig.mockResolvedValue({})
    mockGetDefaultProvider.mockResolvedValue(undefined)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('requires API key for cloud execution', async () => {
    mockGetResolvedConfig.mockResolvedValue({
      apiUrl: 'https://api.test.com',
      // No apiKey
    })

    await expect(
      program.parseAsync(['node', 'test', 'run', 'test-org/agent'])
    ).rejects.toThrow('Missing API key')
  })

  it('requires org for cloud execution', async () => {
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      // No defaultOrg
    })

    await expect(
      program.parseAsync(['node', 'test', 'run', 'just-agent'])
    ).rejects.toThrow('Missing org')
  })
})

describe('LLM utilities - detectLlmKeyFromEnv', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.OPENAI_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.GEMINI_API_KEY
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('returns null when no keys found', () => {
    const result = detectLlmKeyFromEnv(['openai'])
    expect(result).toBeNull()
  })

  it('detects OpenAI key', () => {
    process.env.OPENAI_API_KEY = 'sk-openai-test'

    const result = detectLlmKeyFromEnv(['openai'])

    expect(result).toEqual({ provider: 'openai', key: 'sk-openai-test' })
  })

  it('detects Anthropic key', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'

    const result = detectLlmKeyFromEnv(['anthropic'])

    expect(result).toEqual({ provider: 'anthropic', key: 'sk-ant-test' })
  })

  it('detects Gemini key', () => {
    process.env.GEMINI_API_KEY = 'AIza-gemini-test'

    const result = detectLlmKeyFromEnv(['gemini'])

    expect(result).toEqual({ provider: 'gemini', key: 'AIza-gemini-test' })
  })

  it('returns first matching provider in order', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    process.env.OPENAI_API_KEY = 'sk-openai-test'

    const result = detectLlmKeyFromEnv(['openai', 'anthropic'])

    expect(result).toEqual({ provider: 'openai', key: 'sk-openai-test' })
  })

  it('handles "any" provider - checks all in order', () => {
    process.env.GEMINI_API_KEY = 'AIza-gemini-test'

    const result = detectLlmKeyFromEnv(['any'])

    // 'any' should find the first available key
    expect(result?.key).toBe('AIza-gemini-test')
  })

  it('handles "any" provider - returns first found', () => {
    process.env.OPENAI_API_KEY = 'sk-openai-test'
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'

    const result = detectLlmKeyFromEnv(['any'])

    // OpenAI is checked first in the provider order
    expect(result).toEqual({ provider: 'openai', key: 'sk-openai-test' })
  })

  it('skips unavailable providers', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    // No OpenAI key

    const result = detectLlmKeyFromEnv(['openai', 'anthropic'])

    expect(result).toEqual({ provider: 'anthropic', key: 'sk-ant-test' })
  })
})

describe('LLM utilities - getDefaultModel', () => {
  it('returns default model for OpenAI', () => {
    expect(getDefaultModel('openai')).toBe('gpt-5.2')
  })

  it('returns default model for Anthropic', () => {
    expect(getDefaultModel('anthropic')).toBe('claude-opus-4-5-20251101')
  })

  it('returns default model for Gemini', () => {
    expect(getDefaultModel('gemini')).toBe('gemini-2.5-pro')
  })

  it('returns fallback model for unknown provider', () => {
    expect(getDefaultModel('unknown')).toBe('gpt-4o')
  })
})

describe('LLM utilities - buildPrompt', () => {
  it('substitutes single variable', () => {
    const template = 'Analyze this: {{input}}'
    const result = buildPrompt(template, { input: 'Hello world' })

    expect(result).toContain('Analyze this: Hello world')
  })

  it('substitutes multiple variables', () => {
    const template = 'Name: {{name}}, Age: {{age}}'
    const result = buildPrompt(template, { name: 'Alice', age: 30 })

    expect(result).toContain('Name: Alice, Age: 30')
  })

  it('appends JSON input block', () => {
    const template = 'Process this'
    const result = buildPrompt(template, { key: 'value' })

    expect(result).toContain('Input:')
    expect(result).toContain('```json')
    expect(result).toContain('"key": "value"')
  })

  it('handles empty input data', () => {
    const template = 'No inputs needed'
    const result = buildPrompt(template, {})

    expect(result).toBe('No inputs needed')
  })

  it('handles multiple occurrences of same variable', () => {
    const template = '{{name}} said hello. {{name}} waved goodbye.'
    const result = buildPrompt(template, { name: 'Bob' })

    expect(result).toContain('Bob said hello. Bob waved goodbye.')
  })

  it('preserves unused placeholders', () => {
    const template = 'Value: {{exists}}, Missing: {{missing}}'
    const result = buildPrompt(template, { exists: 'here' })

    expect(result).toContain('Value: here')
    expect(result).toContain('{{missing}}')
  })

  it('handles complex nested objects in JSON', () => {
    const template = 'Process data'
    const inputData = {
      nested: { deep: { value: 42 } },
      array: [1, 2, 3],
    }
    const result = buildPrompt(template, inputData)

    expect(result).toContain('"nested"')
    expect(result).toContain('"deep"')
    expect(result).toContain('"array"')
  })

  it('converts non-string values to strings', () => {
    const template = 'Count: {{count}}, Active: {{active}}'
    const result = buildPrompt(template, { count: 42, active: true })

    expect(result).toContain('Count: 42')
    expect(result).toContain('Active: true')
  })
})

describe('LLM utilities - constants', () => {
  it('has correct provider env vars', () => {
    expect(PROVIDER_ENV_VARS.openai).toBe('OPENAI_API_KEY')
    expect(PROVIDER_ENV_VARS.anthropic).toBe('ANTHROPIC_API_KEY')
    expect(PROVIDER_ENV_VARS.gemini).toBe('GEMINI_API_KEY')
  })

  it('has correct default models', () => {
    expect(DEFAULT_MODELS.openai).toBe('gpt-5.2')
    expect(DEFAULT_MODELS.anthropic).toBe('claude-opus-4-5-20251101')
    expect(DEFAULT_MODELS.gemini).toBe('gemini-2.5-pro')
  })
})

// ─── Bug fix tests ──────────────────────────────────────────────────────────

describe('Bug 1: --file and --data combined', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerRunCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'test-org',
    })
    mockLoadConfig.mockResolvedValue({})
    mockGetDefaultProvider.mockResolvedValue(undefined)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('allows --file and --data together for prompt agents', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'prompt',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
      input_schema: {
        properties: { code: { type: 'string' }, filename: { type: 'string' } },
        required: ['code'],
      },
    } as any)

    // Mock fs.stat for validateFilePath
    mockFs.stat.mockResolvedValue({ isDirectory: () => false } as any)
    // Mock fs.readFile for file content
    mockFs.readFile.mockResolvedValue('const x = 1;' as any)

    // Mock the fetch response
    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ result: 'ok' }),
      arrayBuffer: async () => new ArrayBuffer(0),
    } as any)

    await program.parseAsync([
      'node', 'test', 'run', 'test-org/test-agent',
      '--file', '/tmp/test.ts',
      '--data', '{"filename": "test.ts"}',
    ])

    // Verify the fetch was called with merged body
    expect(mockSafeFetchWithRetryForCalls).toHaveBeenCalled()
    const fetchCall = mockSafeFetchWithRetryForCalls.mock.calls[0]
    const body = JSON.parse(fetchCall[1].body as string)
    expect(body.code).toBe('const x = 1;')
    expect(body.filename).toBe('test.ts')
  })

  it('still rejects --data with --metadata', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'tool',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    await expect(
      program.parseAsync([
        'node', 'test', 'run', 'test-org/test-agent',
        '--data', '{"x": 1}',
        '--metadata', '{"y": 2}',
      ])
    ).rejects.toThrow('Cannot use --data with --metadata')
  })
})

describe('Bug 2: orch run . --local for local directories', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerRunCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'test-org',
    })
    mockLoadConfig.mockResolvedValue({})
    mockGetDefaultProvider.mockResolvedValue(undefined)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('detects "." as a local path and reads orchagent.json', async () => {
    // Mock stat to say it's a directory
    mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)
    // Mock orchagent.json read
    mockFs.readFile.mockImplementation(async (filePath: any) => {
      if (filePath.toString().endsWith('orchagent.json')) {
        return JSON.stringify({
          name: 'my-local-agent',
          version: 'v1',
          type: 'prompt',
          supported_providers: ['any'],
        }) as any
      }
      if (filePath.toString().endsWith('prompt.md')) {
        return 'You are a test assistant.' as any
      }
      throw new Error('ENOENT')
    })

    // No --data, so it will print "run with input" message
    await program.parseAsync(['node', 'test', 'run', '.', '--local'])

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Loaded local agent'))
  })

  it('throws error if directory has no orchagent.json', async () => {
    mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)
    mockFs.readFile.mockRejectedValue(new Error('ENOENT'))

    await expect(
      program.parseAsync(['node', 'test', 'run', '.', '--local'])
    ).rejects.toThrow('No orchagent.json found')
  })

  it('detects paths starting with "/" as local', async () => {
    mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)
    mockFs.readFile.mockImplementation(async (filePath: any) => {
      if (filePath.toString().endsWith('orchagent.json')) {
        return JSON.stringify({ name: 'test', version: 'v1', type: 'prompt' }) as any
      }
      if (filePath.toString().endsWith('prompt.md')) {
        return 'Test prompt' as any
      }
      throw new Error('ENOENT')
    })

    await program.parseAsync(['node', 'test', 'run', '/tmp/my-agent', '--local'])
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Loaded local agent'))
  })

  it('detects paths starting with "./" as local', async () => {
    mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)
    mockFs.readFile.mockImplementation(async (filePath: any) => {
      if (filePath.toString().endsWith('orchagent.json')) {
        return JSON.stringify({ name: 'test', version: 'v1', type: 'prompt' }) as any
      }
      if (filePath.toString().endsWith('prompt.md')) {
        return 'Test prompt' as any
      }
      throw new Error('ENOENT')
    })

    await program.parseAsync(['node', 'test', 'run', './my-agent', '--local'])
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Loaded local agent'))
  })

  it('rejects skill type agents from local dirs', async () => {
    mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)
    mockFs.readFile.mockImplementation(async (filePath: any) => {
      if (filePath.toString().endsWith('orchagent.json')) {
        return JSON.stringify({ name: 'test', version: 'v1', type: 'skill' }) as any
      }
      throw new Error('ENOENT')
    })

    await expect(
      program.parseAsync(['node', 'test', 'run', '.', '--local'])
    ).rejects.toThrow('Skills cannot be run directly')
  })

  it('agent type local run requires prompt.md', async () => {
    mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)
    mockFs.readFile.mockImplementation(async (filePath: any) => {
      if (filePath.toString().endsWith('orchagent.json')) {
        return JSON.stringify({ name: 'test', version: 'v1', type: 'agent' }) as any
      }
      throw new Error('ENOENT')
    })

    await expect(
      program.parseAsync(['node', 'test', 'run', '.', '--local'])
    ).rejects.toThrow('No prompt.md found')
  })
})

describe('BUG-18: @file syntax broken in local mode', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerRunCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'test-org',
    })
    mockLoadConfig.mockResolvedValue({})
    mockGetDefaultProvider.mockResolvedValue(undefined)
    mockFs.mkdir.mockResolvedValue(undefined)
    mockFs.writeFile.mockResolvedValue(undefined)
    mockFs.rm.mockResolvedValue(undefined)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('resolves @file.json in --data for local managed_loop agents', async () => {
    // Agent download returns a managed_loop agent with prompt
    mockPublicRequest.mockResolvedValue({
      type: 'agent',
      execution_engine: 'managed_loop',
      name: 'test-agent',
      version: 'v1',
      prompt: 'You are a test assistant. Process: {{task}}',
      supported_providers: ['any'],
    })

    // Mock fs.stat for validateFilePath inside resolveJsonBody
    mockFs.stat.mockResolvedValue({ isDirectory: () => false } as any)
    // Mock fs.readFile for the @file read
    mockFs.readFile.mockImplementation(async (filePath: any) => {
      if (filePath.toString() === '/tmp/input.json') {
        return '{"task": "analyze this code"}' as any
      }
      return '' as any
    })

    // executeAgentLocally will be called — it imports dynamically, so mock the spawn
    // We just need to verify it doesn't throw "Invalid JSON input" on @file syntax
    // The test will fail in executeAgentLocally but that's fine — we're testing the
    // @file resolution step, not the full agent execution
    try {
      await program.parseAsync([
        'node', 'test', 'run', 'test-org/test-agent@v1',
        '--local',
        '--data', '@/tmp/input.json',
      ])
    } catch (err: any) {
      // Should NOT throw "Invalid JSON input" — that means @file wasn't resolved
      expect(err.message).not.toContain('Invalid JSON input')
    }
  })

  it('rejects @file that points to a non-existent file in local mode', async () => {
    mockPublicRequest.mockResolvedValue({
      type: 'agent',
      execution_engine: 'managed_loop',
      name: 'test-agent',
      version: 'v1',
      prompt: 'You are a test assistant.',
      supported_providers: ['any'],
    })

    // File doesn't exist
    mockFs.stat.mockRejectedValue(new Error('ENOENT'))

    await expect(
      program.parseAsync([
        'node', 'test', 'run', 'test-org/test-agent@v1',
        '--local',
        '--data', '@/tmp/nonexistent.json',
      ])
    ).rejects.toThrow() // Should throw file-not-found, not "Invalid JSON input"
  })

  it('still accepts raw JSON in --data for local mode', async () => {
    mockPublicRequest.mockResolvedValue({
      type: 'agent',
      execution_engine: 'managed_loop',
      name: 'test-agent',
      version: 'v1',
      prompt: 'You are a test assistant.',
      supported_providers: ['any'],
    })

    mockFs.stat.mockResolvedValue({ isDirectory: () => false } as any)

    try {
      await program.parseAsync([
        'node', 'test', 'run', 'test-org/test-agent@v1',
        '--local',
        '--data', '{"task": "test"}',
      ])
    } catch (err: any) {
      // Should NOT throw "Invalid JSON input" — raw JSON should still work
      expect(err.message).not.toContain('Invalid JSON input')
    }
  })
})

describe('Bug 3: EISDIR validation on cloud runs', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerRunCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'test-org',
    })
    mockLoadConfig.mockResolvedValue({})
    mockGetDefaultProvider.mockResolvedValue(undefined)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('throws EISDIR error when --file is a directory (prompt agent)', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'prompt',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
      input_schema: { properties: { code: { type: 'string' } } },
    } as any)

    // Mock stat to say it's a directory
    mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)

    await expect(
      program.parseAsync([
        'node', 'test', 'run', 'test-org/test-agent',
        '--file', '/tmp/src/',
      ])
    ).rejects.toThrow('Cannot upload a directory for cloud execution')
  })

  it('throws EISDIR error when --file is a directory (tool agent)', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'tool',
      name: 'test-tool',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)

    await expect(
      program.parseAsync([
        'node', 'test', 'run', 'test-org/test-tool',
        '--file', '/tmp/src/',
      ])
    ).rejects.toThrow('Cannot upload a directory for cloud execution')
  })

  it('throws EISDIR error on --data @directory/', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'prompt',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)

    await expect(
      program.parseAsync([
        'node', 'test', 'run', 'test-org/test-agent',
        '--data', '@/tmp/src/',
      ])
    ).rejects.toThrow('Expected a file but got a directory')
  })
})

describe('Bug 4: Schema defaults and filename auto-population', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerRunCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'test-org',
    })
    mockLoadConfig.mockResolvedValue({})
    mockGetDefaultProvider.mockResolvedValue(undefined)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('auto-populates filename from file path when schema has filename property', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'prompt',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
      input_schema: {
        properties: {
          code: { type: 'string' },
          filename: { type: 'string' },
        },
        required: ['code'],
      },
    } as any)

    mockFs.stat.mockResolvedValue({ isDirectory: () => false } as any)
    mockFs.readFile.mockResolvedValue('const x = 1;' as any)
    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      text: async () => '{"result": "ok"}',
      arrayBuffer: async () => new ArrayBuffer(0),
    } as any)

    await program.parseAsync([
      'node', 'test', 'run', 'test-org/test-agent',
      '--file', '/home/user/src/App.tsx',
    ])

    const fetchCall = mockSafeFetchWithRetryForCalls.mock.calls[0]
    const body = JSON.parse(fetchCall[1].body as string)
    expect(body.filename).toBe('App.tsx')
  })

  it('applies schema default values to missing fields', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'prompt',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
      input_schema: {
        properties: {
          code: { type: 'string' },
          strictness: { type: 'string', default: 'standard' },
          max_issues: { type: 'number', default: 10 },
        },
        required: ['code'],
      },
    } as any)

    mockFs.stat.mockResolvedValue({ isDirectory: () => false } as any)
    mockFs.readFile.mockResolvedValue('const x = 1;' as any)
    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      text: async () => '{"result": "ok"}',
      arrayBuffer: async () => new ArrayBuffer(0),
    } as any)

    await program.parseAsync([
      'node', 'test', 'run', 'test-org/test-agent',
      '--file', '/tmp/test.ts',
    ])

    const fetchCall = mockSafeFetchWithRetryForCalls.mock.calls[0]
    const body = JSON.parse(fetchCall[1].body as string)
    expect(body.strictness).toBe('standard')
    expect(body.max_issues).toBe(10)
  })

  it('does not override user-provided values with defaults', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'prompt',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
      input_schema: {
        properties: {
          code: { type: 'string' },
          strictness: { type: 'string', default: 'standard' },
        },
        required: ['code'],
      },
    } as any)

    mockFs.stat.mockResolvedValue({ isDirectory: () => false } as any)
    mockFs.readFile.mockResolvedValue('const x = 1;' as any)
    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      text: async () => '{"result": "ok"}',
      arrayBuffer: async () => new ArrayBuffer(0),
    } as any)

    await program.parseAsync([
      'node', 'test', 'run', 'test-org/test-agent',
      '--file', '/tmp/test.ts',
      '--data', '{"strictness": "strict"}',
    ])

    const fetchCall = mockSafeFetchWithRetryForCalls.mock.calls[0]
    const body = JSON.parse(fetchCall[1].body as string)
    expect(body.strictness).toBe('strict')
  })

  it('auto-populates filename with --file + --data combination', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'prompt',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
      input_schema: {
        properties: {
          code: { type: 'string' },
          filename: { type: 'string' },
          strictness: { type: 'string', default: 'standard' },
        },
        required: ['code'],
      },
    } as any)

    mockFs.stat.mockResolvedValue({ isDirectory: () => false } as any)
    mockFs.readFile.mockResolvedValue('const x = 1;' as any)
    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      text: async () => '{"result": "ok"}',
      arrayBuffer: async () => new ArrayBuffer(0),
    } as any)

    await program.parseAsync([
      'node', 'test', 'run', 'test-org/test-agent',
      '--file', '/home/user/src/Component.tsx',
      '--data', '{}',
    ])

    const fetchCall = mockSafeFetchWithRetryForCalls.mock.calls[0]
    const body = JSON.parse(fetchCall[1].body as string)
    expect(body.filename).toBe('Component.tsx')
    expect(body.strictness).toBe('standard')
  })
})

describe('Bug 6: 500 error messages', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerRunCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'test-org',
    })
    mockLoadConfig.mockResolvedValue({})
    mockGetDefaultProvider.mockResolvedValue(undefined)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('shows actionable guidance on 500 errors', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'tool',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => JSON.stringify({ error: { message: 'Internal error' } }),
    } as any)

    await expect(
      program.parseAsync([
        'node', 'test', 'run', 'test-org/test-agent',
        '--data', '{"test": true}',
      ])
    ).rejects.toThrow('platform error')
  })

  it('shows actionable guidance on 502 errors', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'tool',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      text: async () => 'Bad Gateway',
    } as any)

    await expect(
      program.parseAsync([
        'node', 'test', 'run', 'test-org/test-agent',
        '--data', '{"test": true}',
      ])
    ).rejects.toThrow('platform error')
  })

  it('shows SANDBOX_ERROR with agent-specific guidance', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'tool',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => JSON.stringify({
        error: {
          code: 'SANDBOX_ERROR',
          category: 'code_error',
          message: 'Code execution failed with exit code 1: ModuleNotFoundError: No module named \'pandas\'',
          is_retryable: false,
        },
        metadata: { request_id: 'req_test123', sandbox_exit_code: 1 },
      }),
    } as any)

    await expect(
      program.parseAsync([
        'node', 'test', 'run', 'test-org/test-agent',
        '--data', '{"test": true}',
      ])
    ).rejects.toThrow(/error in the agent's code/)
  })

  it('shows platform issue message when SANDBOX_ERROR contains 403', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'tool',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => JSON.stringify({
        error: {
          code: 'SANDBOX_ERROR',
          message: 'orchagent-sdk error: HTTP 403 Forbidden when calling joe/text-stats-tool@v1',
          is_retryable: false,
        },
        metadata: { request_id: 'req_test456' },
      }),
    } as any)

    await expect(
      program.parseAsync([
        'node', 'test', 'run', 'test-org/test-agent',
        '--data', '{"test": true}',
      ])
    ).rejects.toThrow(/platform configuration issue/)
  })

  it('shows platform issue message when SANDBOX_ERROR contains 401 proxy token', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'tool',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => JSON.stringify({
        error: {
          code: 'SANDBOX_ERROR',
          message: 'Invalid or expired proxy token',
          is_retryable: false,
        },
        metadata: { request_id: 'req_test789' },
      }),
    } as any)

    await expect(
      program.parseAsync([
        'node', 'test', 'run', 'test-org/test-agent',
        '--data', '{"test": true}',
      ])
    ).rejects.toThrow(/platform configuration issue/)
  })

  it('shows platform issue message when SANDBOX_ERROR mentions ORCHAGENT_SERVICE_KEY', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'tool',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => JSON.stringify({
        error: {
          code: 'SANDBOX_ERROR',
          message: 'KeyError: ORCHAGENT_SERVICE_KEY not found in environment',
          is_retryable: false,
        },
        metadata: { request_id: 'req_test101' },
      }),
    } as any)

    await expect(
      program.parseAsync([
        'node', 'test', 'run', 'test-org/test-agent',
        '--data', '{"test": true}',
      ])
    ).rejects.toThrow(/platform configuration issue/)
  })

  it('still blames agent code for genuine code errors like ModuleNotFoundError', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'tool',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => JSON.stringify({
        error: {
          code: 'SANDBOX_ERROR',
          category: 'code_error',
          message: 'Code execution failed with exit code 1: ModuleNotFoundError: No module named \'pandas\'',
          is_retryable: false,
        },
        metadata: { request_id: 'req_test202', sandbox_exit_code: 1 },
      }),
    } as any)

    await expect(
      program.parseAsync([
        'node', 'test', 'run', 'test-org/test-agent',
        '--data', '{"test": true}',
      ])
    ).rejects.toThrow(/error in the agent's code/)
  })

  it('shows setup failure message for SANDBOX_ERROR with category setup_error', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'tool',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => JSON.stringify({
        error: {
          code: 'SANDBOX_ERROR',
          category: 'setup_error',
          message: 'Sandbox execution failed: Failed to create sandbox',
          is_retryable: false,
        },
        metadata: { request_id: 'req_setup_err' },
      }),
    } as any)

    await expect(
      program.parseAsync([
        'node', 'test', 'run', 'test-org/test-agent',
        '--data', '{"test": true}',
      ])
    ).rejects.toThrow(/failed during setup/)
  })

  it('does not say "error in agent code" for setup failures without category (backward compat)', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'tool',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    // Old gateway that doesn't send category or sandbox_exit_code
    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => JSON.stringify({
        error: {
          code: 'SANDBOX_ERROR',
          message: 'Sandbox execution failed: connection reset by peer',
          is_retryable: false,
        },
        metadata: { request_id: 'req_no_exit_code' },
      }),
    } as any)

    // Should NOT say "error in agent's code" — no exit code means sandbox didn't run
    const promise = program.parseAsync([
      'node', 'test', 'run', 'test-org/test-agent',
      '--data', '{"test": true}',
    ])
    await expect(promise).rejects.toThrow(/execution failed/)
    await expect(promise).rejects.not.toThrow(/error in the agent's code/)
  })

  it('shows code error message when category is code_error', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'tool',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => JSON.stringify({
        error: {
          code: 'SANDBOX_ERROR',
          category: 'code_error',
          message: 'Code execution failed with exit code 1: NameError: name \'foo\' is not defined',
          is_retryable: false,
        },
        metadata: { request_id: 'req_code_err', sandbox_exit_code: 1 },
      }),
    } as any)

    await expect(
      program.parseAsync([
        'node', 'test', 'run', 'test-org/test-agent',
        '--data', '{"test": true}',
      ])
    ).rejects.toThrow(/error in the agent's code/)
  })

  it('falls back to code error when no category but sandbox_exit_code present', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'tool',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    // Old gateway sends sandbox_exit_code in metadata but no category
    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => JSON.stringify({
        error: {
          code: 'SANDBOX_ERROR',
          message: 'Code execution failed with exit code 1: ImportError',
          is_retryable: false,
        },
        metadata: { request_id: 'req_fallback', sandbox_exit_code: 1 },
      }),
    } as any)

    await expect(
      program.parseAsync([
        'node', 'test', 'run', 'test-org/test-agent',
        '--data', '{"test": true}',
      ])
    ).rejects.toThrow(/error in the agent's code/)
  })

  it('shows SANDBOX_TIMEOUT with timeout-specific guidance', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'tool',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: false,
      status: 504,
      statusText: 'Gateway Timeout',
      text: async () => JSON.stringify({
        error: {
          code: 'SANDBOX_TIMEOUT',
          message: 'Execution timed out after 120s',
          is_retryable: true,
        },
        metadata: { request_id: 'req_timeout456' },
      }),
    } as any)

    await expect(
      program.parseAsync([
        'node', 'test', 'run', 'test-org/test-agent',
        '--data', '{"test": true}',
      ])
    ).rejects.toThrow(/did not complete in time/)
  })

  it('includes request_id in error output for support correlation', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'tool',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => JSON.stringify({
        error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
        metadata: { request_id: 'req_abc123def' },
      }),
    } as any)

    await expect(
      program.parseAsync([
        'node', 'test', 'run', 'test-org/test-agent',
        '--data', '{"test": true}',
      ])
    ).rejects.toThrow('req_abc123def')
  })

  it('does not show server guidance for 4xx errors', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'tool',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify({ error: { message: 'Invalid input' } }),
    } as any)

    await expect(
      program.parseAsync([
        'node', 'test', 'run', 'test-org/test-agent',
        '--data', '{"test": true}',
      ])
    ).rejects.toThrow('Invalid input')
  })
})

// ─── File injection tests ────────────────────────────────────────────────────

describe('isKeyedFileArg', () => {
  it('parses key=path format', () => {
    expect(isKeyedFileArg('code=./main.py')).toEqual({ key: 'code', filePath: './main.py' })
  })

  it('parses underscore key', () => {
    expect(isKeyedFileArg('source_files=./src/lib.cairo')).toEqual({
      key: 'source_files',
      filePath: './src/lib.cairo',
    })
  })

  it('returns null for plain file path', () => {
    expect(isKeyedFileArg('./main.py')).toBeNull()
  })

  it('returns null when LHS is not a valid identifier (path with slash)', () => {
    expect(isKeyedFileArg('/tmp/a=b.txt')).toBeNull()
  })

  it('returns null for empty key', () => {
    expect(isKeyedFileArg('=./file.txt')).toBeNull()
  })

  it('returns null for no equals sign', () => {
    expect(isKeyedFileArg('just-a-path.txt')).toBeNull()
  })

  it('handles key with numbers', () => {
    expect(isKeyedFileArg('file2=./test.txt')).toEqual({ key: 'file2', filePath: './test.txt' })
  })

  it('handles path with equals in it', () => {
    // key is "code", path is "./x=y.txt"
    expect(isKeyedFileArg('code=./x=y.txt')).toEqual({ key: 'code', filePath: './x=y.txt' })
  })

  it('returns null for key with special characters', () => {
    expect(isKeyedFileArg('bad-key=./file.txt')).toBeNull()
    expect(isKeyedFileArg('bad.key=./file.txt')).toBeNull()
  })
})

describe('mountDirectory', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('reads directory tree into a map', async () => {
    const mockFs = vi.mocked(fs)

    mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)
    mockFs.readdir.mockResolvedValue(['lib.cairo', 'test.cairo'] as any)
    mockFs.lstat.mockResolvedValue({ isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true } as any)
    mockFs.readFile.mockImplementation(async (filePath: any) => {
      if (filePath.toString().includes('lib.cairo')) return 'fn add() {}' as any
      if (filePath.toString().includes('test.cairo')) return 'fn test_add() {}' as any
      throw new Error('ENOENT')
    })

    const result = await mountDirectory('/tmp/src')
    expect(result).toEqual({
      'lib.cairo': 'fn add() {}',
      'test.cairo': 'fn test_add() {}',
    })
  })

  it('skips dotfiles', async () => {
    const mockFs = vi.mocked(fs)

    mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)
    mockFs.readdir.mockResolvedValue(['.hidden', 'visible.txt'] as any)
    mockFs.lstat.mockResolvedValue({ isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true } as any)
    mockFs.readFile.mockResolvedValue('content' as any)

    const result = await mountDirectory('/tmp/src')
    expect(Object.keys(result)).toEqual(['visible.txt'])
  })

  it('skips node_modules', async () => {
    const mockFs = vi.mocked(fs)

    mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)
    mockFs.readdir.mockResolvedValue(['node_modules', 'index.ts'] as any)
    mockFs.lstat.mockImplementation(async (filePath: any) => {
      if (filePath.toString().includes('node_modules')) {
        return { isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false } as any
      }
      return { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true } as any
    })
    mockFs.readFile.mockResolvedValue('code' as any)

    const result = await mountDirectory('/tmp/project')
    expect(Object.keys(result)).toEqual(['index.ts'])
  })

  it('skips symlinks', async () => {
    const mockFs = vi.mocked(fs)

    mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)
    mockFs.readdir.mockResolvedValue(['real.txt', 'link.txt'] as any)
    mockFs.lstat.mockImplementation(async (filePath: any) => {
      if (filePath.toString().includes('link.txt')) {
        return { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => true } as any
      }
      return { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true } as any
    })
    mockFs.readFile.mockResolvedValue('content' as any)

    const result = await mountDirectory('/tmp/src')
    expect(Object.keys(result)).toEqual(['real.txt'])
  })

  it('recurses into subdirectories', async () => {
    const mockFs = vi.mocked(fs)

    mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)
    mockFs.readdir.mockImplementation(async (dirPath: any) => {
      const dir = dirPath.toString()
      if (dir.endsWith('src') || dir.endsWith('/tmp/src')) {
        return ['main.py', 'lib'] as any
      }
      // lib subdirectory
      return ['utils.py'] as any
    })
    mockFs.lstat.mockImplementation(async (filePath: any) => {
      if (filePath.toString().endsWith('/lib')) {
        return { isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false } as any
      }
      return { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true } as any
    })
    mockFs.readFile.mockImplementation(async (filePath: any) => {
      if (filePath.toString().includes('main.py')) return 'main code' as any
      if (filePath.toString().includes('utils.py')) return 'utils code' as any
      throw new Error('ENOENT')
    })

    const result = await mountDirectory('/tmp/src')
    expect(result).toEqual({
      'main.py': 'main code',
      'lib/utils.py': 'utils code',
    })
  })

  it('throws on non-existent directory', async () => {
    const mockFs = vi.mocked(fs)
    mockFs.stat.mockRejectedValue(new Error('ENOENT'))

    await expect(mountDirectory('/nonexistent')).rejects.toThrow('Directory not found')
  })

  it('returns empty map for empty directory', async () => {
    const mockFs = vi.mocked(fs)

    mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)
    mockFs.readdir.mockResolvedValue([] as any)

    const result = await mountDirectory('/tmp/empty')
    expect(result).toEqual({})
  })
})

describe('buildInjectedPayload', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('merges --data with keyed files', async () => {
    const mockFs = vi.mocked(fs)
    mockFs.stat.mockResolvedValue({ isFile: () => true, isDirectory: () => false } as any)
    mockFs.readFile.mockResolvedValue('file content' as any)

    const result = await buildInjectedPayload({
      dataOption: '{"x": 1}',
      fileArgs: ['code=./test.py'],
    })

    const parsed = JSON.parse(result.body)
    expect(parsed.x).toBe(1)
    expect(parsed.code).toBe('file content')
  })

  it('merges --mount entries', async () => {
    const mockFs = vi.mocked(fs)
    mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)
    mockFs.readdir.mockResolvedValue(['a.txt'] as any)
    mockFs.lstat.mockResolvedValue({ isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true } as any)
    mockFs.readFile.mockResolvedValue('hello' as any)

    const result = await buildInjectedPayload({
      mountArgs: ['files=/tmp/dir'],
    })

    const parsed = JSON.parse(result.body)
    expect(parsed.files).toEqual({ 'a.txt': 'hello' })
  })

  it('injects llm_credentials', async () => {
    const result = await buildInjectedPayload({
      dataOption: '{"x": 1}',
      llmCredentials: { api_key: 'sk-test', provider: 'openai' },
    })

    const parsed = JSON.parse(result.body)
    expect(parsed.llm_credentials).toEqual({ api_key: 'sk-test', provider: 'openai' })
  })

  it('later flags override earlier for same key', async () => {
    const mockFs = vi.mocked(fs)
    mockFs.stat.mockImplementation(async (p: any) => {
      return { isFile: () => true, isDirectory: () => false } as any
    })
    mockFs.readFile.mockResolvedValue('new value' as any)

    const result = await buildInjectedPayload({
      dataOption: '{"code": "old value"}',
      fileArgs: ['code=./test.py'],
    })

    const parsed = JSON.parse(result.body)
    expect(parsed.code).toBe('new value')
  })

  it('throws on invalid mount format', async () => {
    await expect(buildInjectedPayload({
      mountArgs: ['noequals'],
    })).rejects.toThrow('Invalid --mount format')
  })
})

describe('Keyed --file and --mount in cloud execution', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerRunCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'test-org',
    })
    mockLoadConfig.mockResolvedValue({})
    mockGetDefaultProvider.mockResolvedValue(undefined)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('sends keyed --file as JSON body', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'tool',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    mockFs.stat.mockResolvedValue({ isFile: () => true, isDirectory: () => false } as any)
    mockFs.readFile.mockResolvedValue('config content' as any)

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      text: async () => '{"result": "ok"}',
      arrayBuffer: async () => new ArrayBuffer(0),
    } as any)

    await program.parseAsync([
      'node', 'test', 'run', 'test-org/test-agent',
      '--file', 'config=/tmp/test-config.toml',
    ])

    expect(mockSafeFetchWithRetryForCalls).toHaveBeenCalled()
    const fetchCall = mockSafeFetchWithRetryForCalls.mock.calls[0]
    const body = JSON.parse(fetchCall[1].body as string)
    expect(body.config).toBe('config content')
    expect(fetchCall[1].headers['Content-Type']).toBe('application/json')
  })

  it('sends --mount as JSON body with file map', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'tool',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    mockFs.stat.mockResolvedValue({ isDirectory: () => true } as any)
    mockFs.readdir.mockResolvedValue(['lib.cairo'] as any)
    mockFs.lstat.mockResolvedValue({ isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true } as any)
    mockFs.readFile.mockResolvedValue('fn add() {}' as any)

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      text: async () => '{"result": "ok"}',
      arrayBuffer: async () => new ArrayBuffer(0),
    } as any)

    await program.parseAsync([
      'node', 'test', 'run', 'test-org/test-agent',
      '--mount', 'source_files=/tmp/src',
    ])

    expect(mockSafeFetchWithRetryForCalls).toHaveBeenCalled()
    const fetchCall = mockSafeFetchWithRetryForCalls.mock.calls[0]
    const body = JSON.parse(fetchCall[1].body as string)
    expect(body.source_files).toEqual({ 'lib.cairo': 'fn add() {}' })
  })

  it('merges --data + --file key=path + --mount', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'tool',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    mockFs.stat.mockImplementation(async (p: any) => {
      const pStr = p.toString()
      if (pStr.includes('config')) {
        return { isFile: () => true, isDirectory: () => false } as any
      }
      return { isDirectory: () => true, isFile: () => false } as any
    })
    mockFs.readdir.mockResolvedValue(['main.py'] as any)
    mockFs.lstat.mockResolvedValue({ isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true } as any)
    mockFs.readFile.mockImplementation(async (filePath: any) => {
      if (filePath.toString().includes('config')) return 'toml content' as any
      return 'python code' as any
    })

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      text: async () => '{"result": "ok"}',
      arrayBuffer: async () => new ArrayBuffer(0),
    } as any)

    await program.parseAsync([
      'node', 'test', 'run', 'test-org/test-agent',
      '--data', '{"filter": "test_add"}',
      '--file', 'config=/tmp/config.toml',
      '--mount', 'src=/tmp/src',
    ])

    const fetchCall = mockSafeFetchWithRetryForCalls.mock.calls[0]
    const body = JSON.parse(fetchCall[1].body as string)
    expect(body.filter).toBe('test_add')
    expect(body.config).toBe('toml content')
    expect(body.src).toEqual({ 'main.py': 'python code' })
  })

  it('errors when mixing keyed and unkeyed --file', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'tool',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    await expect(
      program.parseAsync([
        'node', 'test', 'run', 'test-org/test-agent',
        '--file', 'code=./main.py',
        '--file', './other.py',
      ])
    ).rejects.toThrow('Cannot mix keyed --file')
  })

  it('unkeyed --file still works as before (backward compat)', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'prompt',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
      input_schema: {
        properties: { code: { type: 'string' } },
        required: ['code'],
      },
    } as any)

    mockFs.stat.mockResolvedValue({ isDirectory: () => false } as any)
    mockFs.readFile.mockResolvedValue('const x = 1;' as any)

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      text: async () => '{"result": "ok"}',
      arrayBuffer: async () => new ArrayBuffer(0),
    } as any)

    await program.parseAsync([
      'node', 'test', 'run', 'test-org/test-agent',
      '--file', '/tmp/test.ts',
    ])

    expect(mockSafeFetchWithRetryForCalls).toHaveBeenCalled()
    const fetchCall = mockSafeFetchWithRetryForCalls.mock.calls[0]
    const body = JSON.parse(fetchCall[1].body as string)
    // Unkeyed: should use schema inference (field: "code")
    expect(body.code).toBe('const x = 1;')
  })
})

// ─── F-18: Required secrets signposting ──────────────────────────────────────

describe('F-18: MISSING_SECRETS error handling', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerRunCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'test-org',
    })
    mockLoadConfig.mockResolvedValue({})
    mockGetDefaultProvider.mockResolvedValue(undefined)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('shows orch secrets set commands for MISSING_SECRETS error', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'tool',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify({
        error: {
          code: 'MISSING_SECRETS',
          message: "Agent requires secret(s) not found in workspace: DISCORD_TOKEN, GITHUB_TOKEN. Add them in Settings > Secrets.",
        },
        metadata: { request_id: 'req_secrets_test' },
      }),
    } as any)

    await expect(
      program.parseAsync([
        'node', 'test', 'run', 'test-org/test-agent',
        '--data', '{"test": true}',
      ])
    ).rejects.toThrow(/orch secrets set DISCORD_TOKEN/)

    // Also check it suggests the list command
    await expect(
      program.parseAsync([
        'node', 'test', 'run', 'test-org/test-agent',
        '--data', '{"test": true}',
      ])
    ).rejects.toThrow(/orch secrets list/)
  })

  it('extracts individual secret names from MISSING_SECRETS error', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'tool',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify({
        error: {
          code: 'MISSING_SECRETS',
          message: "Agent requires secret(s) not found in workspace: API_KEY. Add them in Settings > Secrets.",
        },
      }),
    } as any)

    await expect(
      program.parseAsync([
        'node', 'test', 'run', 'test-org/test-agent',
        '--data', '{"test": true}',
      ])
    ).rejects.toThrow(/orch secrets set API_KEY <value>/)
  })

  it('shows generic guidance when secret names cannot be parsed', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'tool',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify({
        error: {
          code: 'MISSING_SECRETS',
          message: 'Secrets resolution failed',
        },
      }),
    } as any)

    await expect(
      program.parseAsync([
        'node', 'test', 'run', 'test-org/test-agent',
        '--data', '{"test": true}',
      ])
    ).rejects.toThrow(/orch secrets set <NAME> <value>/)
  })
})

describe('F-18: Pre-flight secrets check', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerRunCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'test-org',
    })
    mockGetDefaultProvider.mockResolvedValue(undefined)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('catches missing secrets before making the run request', async () => {
    // Workspace configured
    mockLoadConfig.mockResolvedValue({ workspace: 'my-workspace' })

    // Resolve workspace ID for the org slug
    mockResolveWorkspaceIdForOrg.mockResolvedValue('ws-123')

    // Agent has required_secrets and is code_runtime
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'tool',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
      required_secrets: ['STRIPE_KEY', 'WEBHOOK_URL'],
      execution_engine: 'code_runtime',
    } as any)

    // Mock secrets check
    mockRequest.mockImplementation(async (_config: any, _method: string, path: string) => {
      if (path === '/workspaces/ws-123/secrets') {
        return { secrets: [{ name: 'STRIPE_KEY' }] } // WEBHOOK_URL is missing
      }
      throw new Error(`Unexpected request: ${path}`)
    })

    await expect(
      program.parseAsync([
        'node', 'test', 'run', 'test-org/test-agent',
        '--data', '{"test": true}',
      ])
    ).rejects.toThrow(/WEBHOOK_URL/)

    // Should NOT have made the actual run request
    expect(mockSafeFetchWithRetryForCalls).not.toHaveBeenCalled()
  })

  it('skips pre-flight when no workspace is configured', async () => {
    // No workspace
    mockLoadConfig.mockResolvedValue({})

    mockGetAgentWithFallback.mockResolvedValue({
      type: 'tool',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
      required_secrets: ['SECRET_KEY'],
      execution_engine: 'code_runtime',
    } as any)

    // Mock a successful run response
    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ result: 'ok' }),
      json: async () => ({ result: 'ok' }),
    } as any)

    // Should proceed to the run (not blocked by pre-flight)
    await program.parseAsync([
      'node', 'test', 'run', 'test-org/test-agent',
      '--data', '{"test": true}',
    ])

    expect(mockSafeFetchWithRetryForCalls).toHaveBeenCalled()
  })

  it('skips pre-flight for direct_llm agents', async () => {
    mockLoadConfig.mockResolvedValue({ workspace: 'my-workspace' })

    // direct_llm agent with required_secrets (unusual but should not trigger check)
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'prompt',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
      required_secrets: ['SOME_KEY'],
    } as any)

    // Mock a successful run
    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ result: 'ok' }),
      json: async () => ({ result: 'ok' }),
    } as any)

    await program.parseAsync([
      'node', 'test', 'run', 'test-org/test-agent',
      '--data', '{"test": true}',
    ])

    // Should NOT have called workspaces API for secrets check
    expect(mockRequest).not.toHaveBeenCalledWith(
      expect.anything(), 'GET', '/workspaces'
    )
  })

  it('proceeds when all required secrets are present', async () => {
    mockLoadConfig.mockResolvedValue({ workspace: 'my-workspace' })

    mockGetAgentWithFallback.mockResolvedValue({
      type: 'tool',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
      required_secrets: ['API_KEY'],
      execution_engine: 'code_runtime',
    } as any)

    mockRequest.mockImplementation(async (_config: any, _method: string, path: string) => {
      if (path === '/workspaces') {
        return { workspaces: [{ id: 'ws-123', slug: 'my-workspace' }] }
      }
      if (path === '/workspaces/ws-123/secrets') {
        return { secrets: [{ name: 'API_KEY' }] } // Present
      }
      throw new Error(`Unexpected request: ${path}`)
    })

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ result: 'ok' }),
      json: async () => ({ result: 'ok' }),
    } as any)

    await program.parseAsync([
      'node', 'test', 'run', 'test-org/test-agent',
      '--data', '{"test": true}',
    ])

    // Should proceed to the actual run
    expect(mockSafeFetchWithRetryForCalls).toHaveBeenCalled()
  })

  it('shows orch secrets set for each missing secret', async () => {
    mockLoadConfig.mockResolvedValue({ workspace: 'my-workspace' })

    // Resolve workspace ID for the org slug
    mockResolveWorkspaceIdForOrg.mockResolvedValue('ws-123')

    mockGetAgentWithFallback.mockResolvedValue({
      type: 'agent',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
      required_secrets: ['DB_URL', 'REDIS_URL', 'API_TOKEN'],
      execution_engine: 'managed_loop',
    } as any)

    mockRequest.mockImplementation(async (_config: any, _method: string, path: string) => {
      if (path === '/workspaces/ws-123/secrets') {
        return { secrets: [{ name: 'DB_URL' }] } // REDIS_URL and API_TOKEN missing
      }
      throw new Error(`Unexpected request: ${path}`)
    })

    try {
      await program.parseAsync([
        'node', 'test', 'run', 'test-org/test-agent',
        '--data', '{"test": true}',
      ])
      expect.fail('Should have thrown')
    } catch (err: any) {
      expect(err.message).toContain('orch secrets set REDIS_URL <value>')
      expect(err.message).toContain('orch secrets set API_TOKEN <value>')
      expect(err.message).not.toContain('orch secrets set DB_URL') // DB_URL exists
    }
  })
})

describe('Streaming headers for code_runtime cloud runs', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerRunCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'test-org',
    })
    mockLoadConfig.mockResolvedValue({})
    mockGetDefaultProvider.mockResolvedValue(undefined)
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'tool',
      execution_engine: 'code_runtime',
      name: 'tool-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)
    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      text: async () => '{"result":"ok"}',
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: new Headers({ 'content-type': 'application/json' }),
    } as any)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('requests SSE by default for code_runtime runs', async () => {
    await program.parseAsync(['node', 'test', 'run', 'test-org/tool-agent', '--data', '{"x":1}'])

    expect(mockSafeFetchWithRetryForCalls).toHaveBeenCalled()
    const fetchCall = mockSafeFetchWithRetryForCalls.mock.calls[0]
    expect(fetchCall[1]?.headers?.Accept).toBe('text/event-stream')
  })

  it('does not request SSE when --no-stream is set', async () => {
    await program.parseAsync(['node', 'test', 'run', 'test-org/tool-agent', '--data', '{"x":1}', '--no-stream'])

    expect(mockSafeFetchWithRetryForCalls).toHaveBeenCalled()
    const fetchCall = mockSafeFetchWithRetryForCalls.mock.calls[0]
    expect(fetchCall[1]?.headers?.Accept).toBeUndefined()
  })
})

// ─── Workspace-aware agent resolution ────────────────────────────────────────

describe('Workspace-aware cloud execution', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerRunCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'personal-org',
    })
    mockLoadConfig.mockResolvedValue({})
    mockGetDefaultProvider.mockResolvedValue(undefined)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('resolves workspace ID for team org and passes to getAgentWithFallback', async () => {
    mockResolveWorkspaceIdForOrg.mockResolvedValue('ws-team-123')

    mockGetAgentWithFallback.mockResolvedValue({
      type: 'prompt',
      name: 'team-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      text: async () => '{"result": "ok"}',
      arrayBuffer: async () => new ArrayBuffer(0),
    } as any)

    await program.parseAsync([
      'node', 'test', 'run', 'team-org/team-agent',
      '--data', '{"test": true}',
    ])

    // Verify resolveWorkspaceIdForOrg was called with the org slug
    expect(mockResolveWorkspaceIdForOrg).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk_test_123' }),
      'team-org'
    )

    // Verify getAgentWithFallback received workspace ID
    expect(mockGetAgentWithFallback).toHaveBeenCalledWith(
      expect.any(Object),
      'team-org',
      'team-agent',
      'latest',
      'ws-team-123'
    )
  })

  it('includes X-Workspace-Id header in cloud execution POST', async () => {
    mockResolveWorkspaceIdForOrg.mockResolvedValue('ws-team-123')

    mockGetAgentWithFallback.mockResolvedValue({
      type: 'prompt',
      name: 'team-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      text: async () => '{"result": "ok"}',
      arrayBuffer: async () => new ArrayBuffer(0),
    } as any)

    await program.parseAsync([
      'node', 'test', 'run', 'team-org/team-agent',
      '--data', '{"test": true}',
    ])

    const fetchCall = mockSafeFetchWithRetryForCalls.mock.calls[0]
    expect(fetchCall[1].headers['X-Workspace-Id']).toBe('ws-team-123')
  })

  it('does not include X-Workspace-Id when org is personal', async () => {
    mockResolveWorkspaceIdForOrg.mockResolvedValue(undefined)

    mockGetAgentWithFallback.mockResolvedValue({
      type: 'prompt',
      name: 'my-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      text: async () => '{"result": "ok"}',
      arrayBuffer: async () => new ArrayBuffer(0),
    } as any)

    await program.parseAsync([
      'node', 'test', 'run', 'personal-org/my-agent',
      '--data', '{"test": true}',
    ])

    const fetchCall = mockSafeFetchWithRetryForCalls.mock.calls[0]
    expect(fetchCall[1].headers['X-Workspace-Id']).toBeUndefined()
  })

  it('reuses resolved workspaceId for secrets pre-flight', async () => {
    mockResolveWorkspaceIdForOrg.mockResolvedValue('ws-team-123')

    mockGetAgentWithFallback.mockResolvedValue({
      type: 'tool',
      name: 'team-agent',
      version: 'v1',
      supported_providers: ['any'],
      required_secrets: ['API_KEY'],
      execution_engine: 'code_runtime',
    } as any)

    // Mock secrets check using already-resolved workspace ID
    mockRequest.mockImplementation(async (_config: any, _method: string, path: string) => {
      if (path === '/workspaces/ws-team-123/secrets') {
        return { secrets: [{ name: 'API_KEY' }] }
      }
      throw new Error(`Unexpected request: ${path}`)
    })

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ result: 'ok' }),
      json: async () => ({ result: 'ok' }),
    } as any)

    await program.parseAsync([
      'node', 'test', 'run', 'team-org/team-agent',
      '--data', '{"test": true}',
    ])

    // Verify secrets were checked using the resolved workspace ID
    expect(mockRequest).toHaveBeenCalledWith(
      expect.any(Object), 'GET', '/workspaces/ws-team-123/secrets'
    )

    // Should proceed to actual run
    expect(mockSafeFetchWithRetryForCalls).toHaveBeenCalled()
  })
})

describe('localCommandForEntrypoint', () => {
  it('returns python3 for .py files', () => {
    expect(localCommandForEntrypoint('main.py')).toBe('python3')
    expect(localCommandForEntrypoint('sandbox_main.py')).toBe('python3')
  })

  it('returns node for .js files', () => {
    expect(localCommandForEntrypoint('main.js')).toBe('node')
    expect(localCommandForEntrypoint('index.js')).toBe('node')
  })

  it('returns node for .mjs files', () => {
    expect(localCommandForEntrypoint('main.mjs')).toBe('node')
  })

  it('returns node for .cjs files', () => {
    expect(localCommandForEntrypoint('main.cjs')).toBe('node')
  })

  it('defaults to python3 for unknown extensions', () => {
    expect(localCommandForEntrypoint('main.rb')).toBe('python3')
    expect(localCommandForEntrypoint('main.ts')).toBe('python3')
  })
})

describe('UX-4: validateInputSchema', () => {
  const schema = {
    properties: {
      code: { type: 'string', description: 'Source code to analyze' },
      language: { type: 'string' },
      max_issues: { type: 'number' },
      strict: { type: 'boolean' },
      tags: { type: 'array' },
      config: { type: 'object' },
    },
    required: ['code'],
  }

  it('returns no errors for valid input', () => {
    const errors = validateInputSchema({ code: 'console.log("hi")' }, schema)
    expect(errors).toEqual([])
  })

  it('returns no errors when all fields match types', () => {
    const errors = validateInputSchema({
      code: 'x = 1',
      language: 'python',
      max_issues: 5,
      strict: true,
      tags: ['lint', 'security'],
      config: { level: 'warn' },
    }, schema)
    expect(errors).toEqual([])
  })

  it('reports missing required fields', () => {
    const errors = validateInputSchema({ language: 'python' }, schema)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Missing required field: "code"')
    expect(errors[0]).toContain('Source code to analyze')
  })

  it('reports multiple missing required fields', () => {
    const multiReqSchema = {
      properties: {
        name: { type: 'string' },
        age: { type: 'number', description: 'User age' },
      },
      required: ['name', 'age'],
    }
    const errors = validateInputSchema({}, multiReqSchema)
    expect(errors).toHaveLength(2)
    expect(errors[0]).toContain('"name"')
    expect(errors[1]).toContain('"age"')
    expect(errors[1]).toContain('User age')
  })

  it('reports type mismatch: expected string got number', () => {
    const errors = validateInputSchema({ code: 42 }, schema)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBe('Field "code" should be string, got number')
  })

  it('reports type mismatch: expected number got string', () => {
    const errors = validateInputSchema({ code: 'x', max_issues: 'five' }, schema)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBe('Field "max_issues" should be number, got string')
  })

  it('reports type mismatch: expected boolean got string', () => {
    const errors = validateInputSchema({ code: 'x', strict: 'yes' }, schema)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBe('Field "strict" should be boolean, got string')
  })

  it('reports type mismatch: expected array got object', () => {
    const errors = validateInputSchema({ code: 'x', tags: { a: 1 } }, schema)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBe('Field "tags" should be array, got object')
  })

  it('reports type mismatch: expected object got array', () => {
    const errors = validateInputSchema({ code: 'x', config: [1, 2] }, schema)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBe('Field "config" should be object, got array')
  })

  it('validates integer type same as number', () => {
    const intSchema = {
      properties: { count: { type: 'integer' } },
      required: ['count'],
    }
    expect(validateInputSchema({ count: 5 }, intSchema)).toEqual([])
    const errors = validateInputSchema({ count: 'five' }, intSchema)
    expect(errors[0]).toBe('Field "count" should be integer, got string')
  })

  it('reports both missing required and type errors', () => {
    const errors = validateInputSchema({ max_issues: 'bad' }, schema)
    expect(errors).toHaveLength(2)
    expect(errors[0]).toContain('Missing required field: "code"')
    expect(errors[1]).toContain('Field "max_issues" should be number, got string')
  })

  it('returns empty array when schema is undefined', () => {
    expect(validateInputSchema({ anything: 'goes' }, undefined)).toEqual([])
  })

  it('returns empty array when schema has no properties', () => {
    expect(validateInputSchema({ anything: 'goes' }, {})).toEqual([])
  })

  it('skips type check for null values', () => {
    const errors = validateInputSchema({ code: 'x', language: null }, schema)
    expect(errors).toEqual([])
  })

  it('skips type check for fields not in schema properties', () => {
    const errors = validateInputSchema({ code: 'x', unknown_field: 123 }, schema)
    expect(errors).toEqual([])
  })

  it('skips type check when property has no type defined', () => {
    const noTypeSchema = {
      properties: { data: { description: 'some data' } },
      required: [] as string[],
    }
    expect(validateInputSchema({ data: 42 }, noTypeSchema)).toEqual([])
  })

  it('treats null required field as missing', () => {
    const errors = validateInputSchema({ code: null }, schema)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Missing required field: "code"')
  })
})

// ─── UX-5: File input auto-detection ──────────────────────────────────────────

describe('UX-5: inferFileField', () => {
  it('returns "content" when no schema is provided', () => {
    expect(inferFileField(undefined)).toBe('content')
    expect(inferFileField(null as unknown as object)).toBe('content')
  })

  it('returns "content" when schema has no properties', () => {
    expect(inferFileField({})).toBe('content')
    expect(inferFileField({ required: ['foo'] })).toBe('content')
  })

  it('detects well-known field names (code, content, text, etc.)', () => {
    expect(inferFileField({
      properties: { code: { type: 'string' }, lang: { type: 'string' } },
    })).toBe('code')

    expect(inferFileField({
      properties: { lang: { type: 'string' }, text: { type: 'string' } },
    })).toBe('text')

    expect(inferFileField({
      properties: { source: { type: 'string' }, level: { type: 'number' } },
    })).toBe('source')

    expect(inferFileField({
      properties: { body: { type: 'string' }, meta: { type: 'object' } },
    })).toBe('body')

    expect(inferFileField({
      properties: { file_content: { type: 'string' } },
    })).toBe('file_content')
  })

  it('skips well-known names that are not type string', () => {
    // "code" exists but is a number — should not match
    expect(inferFileField({
      properties: { code: { type: 'number' }, data: { type: 'string' } },
    })).toBe('data') // falls through to single-string-prop detection
  })

  it('uses the only string property when exactly one exists', () => {
    expect(inferFileField({
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
        verbose: { type: 'boolean' },
      },
    })).toBe('query')
  })

  it('uses the only required string property when multiple strings exist', () => {
    expect(inferFileField({
      properties: {
        data: { type: 'string' },
        format: { type: 'string' },
        label: { type: 'string' },
      },
      required: ['data'],
    })).toBe('data')
  })

  it('returns null when multiple required string fields exist and none are well-known', () => {
    const result = inferFileField({
      properties: {
        query: { type: 'string' },
        context: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query', 'context'],
    })
    expect(result).toBeNull()
  })

  it('returns null when multiple string fields exist, none required, none well-known', () => {
    const result = inferFileField({
      properties: {
        data: { type: 'string' },
        payload: { type: 'string' },
      },
    })
    expect(result).toBeNull()
  })

  it('returns null when schema has properties but no string fields at all', () => {
    const result = inferFileField({
      properties: {
        count: { type: 'number' },
        enabled: { type: 'boolean' },
      },
    })
    expect(result).toBeNull()
  })

  it('prefers well-known names over single-string or required-string heuristics', () => {
    // "content" is well-known and should win even though "data" is the only required string
    expect(inferFileField({
      properties: {
        content: { type: 'string' },
        data: { type: 'string' },
      },
      required: ['data'],
    })).toBe('content')
  })
})

describe('UX-4: Client-side schema validation in cloud execution', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()

    program = new Command()
    program.exitOverride()
    registerRunCommand(program)

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'test-org',
    })
    mockLoadConfig.mockResolvedValue({})
    mockGetDefaultProvider.mockResolvedValue(undefined)
    mockResolveWorkspaceIdForOrg.mockResolvedValue(undefined)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('warns about missing required fields before cloud execution', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      id: 'agent-1',
      org_name: 'Test',
      org_slug: 'test-org',
      name: 'validator',
      version: 'v1',
      type: 'prompt',
      input_schema: {
        properties: {
          code: { type: 'string', description: 'Code to review' },
        },
        required: ['code'],
      },
    })

    // Mock a successful response so execution continues after the warning
    mockSafeFetchWithRetryForCalls.mockResolvedValue(
      new Response(JSON.stringify({ result: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )

    await program.parseAsync([
      'node', 'test', 'run', 'test-org/validator@v1',
      '--data', '{"language": "python"}',
    ])

    const stderrOutput = stderrSpy.mock.calls.map(c => String(c[0])).join('')
    expect(stderrOutput).toContain('Input validation warning')
    expect(stderrOutput).toContain('Missing required field: "code"')
  })

  it('warns about type mismatches before cloud execution', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      id: 'agent-1',
      org_name: 'Test',
      org_slug: 'test-org',
      name: 'validator',
      version: 'v1',
      type: 'prompt',
      input_schema: {
        properties: {
          count: { type: 'number' },
        },
        required: [],
      },
    })

    mockSafeFetchWithRetryForCalls.mockResolvedValue(
      new Response(JSON.stringify({ result: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )

    await program.parseAsync([
      'node', 'test', 'run', 'test-org/validator@v1',
      '--data', '{"count": "not-a-number"}',
    ])

    const stderrOutput = stderrSpy.mock.calls.map(c => String(c[0])).join('')
    expect(stderrOutput).toContain('Input validation warning')
    expect(stderrOutput).toContain('should be number, got string')
  })

  it('does not warn when input matches schema', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      id: 'agent-1',
      org_name: 'Test',
      org_slug: 'test-org',
      name: 'validator',
      version: 'v1',
      type: 'prompt',
      input_schema: {
        properties: {
          code: { type: 'string' },
        },
        required: ['code'],
      },
    })

    mockSafeFetchWithRetryForCalls.mockResolvedValue(
      new Response(JSON.stringify({ result: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )

    await program.parseAsync([
      'node', 'test', 'run', 'test-org/validator@v1',
      '--data', '{"code": "hello world"}',
    ])

    const stderrOutput = stderrSpy.mock.calls.map(c => String(c[0])).join('')
    expect(stderrOutput).not.toContain('Input validation warning')
  })
})

// ─── BUG-13: Error messages should not be printed twice ───────────────────────

describe('BUG-13: SSE streaming errors not printed twice', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerRunCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'test-org',
    })
    mockLoadConfig.mockResolvedValue({})
    mockGetDefaultProvider.mockResolvedValue(undefined)
    mockResolveWorkspaceIdForOrg.mockResolvedValue(undefined)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    exitSpy.mockRestore()
    vi.restoreAllMocks()
  })

  function createSSEStream(events: Array<{ event: string; data: string }>): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    const sseText = events
      .map(e => `event: ${e.event}\ndata: ${e.data}\n\n`)
      .join('')
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseText))
        controller.close()
      },
    })
  }

  it('does not duplicate error when SSE stream has both progress error and error event', async () => {
    const errorMessage = 'Agent crashed: ModuleNotFoundError'

    mockGetAgentWithFallback.mockResolvedValue({
      type: 'agent',
      execution_engine: 'managed_loop',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    const sseBody = createSSEStream([
      { event: 'progress', data: JSON.stringify({ type: 'sandbox_start' }) },
      { event: 'progress', data: JSON.stringify({ type: 'error', message: errorMessage }) },
      { event: 'error', data: JSON.stringify({ error: { message: errorMessage } }) },
    ])

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: sseBody,
    } as any)

    try {
      await program.parseAsync([
        'node', 'test', 'run', 'test-org/test-agent',
        '--data', '{"task": "test"}',
      ])
      expect.fail('Should have thrown')
    } catch (err: any) {
      // The CliError should have displayed=true since the progress event already showed it
      expect(err.displayed).toBe(true)
    }

    const stderrOutput = stderrSpy.mock.calls.map(c => String(c[0])).join('')
    // Error should appear only once (from renderProgress), not duplicated
    const occurrences = stderrOutput.split(errorMessage).length - 1
    expect(occurrences).toBe(1)
  })

  it('still prints error when SSE has error event but no progress error', async () => {
    const errorMessage = 'Internal server error'

    mockGetAgentWithFallback.mockResolvedValue({
      type: 'agent',
      execution_engine: 'managed_loop',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    const sseBody = createSSEStream([
      { event: 'progress', data: JSON.stringify({ type: 'sandbox_start' }) },
      // No progress error event — only the SSE error event
      { event: 'error', data: JSON.stringify({ error: { message: errorMessage } }) },
    ])

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: sseBody,
    } as any)

    try {
      await program.parseAsync([
        'node', 'test', 'run', 'test-org/test-agent',
        '--data', '{"task": "test"}',
      ])
      expect.fail('Should have thrown')
    } catch (err: any) {
      // displayed should NOT be true — the error wasn't shown during streaming
      expect(err.displayed).toBeFalsy()
      expect(err.message).toBe(errorMessage)
    }
  })
})

// ─── UX-007: --verbose flag on orch run ────────────────────────────────────────

describe('renderProgress verbose control', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })
  afterEach(() => {
    stderrSpy.mockRestore()
  })

  function stderrOutput(): string {
    return stderrSpy.mock.calls.map(c => String(c[0])).join('')
  }

  // ── stdout/stderr suppressed by default (verbose=false) ──

  it('suppresses stdout events when verbose is false', () => {
    renderProgress({ type: 'stdout', text: 'Hello from sandbox\n' })
    expect(stderrOutput()).toBe('')
  })

  it('suppresses stderr events when verbose is false', () => {
    renderProgress({ type: 'stderr', text: 'WARNING: deprecated\n' })
    expect(stderrOutput()).toBe('')
  })

  it('suppresses stdout events when verbose is omitted (default)', () => {
    renderProgress({ type: 'stdout', text: 'debug output' })
    expect(stderrOutput()).toBe('')
  })

  // ── stdout/stderr shown when verbose=true ──

  it('shows stdout events when verbose is true', () => {
    renderProgress({ type: 'stdout', text: 'Hello from sandbox\n' }, true)
    expect(stderrOutput()).toContain('Hello from sandbox')
  })

  it('shows stderr events when verbose is true', () => {
    renderProgress({ type: 'stderr', text: 'WARNING: deprecated\n' }, true)
    expect(stderrOutput()).toContain('WARNING: deprecated')
  })

  it('handles empty stdout text gracefully', () => {
    renderProgress({ type: 'stdout', text: '' }, true)
    expect(stderrOutput()).toBe('')
  })

  it('handles empty stderr text gracefully', () => {
    renderProgress({ type: 'stderr', text: '' }, true)
    expect(stderrOutput()).toBe('')
  })

  it('handles non-string stdout text gracefully', () => {
    renderProgress({ type: 'stdout', text: 42 }, true)
    expect(stderrOutput()).toBe('')
  })

  it('handles missing text field gracefully', () => {
    renderProgress({ type: 'stderr' }, true)
    expect(stderrOutput()).toBe('')
  })

  // ── Structural events always shown regardless of verbose ──

  it('shows sandbox_start regardless of verbose', () => {
    renderProgress({ type: 'sandbox_start' })
    expect(stderrOutput()).toContain('Starting sandbox')
  })

  it('shows setup_step regardless of verbose', () => {
    renderProgress({ type: 'setup_step', name: 'install_deps', status: 'completed' })
    expect(stderrOutput()).toContain('install_deps')
    expect(stderrOutput()).toContain('completed')
  })

  it('shows turn_start regardless of verbose', () => {
    renderProgress({ type: 'turn_start', turn: 2, max_turns: 5 })
    expect(stderrOutput()).toContain('Turn 2/5')
  })

  it('shows tool_call regardless of verbose', () => {
    renderProgress({ type: 'tool_call', tool: 'bash', args_brief: 'ls -la' })
    expect(stderrOutput()).toContain('bash')
    expect(stderrOutput()).toContain('ls -la')
  })

  it('shows error regardless of verbose', () => {
    renderProgress({ type: 'error', message: 'Sandbox crashed' })
    expect(stderrOutput()).toContain('Sandbox crashed')
  })

  it('shows done regardless of verbose', () => {
    renderProgress({ type: 'done' })
    expect(stderrOutput()).toContain('Done')
  })

  it('shows output_truncated regardless of verbose', () => {
    renderProgress({ type: 'output_truncated' })
    expect(stderrOutput()).toContain('truncated')
  })

  it('shows tool_result error regardless of verbose', () => {
    renderProgress({ type: 'tool_result', status: 'error' })
    expect(stderrOutput()).toContain('error')
  })

  // ── verbose=true done event shows extra detail ──

  it('done event shows exit_code when non-zero and verbose', () => {
    renderProgress({ type: 'done', exit_code: 1, execution_time_ms: 4500 }, true)
    const output = stderrOutput()
    expect(output).toContain('Done')
    expect(output).toContain('exit_code=1')
    expect(output).toContain('4.5s')
  })

  it('done event hides exit_code when zero and verbose', () => {
    renderProgress({ type: 'done', exit_code: 0, execution_time_ms: 2000 }, true)
    const output = stderrOutput()
    expect(output).toContain('Done')
    expect(output).not.toContain('exit_code')
    expect(output).toContain('2.0s')
  })

  it('done event shows no extras without verbose', () => {
    renderProgress({ type: 'done', exit_code: 1, execution_time_ms: 4500 })
    const output = stderrOutput()
    expect(output).toContain('Done')
    expect(output).not.toContain('exit_code')
    expect(output).not.toContain('4.5s')
  })

  // ── heartbeat always silent ──

  it('heartbeat is always silent', () => {
    renderProgress({ type: 'heartbeat' })
    renderProgress({ type: 'heartbeat' }, true)
    expect(stderrOutput()).toBe('')
  })

  // ── setup_step icon variants ──

  it('setup_step shows ✓ icon for completed status', () => {
    renderProgress({ type: 'setup_step', name: 'write_code', status: 'completed' })
    expect(stderrOutput()).toContain('✓')
  })

  it('setup_step shows x icon for failed status', () => {
    renderProgress({ type: 'setup_step', name: 'write_code', status: 'failed' })
    expect(stderrOutput()).toContain('x')
  })

  it('setup_step shows · icon for started status', () => {
    renderProgress({ type: 'setup_step', name: 'write_code', status: 'started' })
    expect(stderrOutput()).toContain('·')
  })

  // ── tool_call icon variants ──

  it('tool_call uses $ icon for bash', () => {
    renderProgress({ type: 'tool_call', tool: 'bash' })
    expect(stderrOutput()).toContain('$')
  })

  it('tool_call uses > icon for read_file', () => {
    renderProgress({ type: 'tool_call', tool: 'read_file' })
    expect(stderrOutput()).toContain('>')
  })

  it('tool_call uses < icon for write_file', () => {
    renderProgress({ type: 'tool_call', tool: 'write_file' })
    expect(stderrOutput()).toContain('<')
  })

  it('tool_call uses ~ icon for other tools', () => {
    renderProgress({ type: 'tool_call', tool: 'orch_call' })
    expect(stderrOutput()).toContain('~')
  })
})

describe('UX-007: --verbose flag in streaming mode', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerRunCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'test-org',
    })
    mockLoadConfig.mockResolvedValue({})
    mockGetDefaultProvider.mockResolvedValue(undefined)
    mockResolveWorkspaceIdForOrg.mockResolvedValue(undefined)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  function stderrOutput(): string {
    return stderrSpy.mock.calls.map(c => String(c[0])).join('')
  }

  function createSSEStream(events: Array<{ event: string; data: string }>): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    const sseText = events
      .map(e => `event: ${e.event}\ndata: ${e.data}\n\n`)
      .join('')
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseText))
        controller.close()
      },
    })
  }

  it('shows stdout/stderr in streaming when --verbose is set', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'agent',
      execution_engine: 'managed_loop',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    const sseBody = createSSEStream([
      { event: 'progress', data: JSON.stringify({ type: 'sandbox_start' }) },
      { event: 'progress', data: JSON.stringify({ type: 'stdout', text: 'installing deps...\n' }) },
      { event: 'progress', data: JSON.stringify({ type: 'stderr', text: 'WARN: old version\n' }) },
      { event: 'progress', data: JSON.stringify({ type: 'done' }) },
      { event: 'result', data: JSON.stringify({ output: 'success', metadata: {} }) },
    ])

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: sseBody,
    } as any)

    await program.parseAsync([
      'node', 'test', 'run', 'test-org/test-agent',
      '--data', '{"task": "test"}',
      '--verbose',
    ])

    const output = stderrOutput()
    expect(output).toContain('installing deps...')
    expect(output).toContain('WARN: old version')
    expect(output).toContain('(verbose)')
  })

  it('suppresses stdout/stderr in streaming when --verbose is NOT set', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'agent',
      execution_engine: 'managed_loop',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    const sseBody = createSSEStream([
      { event: 'progress', data: JSON.stringify({ type: 'sandbox_start' }) },
      { event: 'progress', data: JSON.stringify({ type: 'stdout', text: 'installing deps...\n' }) },
      { event: 'progress', data: JSON.stringify({ type: 'stderr', text: 'WARN: old version\n' }) },
      { event: 'progress', data: JSON.stringify({ type: 'done' }) },
      { event: 'result', data: JSON.stringify({ output: 'success', metadata: {} }) },
    ])

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: sseBody,
    } as any)

    await program.parseAsync([
      'node', 'test', 'run', 'test-org/test-agent',
      '--data', '{"task": "test"}',
    ])

    const output = stderrOutput()
    expect(output).not.toContain('installing deps...')
    expect(output).not.toContain('WARN: old version')
    expect(output).not.toContain('(verbose)')
    // Structural events should still be shown
    expect(output).toContain('Starting sandbox')
    expect(output).toContain('Done')
  })

  it('shows verbose debug header with agent metadata', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'tool',
      execution_engine: 'code_runtime',
      name: 'my-tool',
      version: 'v3',
      supported_providers: ['any'],
    } as any)

    const sseBody = createSSEStream([
      { event: 'progress', data: JSON.stringify({ type: 'done' }) },
      { event: 'result', data: JSON.stringify({ output: 'ok', metadata: {} }) },
    ])

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: sseBody,
    } as any)

    await program.parseAsync([
      'node', 'test', 'run', 'test-org/my-tool@v3',
      '--data', '{}',
      '--verbose',
    ])

    const output = stderrOutput()
    // canonicalAgentType now correctly preserves 'tool' type
    expect(output).toContain('type=tool')
    expect(output).toContain('engine=code_runtime')
    expect(output).toContain('endpoint=analyze')
  })

  it('shows verbose pre-request header for non-streaming runs', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'prompt',
      execution_engine: 'direct_llm',
      name: 'prompter',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({
        output: 'result',
        metadata: {
          stdout: 'sandbox stdout here',
          stderr: 'sandbox stderr here',
          processing_time_ms: 3200,
        },
      }),
    } as any)

    await program.parseAsync([
      'node', 'test', 'run', 'test-org/prompter',
      '--data', '{}',
      '--verbose',
    ])

    const output = stderrOutput()
    // Pre-request debug header
    expect(output).toContain('[verbose]')
    // canonicalAgentType now correctly preserves 'prompt' type
    expect(output).toContain('type=prompt')
    expect(output).toContain('engine=direct_llm')
    // Non-streaming verbose shows stdout/stderr in dedicated sections
    expect(output).toContain('--- stderr ---')
    expect(output).toContain('sandbox stderr here')
    expect(output).toContain('--- stdout ---')
    expect(output).toContain('sandbox stdout here')

    // UX-13b-01: JSON payload should NOT contain metadata.stdout/stderr
    // (they're shown in the dedicated sections above, not duplicated in JSON)
    const jsonOutput = stdoutSpy.mock.calls.map(c => String(c[0])).join('')
    expect(jsonOutput).not.toContain('sandbox stdout here')
    expect(jsonOutput).not.toContain('sandbox stderr here')
    // But other metadata fields (e.g. processing_time_ms) should still be in JSON
    expect(jsonOutput).toContain('processing_time_ms')
  })

  it('non-streaming hides stdout/stderr without --verbose', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'prompt',
      execution_engine: 'direct_llm',
      name: 'prompter',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({
        output: 'result',
        metadata: {
          stdout: 'sandbox stdout here',
          stderr: 'sandbox stderr here',
        },
      }),
    } as any)

    await program.parseAsync([
      'node', 'test', 'run', 'test-org/prompter',
      '--data', '{}',
    ])

    const output = stderrOutput()
    expect(output).not.toContain('--- stderr ---')
    expect(output).not.toContain('--- stdout ---')
    expect(output).not.toContain('[verbose]')
  })

  it('passes ?verbose=true query parameter when --verbose is set', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'prompt',
      execution_engine: 'direct_llm',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ output: 'ok', metadata: {} }),
    } as any)

    await program.parseAsync([
      'node', 'test', 'run', 'test-org/test-agent',
      '--data', '{}',
      '--verbose',
    ])

    const fetchCall = mockSafeFetchWithRetryForCalls.mock.calls[0]
    expect(fetchCall[0]).toContain('?verbose=true')
  })

  it('does not pass ?verbose=true when --verbose is not set', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'prompt',
      execution_engine: 'direct_llm',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ output: 'ok', metadata: {} }),
    } as any)

    await program.parseAsync([
      'node', 'test', 'run', 'test-org/test-agent',
      '--data', '{}',
    ])

    const fetchCall = mockSafeFetchWithRetryForCalls.mock.calls[0]
    expect(fetchCall[0]).not.toContain('verbose=true')
  })

  it('--verbose shows done event execution details in streaming', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'agent',
      execution_engine: 'managed_loop',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    const sseBody = createSSEStream([
      { event: 'progress', data: JSON.stringify({ type: 'sandbox_start' }) },
      { event: 'progress', data: JSON.stringify({ type: 'done', exit_code: 1, execution_time_ms: 8200 }) },
      { event: 'result', data: JSON.stringify({ output: 'partial', metadata: {} }) },
    ])

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: sseBody,
    } as any)

    await program.parseAsync([
      'node', 'test', 'run', 'test-org/test-agent',
      '--data', '{}',
      '--verbose',
    ])

    const output = stderrOutput()
    expect(output).toContain('exit_code=1')
    expect(output).toContain('8.2s')
  })

  it('--verbose is suppressed when --json is set', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'prompt',
      execution_engine: 'direct_llm',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ output: 'ok', metadata: { stdout: 'test' } }),
    } as any)

    await program.parseAsync([
      'node', 'test', 'run', 'test-org/test-agent',
      '--data', '{}',
      '--verbose',
      '--json',
    ])

    const output = stderrOutput()
    // Pre-request verbose header is suppressed in --json mode
    expect(output).not.toContain('[verbose]')
  })

  // ── UX-13b-01: verbose mode stdout deduplication ──

  it('UX-13b-01: verbose strips metadata.stdout/stderr from JSON but shows in sections', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'agent',
      execution_engine: 'managed_loop',
      name: 'my-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({
        data: { result: 'ok' },
        metadata: {
          stdout: 'agent stdout output',
          stderr: 'agent stderr output',
          processing_time_ms: 1500,
          execution_time_ms: 1200,
        },
      }),
    } as any)

    await program.parseAsync([
      'node', 'test', 'run', 'test-org/my-agent',
      '--data', '{}',
      '--verbose',
    ])

    // Dedicated sections on stderr should show the output
    const errOutput = stderrOutput()
    expect(errOutput).toContain('--- stdout ---')
    expect(errOutput).toContain('agent stdout output')
    expect(errOutput).toContain('--- stderr ---')
    expect(errOutput).toContain('agent stderr output')

    // JSON on stdout should NOT contain metadata.stdout/stderr (deduplication)
    const jsonOutput = stdoutSpy.mock.calls.map(c => String(c[0])).join('')
    expect(jsonOutput).not.toContain('agent stdout output')
    expect(jsonOutput).not.toContain('agent stderr output')
    // But other metadata fields should remain
    expect(jsonOutput).toContain('processing_time_ms')
    expect(jsonOutput).toContain('execution_time_ms')
    expect(jsonOutput).toContain('"result": "ok"')
  })

  it('UX-13b-01: --json mode still includes metadata.stdout/stderr in payload', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'agent',
      execution_engine: 'managed_loop',
      name: 'my-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({
        data: { result: 'ok' },
        metadata: {
          stdout: 'full stdout preserved',
          stderr: 'full stderr preserved',
        },
      }),
    } as any)

    await program.parseAsync([
      'node', 'test', 'run', 'test-org/my-agent',
      '--data', '{}',
      '--json',
    ])

    // --json returns the complete payload with stdout/stderr intact
    const jsonOutput = stdoutSpy.mock.calls.map(c => String(c[0])).join('')
    expect(jsonOutput).toContain('full stdout preserved')
    expect(jsonOutput).toContain('full stderr preserved')
  })

  it('UX-13b-01: non-verbose mode keeps metadata.stdout/stderr in JSON payload', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'prompt',
      execution_engine: 'direct_llm',
      name: 'prompter',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({
        output: 'result',
        metadata: {
          stdout: 'still in json',
          stderr: 'still in json too',
        },
      }),
    } as any)

    await program.parseAsync([
      'node', 'test', 'run', 'test-org/prompter',
      '--data', '{}',
    ])

    // Without --verbose, metadata.stdout/stderr stay in the JSON output
    const jsonOutput = stdoutSpy.mock.calls.map(c => String(c[0])).join('')
    expect(jsonOutput).toContain('still in json')
    expect(jsonOutput).toContain('still in json too')
    // And no dedicated sections on stderr
    const errOutput = stderrOutput()
    expect(errOutput).not.toContain('--- stdout ---')
    expect(errOutput).not.toContain('--- stderr ---')
  })

  it('UX-13b-01: code_runtime verbose skips stdout section when data matches stdout', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'tool',
      execution_engine: 'code_runtime',
      name: 'my-tool',
      version: 'v2',
      supported_providers: ['any'],
    } as any)

    const toolOutput = '{"score": 42, "label": "positive"}'
    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({
        data: toolOutput,
        metadata: {
          stdout: toolOutput,
          stderr: 'pip install complete',
        },
      }),
    } as any)

    await program.parseAsync([
      'node', 'test', 'run', 'test-org/my-tool@v2',
      '--data', '{}',
      '--verbose',
    ])

    const errOutput = stderrOutput()
    // stderr section should still show (different content from data)
    expect(errOutput).toContain('--- stderr ---')
    expect(errOutput).toContain('pip install complete')
    // stdout section should be SKIPPED because stdout === data for code_runtime
    expect(errOutput).not.toContain('--- stdout ---')
  })

  it('UX-13b-01: code_runtime verbose shows stdout when it differs from data', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'tool',
      execution_engine: 'code_runtime',
      name: 'my-tool',
      version: 'v2',
      supported_providers: ['any'],
    } as any)

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({
        data: { score: 42 },
        metadata: {
          stdout: 'debug line 1\ndebug line 2\n{"score": 42}',
          stderr: '',
        },
      }),
    } as any)

    await program.parseAsync([
      'node', 'test', 'run', 'test-org/my-tool@v2',
      '--data', '{}',
      '--verbose',
    ])

    const errOutput = stderrOutput()
    // stdout differs from data (has extra debug lines) — should show
    expect(errOutput).toContain('--- stdout ---')
    expect(errOutput).toContain('debug line 1')
  })

  it('UX-13b-01: verbose with no metadata.stdout/stderr shows "No sandbox output"', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'prompt',
      execution_engine: 'direct_llm',
      name: 'prompter',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({
        output: 'result',
        metadata: { processing_time_ms: 500 },
      }),
    } as any)

    await program.parseAsync([
      'node', 'test', 'run', 'test-org/prompter',
      '--data', '{}',
      '--verbose',
    ])

    const errOutput = stderrOutput()
    expect(errOutput).toContain('No sandbox output captured')
  })
})

describe('BUG-D: tryParseJsonObject — piped JSON stdin auto-detection', () => {
  it('parses a valid JSON object', () => {
    const buf = Buffer.from('{"text": "hello", "count": 42}')
    const result = tryParseJsonObject(buf)
    expect(result).toEqual({ text: 'hello', count: 42 })
  })

  it('parses JSON object with leading/trailing whitespace', () => {
    const buf = Buffer.from('  \n  {"key": "value"}  \n  ')
    const result = tryParseJsonObject(buf)
    expect(result).toEqual({ key: 'value' })
  })

  it('returns null for JSON arrays', () => {
    const buf = Buffer.from('[1, 2, 3]')
    expect(tryParseJsonObject(buf)).toBeNull()
  })

  it('returns null for plain strings', () => {
    const buf = Buffer.from('"just a string"')
    expect(tryParseJsonObject(buf)).toBeNull()
  })

  it('returns null for numbers', () => {
    const buf = Buffer.from('42')
    expect(tryParseJsonObject(buf)).toBeNull()
  })

  it('returns null for invalid JSON starting with {', () => {
    const buf = Buffer.from('{not valid json}')
    expect(tryParseJsonObject(buf)).toBeNull()
  })

  it('returns null for binary data', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]) // PNG header
    expect(tryParseJsonObject(buf)).toBeNull()
  })

  it('returns null for empty buffer', () => {
    const buf = Buffer.from('')
    expect(tryParseJsonObject(buf)).toBeNull()
  })

  it('returns null for whitespace-only buffer', () => {
    const buf = Buffer.from('   \n\t  ')
    expect(tryParseJsonObject(buf)).toBeNull()
  })

  it('parses nested JSON objects', () => {
    const buf = Buffer.from('{"task": "analyze", "options": {"verbose": true}}')
    const result = tryParseJsonObject(buf)
    expect(result).toEqual({ task: 'analyze', options: { verbose: true } })
  })

  it('returns null for plain text that looks like prose', () => {
    const buf = Buffer.from('Please analyze this code for bugs')
    expect(tryParseJsonObject(buf)).toBeNull()
  })
})

// ─── BUG-6: CLI reports failure when SSE stream times out ─────────────────────

describe('BUG-6: SSE stream timeout shows "still running" instead of failure', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerRunCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'test-org',
    })
    mockLoadConfig.mockResolvedValue({})
    mockGetDefaultProvider.mockResolvedValue(undefined)
    mockResolveWorkspaceIdForOrg.mockResolvedValue(undefined)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  function stderrOutput(): string {
    return stderrSpy.mock.calls.map(c => String(c[0])).join('')
  }

  /**
   * Create a ReadableStream that emits some SSE events, then throws an
   * AbortError (simulating AbortSignal.timeout firing mid-stream).
   */
  function createTimingOutSSEStream(
    events: Array<{ event: string; data: string }>
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    let pushed = false
    return new ReadableStream({
      pull(controller) {
        if (!pushed) {
          pushed = true
          const sseText = events
            .map(e => `event: ${e.event}\ndata: ${e.data}\n\n`)
            .join('')
          controller.enqueue(encoder.encode(sseText))
          return
        }
        // Simulate AbortSignal.timeout firing
        const err = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
        controller.error(err)
      },
    })
  }

  it('shows "still in progress" when SSE stream times out with run-id', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'agent',
      execution_engine: 'managed_loop',
      name: 'orchestrator',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    const sseBody = createTimingOutSSEStream([
      { event: 'progress', data: JSON.stringify({ type: 'sandbox_start' }) },
      { event: 'progress', data: JSON.stringify({ type: 'turn_start', turn: 1, max_turns: 10 }) },
      { event: 'progress', data: JSON.stringify({ type: 'turn_start', turn: 2, max_turns: 10 }) },
    ])

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-type': 'text/event-stream',
        'x-run-id': 'run_abc123',
      }),
      body: sseBody,
    } as any)

    try {
      await program.parseAsync([
        'node', 'test', 'run', 'test-org/orchestrator',
        '--data', '{"task": "test"}',
      ])
      expect.fail('Should have thrown')
    } catch (err: any) {
      // Should NOT say "failed" or show a generic network error
      const output = stderrOutput()
      expect(output).toContain('still in progress')
      expect(output).toContain('run_abc123')
      expect(output).toContain('orch logs')
      // The error should be marked as displayed (message already shown via stderr)
      expect(err.displayed).toBe(true)
    }
  })

  it('shows "still in progress" when SSE stream times out without run-id', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'agent',
      execution_engine: 'managed_loop',
      name: 'orchestrator',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    const sseBody = createTimingOutSSEStream([
      { event: 'progress', data: JSON.stringify({ type: 'sandbox_start' }) },
    ])

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-type': 'text/event-stream',
        // No x-run-id header
      }),
      body: sseBody,
    } as any)

    try {
      await program.parseAsync([
        'node', 'test', 'run', 'test-org/orchestrator',
        '--data', '{"task": "test"}',
      ])
      expect.fail('Should have thrown')
    } catch (err: any) {
      const output = stderrOutput()
      expect(output).toContain('still in progress')
      expect(output).toContain('orch runs')
      expect(err.displayed).toBe(true)
    }
  })

  it('handles AbortError (non-timeout) the same way', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'agent',
      execution_engine: 'managed_loop',
      name: 'orchestrator',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    // AbortError (from manual abort or signal) should also show "still in progress"
    const encoder = new TextEncoder()
    let pushed = false
    const sseBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!pushed) {
          pushed = true
          const sseText = `event: progress\ndata: ${JSON.stringify({ type: 'sandbox_start' })}\n\n`
          controller.enqueue(encoder.encode(sseText))
          return
        }
        controller.error(new DOMException('The operation was aborted', 'AbortError'))
      },
    })

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-type': 'text/event-stream',
        'x-run-id': 'run_xyz789',
      }),
      body: sseBody,
    } as any)

    try {
      await program.parseAsync([
        'node', 'test', 'run', 'test-org/orchestrator',
        '--data', '{"task": "test"}',
      ])
      expect.fail('Should have thrown')
    } catch (err: any) {
      const output = stderrOutput()
      expect(output).toContain('still in progress')
      expect(output).toContain('run_xyz789')
      expect(err.displayed).toBe(true)
    }
  })

  it('passes through real SSE errors (non-timeout) normally', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'agent',
      execution_engine: 'managed_loop',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    // A real error from the server (not a timeout) should still throw CliError
    const encoder = new TextEncoder()
    let pushed = false
    const sseBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!pushed) {
          pushed = true
          const events = [
            `event: progress\ndata: ${JSON.stringify({ type: 'sandbox_start' })}\n\n`,
            `event: error\ndata: ${JSON.stringify({ error: { message: 'Agent crashed: OOM' } })}\n\n`,
          ].join('')
          controller.enqueue(encoder.encode(events))
          return
        }
        controller.close()
      },
    })

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: sseBody,
    } as any)

    try {
      await program.parseAsync([
        'node', 'test', 'run', 'test-org/test-agent',
        '--data', '{"task": "test"}',
      ])
      expect.fail('Should have thrown')
    } catch (err: any) {
      // Real errors should NOT say "still in progress"
      expect(err.message).toBe('Agent crashed: OOM')
      const output = stderrOutput()
      expect(output).not.toContain('still in progress')
    }
  })

  it('uses --wait-timeout value for streaming timeout', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'agent',
      execution_engine: 'managed_loop',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    } as any)

    // Normal successful SSE stream
    const encoder = new TextEncoder()
    const sseText = [
      `event: progress\ndata: ${JSON.stringify({ type: 'done' })}\n\n`,
      `event: result\ndata: ${JSON.stringify({ output: 'ok', metadata: {} })}\n\n`,
    ].join('')
    const sseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sseText))
        controller.close()
      },
    })

    mockSafeFetchWithRetryForCalls.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: sseBody,
    } as any)

    await program.parseAsync([
      'node', 'test', 'run', 'test-org/test-agent',
      '--data', '{"task": "test"}',
      '--wait-timeout', '1800',
    ])

    // Verify the fetch was called with the custom timeout (1800s = 1800000ms)
    const fetchCall = mockSafeFetchWithRetryForCalls.mock.calls[0]
    expect(fetchCall[1]?.timeoutMs).toBe(1800000)
  })
})

describe('run command --estimate and --estimate-only', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()

    program = new Command()
    program.exitOverride()
    registerRunCommand(program)

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'test-org',
    })

    mockLoadConfig.mockResolvedValue({})
    mockGetDefaultProvider.mockResolvedValue(undefined)
    mockFs.mkdir.mockResolvedValue(undefined)
    mockFs.writeFile.mockResolvedValue(undefined)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('--estimate-only shows cost estimate and exits without running', async () => {
    mockGetAgentCostEstimate.mockResolvedValue({
      estimate: {
        sample_size: 25,
        avg_cost_usd: 0.015,
        p50_cost_usd: 0.012,
        p95_cost_usd: 0.045,
        provider_breakdown: [{ provider: 'anthropic', avg_cost_usd: 0.015 }],
        period_days: 30,
      },
    })

    // Mock agent metadata
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'prompt',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    })

    mockResolveWorkspaceIdForOrg.mockResolvedValue('workspace-123')

    await program.parseAsync(['node', 'test', 'run', 'test-org/test-agent@v1', '--estimate-only'])

    // Verify estimate was shown in stderr
    const stderrOutput = stderrSpy.mock.calls.map(c => c[0]).join('')
    expect(stderrOutput).toContain('Cost Estimate')
    expect(stderrOutput).toContain('25 runs')

    // Verify getAgentCostEstimate was called with workspaceId
    expect(mockGetAgentCostEstimate).toHaveBeenCalledWith(
      expect.any(Object), 'test-org', 'test-agent', 'v1', 'workspace-123'
    )
  })

  it('--estimate passes workspaceId to getAgentCostEstimate for private agent resolution', async () => {
    mockGetAgentCostEstimate.mockResolvedValue({
      estimate: {
        sample_size: 10,
        avg_cost_usd: 0.01,
        p50_cost_usd: 0.008,
        p95_cost_usd: 0.03,
        period_days: 30,
      },
    })

    mockGetAgentWithFallback.mockResolvedValue({
      type: 'prompt',
      name: 'private-agent',
      version: 'v2',
      supported_providers: ['any'],
    })

    mockResolveWorkspaceIdForOrg.mockResolvedValue('team-ws-456')

    await program.parseAsync(['node', 'test', 'run', 'myteam/private-agent@v2', '--estimate-only'])

    // The workspace ID must be passed so private agents in team workspaces can be found
    expect(mockGetAgentCostEstimate).toHaveBeenCalledWith(
      expect.any(Object), 'myteam', 'private-agent', 'v2', 'team-ws-456'
    )
  })

  it('--estimate-only throws network error when estimate fetch fails with generic error', async () => {
    mockGetAgentCostEstimate.mockRejectedValue(new Error('fetch failed'))

    mockGetAgentWithFallback.mockResolvedValue({
      type: 'prompt',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    })

    mockResolveWorkspaceIdForOrg.mockResolvedValue('workspace-123')

    await expect(
      program.parseAsync(['node', 'test', 'run', 'test-org/test-agent@v1', '--estimate-only'])
    ).rejects.toThrow('Network error')
  })

  it('--estimate-only throws specific message for 404 ApiError', async () => {
    const notFoundErr = new (ApiError as any)()
    notFoundErr.status = 404
    mockGetAgentCostEstimate.mockRejectedValue(notFoundErr)

    mockGetAgentWithFallback.mockResolvedValue({
      type: 'prompt',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    })

    mockResolveWorkspaceIdForOrg.mockResolvedValue('workspace-123')

    await expect(
      program.parseAsync(['node', 'test', 'run', 'test-org/test-agent@v1', '--estimate-only'])
    ).rejects.toThrow('Agent not found')
  })

  it('--estimate-only throws specific message for 429 ApiError', async () => {
    const rateLimitErr = new (ApiError as any)()
    rateLimitErr.status = 429
    mockGetAgentCostEstimate.mockRejectedValue(rateLimitErr)

    mockGetAgentWithFallback.mockResolvedValue({
      type: 'prompt',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    })

    mockResolveWorkspaceIdForOrg.mockResolvedValue('workspace-123')

    await expect(
      program.parseAsync(['node', 'test', 'run', 'test-org/test-agent@v1', '--estimate-only'])
    ).rejects.toThrow('Rate limited')
  })

  it('--estimate shows specific error detail and proceeds on API failure', async () => {
    const serverErr = new (ApiError as any)()
    serverErr.status = 500
    mockGetAgentCostEstimate.mockRejectedValue(serverErr)

    mockGetAgentWithFallback.mockResolvedValue({
      type: 'prompt',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    })

    mockResolveWorkspaceIdForOrg.mockResolvedValue('workspace-123')

    // --estimate (not --estimate-only) should proceed without throwing
    // The run itself will fail because we don't mock the full run flow,
    // but we can check the error message was written before it proceeds
    try {
      await program.parseAsync(['node', 'test', 'run', 'test-org/test-agent@v1', '--estimate', '--data', '{}'])
    } catch {
      // Run will fail after estimate — that's fine, we're testing the estimate message
    }

    const stderrOutput = stderrSpy.mock.calls.map(c => c[0]).join('')
    expect(stderrOutput).toContain('API error (500)')
    expect(stderrOutput).toContain('Proceeding with run')
  })

  it('--estimate shows network error detail and proceeds on generic failure', async () => {
    mockGetAgentCostEstimate.mockRejectedValue(new Error('ECONNREFUSED'))

    mockGetAgentWithFallback.mockResolvedValue({
      type: 'prompt',
      name: 'test-agent',
      version: 'v1',
      supported_providers: ['any'],
    })

    mockResolveWorkspaceIdForOrg.mockResolvedValue('workspace-123')

    try {
      await program.parseAsync(['node', 'test', 'run', 'test-org/test-agent@v1', '--estimate', '--data', '{}'])
    } catch {
      // Run will fail after estimate — that's fine
    }

    const stderrOutput = stderrSpy.mock.calls.map(c => c[0]).join('')
    expect(stderrOutput).toContain('Network error')
    expect(stderrOutput).toContain('Proceeding with run')
  })

  it('--estimate shows warning for agents with no run history', async () => {
    mockGetAgentCostEstimate.mockResolvedValue({
      estimate: {
        sample_size: 0,
      },
    })

    // Mock agent metadata
    mockGetAgentWithFallback.mockResolvedValue({
      type: 'prompt',
      name: 'new-agent',
      version: 'v1',
      supported_providers: ['any'],
    })

    mockResolveWorkspaceIdForOrg.mockResolvedValue('workspace-123')

    await program.parseAsync(['node', 'test', 'run', 'test-org/new-agent@v1', '--estimate-only'])

    const stderrOutput = stderrSpy.mock.calls.map(c => c[0]).join('')
    expect(stderrOutput).toContain('No run history available')
    expect(stderrOutput).toContain('This agent has not been run before')
  })
})

describe('canonicalAgentType', () => {
  it('returns "prompt" for prompt type', () => {
    expect(canonicalAgentType('prompt')).toBe('prompt')
    expect(canonicalAgentType('PROMPT')).toBe('prompt')
    expect(canonicalAgentType('Prompt')).toBe('prompt')
  })

  it('returns "tool" for tool type', () => {
    expect(canonicalAgentType('tool')).toBe('tool')
    expect(canonicalAgentType('TOOL')).toBe('tool')
    expect(canonicalAgentType('Tool')).toBe('tool')
  })

  it('returns "agent" for agent type', () => {
    expect(canonicalAgentType('agent')).toBe('agent')
    expect(canonicalAgentType('AGENT')).toBe('agent')
    expect(canonicalAgentType('Agent')).toBe('agent')
  })

  it('returns "skill" for skill type', () => {
    expect(canonicalAgentType('skill')).toBe('skill')
    expect(canonicalAgentType('SKILL')).toBe('skill')
    expect(canonicalAgentType('Skill')).toBe('skill')
  })

  it('maps legacy "agentic" to "agent"', () => {
    expect(canonicalAgentType('agentic')).toBe('agent')
    expect(canonicalAgentType('AGENTIC')).toBe('agent')
    expect(canonicalAgentType('Agentic')).toBe('agent')
  })

  it('maps legacy "code" to "tool"', () => {
    expect(canonicalAgentType('code')).toBe('tool')
    expect(canonicalAgentType('CODE')).toBe('tool')
    expect(canonicalAgentType('Code')).toBe('tool')
  })

  it('defaults to "agent" for undefined/null', () => {
    expect(canonicalAgentType(undefined)).toBe('agent')
    expect(canonicalAgentType('')).toBe('agent')
  })

  it('defaults to "agent" for unrecognized types', () => {
    expect(canonicalAgentType('unknown')).toBe('agent')
    expect(canonicalAgentType('invalid')).toBe('agent')
  })
})

describe('BUG-11-06: bundle download passes workspace context', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()

    program = new Command()
    program.exitOverride()
    registerRunCommand(program)

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'test-org',
    })

    mockLoadConfig.mockResolvedValue({})
    mockGetDefaultProvider.mockResolvedValue(undefined)

    mockFs.mkdir.mockResolvedValue(undefined)
    mockFs.writeFile.mockResolvedValue(undefined)
    mockFs.readFile.mockRejectedValue(new Error('ENOENT'))
    mockFs.access.mockRejectedValue(new Error('ENOENT'))
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('passes workspaceId to downloadCodeBundleAuthenticated for bundle download', async () => {
    // Simulate team workspace context
    mockResolveWorkspaceIdForOrg.mockResolvedValue('ws-team-456')

    // Agent metadata downloads successfully via public endpoint
    mockPublicRequest.mockResolvedValue({
      id: 'agent-bundle-1',
      type: 'tool',
      name: 'my-tool',
      version: 'v1',
      execution_engine: 'code_runtime',
      has_bundle: true,
      entrypoint: 'main.py',
      supported_providers: ['any'],
    })

    // Public bundle download fails with an ApiError (404).
    // Auto-mocked ApiError constructor doesn't run, so we set .status manually.
    const notFoundErr = new (ApiError as any)()
    notFoundErr.status = 404
    mockDownloadCodeBundle.mockRejectedValue(notFoundErr)
    // Authenticated bundle download succeeds
    mockDownloadCodeBundleAuthenticated.mockResolvedValue(Buffer.from('fake-zip-data'))

    // The command will fail later at bundle extraction (fake zip data)
    // but we only care that downloadCodeBundleAuthenticated was called with workspace ID
    try {
      await program.parseAsync(['node', 'test', 'run', 'team-org/my-tool@v1', '--local'])
    } catch {
      // Expected to fail at bundle extraction
    }

    expect(mockDownloadCodeBundleAuthenticated).toHaveBeenCalledWith(
      expect.any(Object),
      'agent-bundle-1',
      'ws-team-456'
    )
  })
})
