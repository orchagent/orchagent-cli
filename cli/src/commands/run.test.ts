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
vi.mock('../lib/pricing', () => ({
  isPaidAgent: vi.fn().mockReturnValue(false),
  formatPrice: vi.fn().mockReturnValue('FREE'),
}))

import fs from 'fs/promises'
import { registerRunCommand, isKeyedFileArg, mountDirectory, buildInjectedPayload } from './run'
import { getResolvedConfig, loadConfig, getDefaultProvider } from '../lib/config'
import { publicRequest, getPublicAgent, getAgentWithFallback, safeFetchWithRetryForCalls } from '../lib/api'
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
    ).rejects.toThrow('Cannot upload a directory for cloud execution')
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
          message: 'Code execution failed with exit code 1: ModuleNotFoundError: No module named \'pandas\'',
          is_retryable: false,
        },
        metadata: { request_id: 'req_test123' },
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
