/**
 * Tests for the run command and LLM utilities.
 *
 * These tests cover downloading and running agents locally:
 * - parseAgentRef() parsing org/agent@version formats
 * - downloadAgent() fetching from API
 * - LLM key detection from environment
 * - Building prompts with variable substitution
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

// Mock modules before importing
vi.mock('fs/promises')
vi.mock('../lib/config')
vi.mock('../lib/api')

import fs from 'fs/promises'
import { registerRunCommand } from './run'
import { getResolvedConfig, loadConfig } from '../lib/config'
import { publicRequest, getPublicAgent } from '../lib/api'
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
const mockPublicRequest = vi.mocked(publicRequest)
const mockGetPublicAgent = vi.mocked(getPublicAgent)

describe('run command - agent ref parsing', () => {
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

    // Mock loadConfig to return empty config (no workspace set)
    mockLoadConfig.mockResolvedValue({})

    // Mock mkdir for agent saving
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

    await program.parseAsync(['node', 'test', 'run', 'myorg/my-agent@v2'])

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

    await program.parseAsync(['node', 'test', 'run', 'myorg/my-agent'])

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

    await program.parseAsync(['node', 'test', 'run', 'my-agent'])

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

    await program.parseAsync(['node', 'test', 'run', 'my-agent@v3'])

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
      program.parseAsync(['node', 'test', 'run', 'just-agent'])
    ).rejects.toThrow('Missing org')
  })

  it('throws error for too many segments', async () => {
    await expect(
      program.parseAsync(['node', 'test', 'run', 'a/b/c/d'])
    ).rejects.toThrow('Invalid agent reference')
  })
})

describe('run command - download agent', () => {
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

    // Mock loadConfig to return empty config (no workspace set)
    mockLoadConfig.mockResolvedValue({})

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

    await program.parseAsync(['node', 'test', 'run', 'test-org/test-agent@v1'])

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

    await program.parseAsync(['node', 'test', 'run', 'test-org/fallback-agent@v1'])

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

    await program.parseAsync(['node', 'test', 'run', 'test-org/saved-agent@v1'])

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

    await program.parseAsync(['node', 'test', 'run', 'test-org/prompt-agent@v1'])

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
      '--download-only',
    ])

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Agent downloaded'))
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
