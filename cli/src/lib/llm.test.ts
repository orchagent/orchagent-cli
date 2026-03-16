import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  detectProviderFromModel,
  warnProviderModelMismatch,
  MODEL_PROVIDER_PATTERNS,
  validateProvider,
  validateModelIds,
} from './llm'

describe('detectProviderFromModel', () => {
  describe('OpenAI models', () => {
    it('detects gpt- prefix', () => {
      expect(detectProviderFromModel('gpt-4o')).toBe('openai')
      expect(detectProviderFromModel('gpt-5.2')).toBe('openai')
      expect(detectProviderFromModel('gpt-3.5-turbo')).toBe('openai')
    })

    it('detects o1- prefix', () => {
      expect(detectProviderFromModel('o1-preview')).toBe('openai')
      expect(detectProviderFromModel('o1-mini')).toBe('openai')
    })

    it('detects o3- prefix', () => {
      expect(detectProviderFromModel('o3-mini')).toBe('openai')
    })

    it('detects o4- prefix', () => {
      expect(detectProviderFromModel('o4-mini')).toBe('openai')
    })

    it('detects davinci prefix', () => {
      expect(detectProviderFromModel('davinci-002')).toBe('openai')
    })

    it('detects text- prefix', () => {
      expect(detectProviderFromModel('text-davinci-003')).toBe('openai')
      expect(detectProviderFromModel('text-embedding-ada-002')).toBe('openai')
    })
  })

  describe('Anthropic models', () => {
    it('detects claude- prefix', () => {
      expect(detectProviderFromModel('claude-opus-4-5-20251101')).toBe('anthropic')
      expect(detectProviderFromModel('claude-sonnet-4-5-20251022')).toBe('anthropic')
      expect(detectProviderFromModel('claude-haiku-4-5-20251001')).toBe('anthropic')
      expect(detectProviderFromModel('claude-3-opus-20240229')).toBe('anthropic')
    })
  })

  describe('Gemini models', () => {
    it('detects gemini- prefix', () => {
      expect(detectProviderFromModel('gemini-2.5-pro')).toBe('gemini')
      expect(detectProviderFromModel('gemini-pro')).toBe('gemini')
      expect(detectProviderFromModel('gemini-1.5-flash')).toBe('gemini')
    })
  })

  describe('Ollama models', () => {
    it('detects llama prefix', () => {
      expect(detectProviderFromModel('llama3.2')).toBe('ollama')
      expect(detectProviderFromModel('llama2')).toBe('ollama')
    })

    it('detects mistral prefix', () => {
      expect(detectProviderFromModel('mistral')).toBe('ollama')
      expect(detectProviderFromModel('mistral-nemo')).toBe('ollama')
    })

    it('detects deepseek prefix', () => {
      expect(detectProviderFromModel('deepseek-coder')).toBe('ollama')
      expect(detectProviderFromModel('deepseek-r1')).toBe('ollama')
    })

    it('detects phi prefix', () => {
      expect(detectProviderFromModel('phi3')).toBe('ollama')
    })

    it('detects qwen prefix', () => {
      expect(detectProviderFromModel('qwen2')).toBe('ollama')
    })
  })

  describe('case insensitivity', () => {
    it('handles uppercase model names', () => {
      expect(detectProviderFromModel('GPT-4o')).toBe('openai')
      expect(detectProviderFromModel('Claude-3-opus')).toBe('anthropic')
      expect(detectProviderFromModel('Gemini-pro')).toBe('gemini')
      expect(detectProviderFromModel('Llama3.2')).toBe('ollama')
    })

    it('handles mixed case', () => {
      expect(detectProviderFromModel('GPT-5.2')).toBe('openai')
      expect(detectProviderFromModel('CLAUDE-haiku-4-5')).toBe('anthropic')
    })
  })

  describe('unknown models', () => {
    it('returns null for unrecognized models', () => {
      expect(detectProviderFromModel('my-custom-model')).toBeNull()
      expect(detectProviderFromModel('unknown-v2')).toBeNull()
      expect(detectProviderFromModel('')).toBeNull()
    })

    it('returns null for models that partially match but not at start', () => {
      expect(detectProviderFromModel('not-gpt-4')).toBeNull()
      expect(detectProviderFromModel('my-claude-model')).toBeNull()
      expect(detectProviderFromModel('super-gemini')).toBeNull()
    })
  })
})

describe('warnProviderModelMismatch', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
  })

  it('warns when model does not match provider', () => {
    warnProviderModelMismatch('gpt-4o', 'anthropic')
    expect(stderrSpy).toHaveBeenCalledWith(
      "Warning: Model 'gpt-4o' may not be a anthropic model.\n\n"
    )
  })

  it('warns when claude model used with openai provider', () => {
    warnProviderModelMismatch('claude-3-opus', 'openai')
    expect(stderrSpy).toHaveBeenCalledWith(
      "Warning: Model 'claude-3-opus' may not be a openai model.\n\n"
    )
  })

  it('does not warn when model matches provider', () => {
    warnProviderModelMismatch('gpt-4o', 'openai')
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('does not warn when model matches anthropic', () => {
    warnProviderModelMismatch('claude-opus-4-5', 'anthropic')
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('does not warn when model matches gemini', () => {
    warnProviderModelMismatch('gemini-2.5-pro', 'gemini')
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('does not warn for unknown provider without patterns', () => {
    warnProviderModelMismatch('my-model', 'unknown-provider')
    expect(stderrSpy).not.toHaveBeenCalled()
  })
})

describe('MODEL_PROVIDER_PATTERNS', () => {
  it('exports pattern map with all supported providers', () => {
    expect(MODEL_PROVIDER_PATTERNS).toHaveProperty('openai')
    expect(MODEL_PROVIDER_PATTERNS).toHaveProperty('anthropic')
    expect(MODEL_PROVIDER_PATTERNS).toHaveProperty('gemini')
    expect(MODEL_PROVIDER_PATTERNS).toHaveProperty('ollama')
  })

  it('patterns are RegExp instances', () => {
    for (const pattern of Object.values(MODEL_PROVIDER_PATTERNS)) {
      expect(pattern).toBeInstanceOf(RegExp)
    }
  })
})

describe('validateModelIds', () => {
  it('returns no warnings for valid model IDs', () => {
    const warnings = validateModelIds({
      anthropic: 'claude-sonnet-4-6',
      openai: 'gpt-5.2',
      gemini: 'gemini-2.5-pro',
    })
    expect(warnings).toHaveLength(0)
  })

  it('warns on unrecognized model ID', () => {
    const warnings = validateModelIds({
      anthropic: 'my-custom-model',
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toContain('Unrecognized model ID')
    expect(warnings[0].message).toContain('my-custom-model')
    expect(warnings[0].message).toContain('404')
  })

  it('warns on provider mismatch (openai model under anthropic)', () => {
    const warnings = validateModelIds({
      anthropic: 'gpt-4o',
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toContain('looks like a openai model')
    expect(warnings[0].message).toContain('set under "anthropic"')
  })

  it('warns on unknown provider key', () => {
    const warnings = validateModelIds({
      mistralai: 'mistral-large',
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toContain('Unknown provider "mistralai"')
  })

  it('returns multiple warnings for multiple issues', () => {
    const warnings = validateModelIds({
      anthropic: 'gpt-4o',
      openai: 'some-unknown-model',
      badprovider: 'claude-sonnet-4-6',
    })
    expect(warnings).toHaveLength(3)
  })

  it('accepts ollama models under ollama provider', () => {
    const warnings = validateModelIds({
      ollama: 'llama3.2',
    })
    expect(warnings).toHaveLength(0)
  })

  it('returns no warnings for empty object', () => {
    const warnings = validateModelIds({})
    expect(warnings).toHaveLength(0)
  })
})
