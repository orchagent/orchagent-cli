/**
 * Tests for LLM provider checks.
 *
 * Covers per-provider status gathering, format hints, summary logic,
 * and skipServer mode.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock dependencies before importing the module under test
vi.mock('../../config', () => ({
  getResolvedConfig: vi.fn(),
}))

vi.mock('../../api', () => ({
  fetchLlmKeys: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.status = status
    }
  },
}))

import { runLlmChecks } from './llm'
import { getResolvedConfig } from '../../config'
import { fetchLlmKeys } from '../../api'

// Helper: set up server keys mock
function mockServerKeys(providers: string[]) {
  vi.mocked(getResolvedConfig).mockResolvedValue({
    apiKey: 'sk_test',
    apiUrl: 'https://api.test.com',
  })
  vi.mocked(fetchLlmKeys).mockResolvedValue(
    providers.map((p) => ({ provider: p, api_key: 'test' }))
  )
}

// Helper: set up no server keys (no api key)
function mockNoServerAccess() {
  vi.mocked(getResolvedConfig).mockResolvedValue({
    apiUrl: 'https://api.test.com',
  })
}

describe('runLlmChecks', () => {
  const originalEnv = process.env

  beforeEach(() => {
    vi.resetAllMocks()
    // Clean env for each test
    process.env = { ...originalEnv }
    delete process.env.OPENAI_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.GEMINI_API_KEY
    delete process.env.GOOGLE_API_KEY
    delete process.env.OLLAMA_HOST
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('returns 4 provider results + 1 summary = 5 results', async () => {
    mockNoServerAccess()
    const results = await runLlmChecks()
    expect(results).toHaveLength(5)
    expect(results.filter((r) => r.name.startsWith('llm_provider_') && r.name !== 'llm_provider_summary')).toHaveLength(4)
    expect(results.find((r) => r.name === 'llm_provider_summary')).toBeDefined()
  })

  it('all results have category "llm"', async () => {
    mockNoServerAccess()
    const results = await runLlmChecks()
    for (const r of results) {
      expect(r.category).toBe('llm')
    }
  })

  describe('no keys configured', () => {
    it('shows all providers as info (not configured)', async () => {
      mockServerKeys([])
      const results = await runLlmChecks()
      const providers = results.filter((r) => r.name !== 'llm_provider_summary')
      for (const p of providers) {
        expect(p.status).toBe('info')
        expect(p.message).toContain('Not configured')
      }
    })

    it('summary is warning with fix suggestion', async () => {
      mockServerKeys([])
      const results = await runLlmChecks()
      const summary = results.find((r) => r.name === 'llm_provider_summary')!
      expect(summary.status).toBe('warning')
      expect(summary.message).toBe('No LLM providers configured')
      expect(summary.fix).toMatch(/^Run: orchagent keys add /)
    })
  })

  describe('server only', () => {
    it('shows provider as success with server location', async () => {
      mockServerKeys(['openai'])
      const results = await runLlmChecks()
      const openai = results.find((r) => r.name === 'llm_provider_openai')!
      expect(openai.status).toBe('success')
      expect(openai.message).toContain('Configured (server)')
    })

    it('unconfigured providers show as info', async () => {
      mockServerKeys(['openai'])
      const results = await runLlmChecks()
      const anthropic = results.find((r) => r.name === 'llm_provider_anthropic')!
      expect(anthropic.status).toBe('info')
      expect(anthropic.message).toContain('Not configured')
    })
  })

  describe('local only', () => {
    it('shows provider as success with local location', async () => {
      process.env.OPENAI_API_KEY = 'sk-test123'
      mockServerKeys([])
      const results = await runLlmChecks()
      const openai = results.find((r) => r.name === 'llm_provider_openai')!
      expect(openai.status).toBe('success')
      expect(openai.message).toContain('Configured (local)')
    })
  })

  describe('both server and local', () => {
    it('shows provider with server + local', async () => {
      process.env.OPENAI_API_KEY = 'sk-test123'
      mockServerKeys(['openai'])
      const results = await runLlmChecks()
      const openai = results.find((r) => r.name === 'llm_provider_openai')!
      expect(openai.status).toBe('success')
      expect(openai.message).toContain('Configured (server + local)')
    })
  })

  describe('mixed providers', () => {
    it('shows correct status for each provider', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test123'
      mockServerKeys(['openai'])
      const results = await runLlmChecks()

      const openai = results.find((r) => r.name === 'llm_provider_openai')!
      expect(openai.status).toBe('success')
      expect(openai.message).toContain('Configured (server)')

      const anthropic = results.find((r) => r.name === 'llm_provider_anthropic')!
      expect(anthropic.status).toBe('success')
      expect(anthropic.message).toContain('Configured (local)')

      const gemini = results.find((r) => r.name === 'llm_provider_gemini')!
      expect(gemini.status).toBe('info')

      const ollama = results.find((r) => r.name === 'llm_provider_ollama')!
      expect(ollama.status).toBe('info')
    })
  })

  describe('Google/Gemini overlap', () => {
    it('detects GEMINI_API_KEY', async () => {
      process.env.GEMINI_API_KEY = 'AIzaSy-test'
      mockServerKeys([])
      const results = await runLlmChecks()
      const gemini = results.find((r) => r.name === 'llm_provider_gemini')!
      expect(gemini.status).toBe('success')
      expect(gemini.details?.localEnvVar).toBe('GEMINI_API_KEY')
    })

    it('detects GOOGLE_API_KEY when GEMINI_API_KEY not set', async () => {
      process.env.GOOGLE_API_KEY = 'AIzaSy-test'
      mockServerKeys([])
      const results = await runLlmChecks()
      const gemini = results.find((r) => r.name === 'llm_provider_gemini')!
      expect(gemini.status).toBe('success')
      expect(gemini.details?.localEnvVar).toBe('GOOGLE_API_KEY')
    })

    it('prefers GEMINI_API_KEY when both set', async () => {
      process.env.GEMINI_API_KEY = 'AIzaSy-gemini'
      process.env.GOOGLE_API_KEY = 'AIzaSy-google'
      mockServerKeys([])
      const results = await runLlmChecks()
      const gemini = results.find((r) => r.name === 'llm_provider_gemini')!
      expect(gemini.details?.localEnvVar).toBe('GEMINI_API_KEY')
    })
  })

  describe('format hints', () => {
    it('no hint for valid OpenAI key prefix', async () => {
      process.env.OPENAI_API_KEY = 'sk-test123'
      mockServerKeys([])
      const results = await runLlmChecks()
      const openai = results.find((r) => r.name === 'llm_provider_openai')!
      expect(openai.details?.formatHint).toBeUndefined()
    })

    it('hint for OpenAI key with wrong prefix', async () => {
      process.env.OPENAI_API_KEY = 'bad-key-format'
      mockServerKeys([])
      const results = await runLlmChecks()
      const openai = results.find((r) => r.name === 'llm_provider_openai')!
      expect(openai.details?.formatHint).toContain('sk-...')
      // Status should still be success (hint is informational)
      expect(openai.status).toBe('success')
    })

    it('hint for Anthropic key with wrong prefix', async () => {
      process.env.ANTHROPIC_API_KEY = 'wrong-prefix'
      mockServerKeys([])
      const results = await runLlmChecks()
      const anthropic = results.find((r) => r.name === 'llm_provider_anthropic')!
      expect(anthropic.details?.formatHint).toContain('sk-ant-...')
    })

    it('no hint for valid Anthropic key prefix', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test123'
      mockServerKeys([])
      const results = await runLlmChecks()
      const anthropic = results.find((r) => r.name === 'llm_provider_anthropic')!
      expect(anthropic.details?.formatHint).toBeUndefined()
    })

    it('no hint for Gemini (no reliable format)', async () => {
      process.env.GEMINI_API_KEY = 'any-value'
      mockServerKeys([])
      const results = await runLlmChecks()
      const gemini = results.find((r) => r.name === 'llm_provider_gemini')!
      expect(gemini.details?.formatHint).toBeUndefined()
    })

    it('no hint for Ollama (endpoint, not key)', async () => {
      process.env.OLLAMA_HOST = 'http://localhost:11434'
      mockServerKeys([])
      const results = await runLlmChecks()
      const ollama = results.find((r) => r.name === 'llm_provider_ollama')!
      expect(ollama.details?.formatHint).toBeUndefined()
    })
  })

  describe('summary logic', () => {
    it('0 configured = warning', async () => {
      mockServerKeys([])
      const results = await runLlmChecks()
      const summary = results.find((r) => r.name === 'llm_provider_summary')!
      expect(summary.status).toBe('warning')
    })

    it('1 configured = success with tip and fix', async () => {
      mockServerKeys(['openai'])
      const results = await runLlmChecks()
      const summary = results.find((r) => r.name === 'llm_provider_summary')!
      expect(summary.status).toBe('success')
      expect(summary.message).toContain('Multiple providers')
      expect(summary.fix).toBeDefined()
    })

    it('2+ configured = success with count and fix (if not all)', async () => {
      mockServerKeys(['openai', 'anthropic'])
      const results = await runLlmChecks()
      const summary = results.find((r) => r.name === 'llm_provider_summary')!
      expect(summary.status).toBe('success')
      expect(summary.message).toContain('2 providers configured')
      expect(summary.fix).toBeDefined() // still has unconfigured providers
    })

    it('all 4 configured = success with no fix', async () => {
      process.env.OLLAMA_HOST = 'http://localhost:11434'
      mockServerKeys(['openai', 'anthropic', 'gemini'])
      const results = await runLlmChecks()
      const summary = results.find((r) => r.name === 'llm_provider_summary')!
      expect(summary.status).toBe('success')
      expect(summary.fix).toBeUndefined()
    })

    it('fix targets first unconfigured provider', async () => {
      mockServerKeys(['openai'])
      const results = await runLlmChecks()
      const summary = results.find((r) => r.name === 'llm_provider_summary')!
      // anthropic is first unconfigured in PROVIDERS order
      expect(summary.fix).toBe('Run: orchagent keys add anthropic')
    })
  })

  describe('skipServer mode', () => {
    it('all providers have server=null', async () => {
      const results = await runLlmChecks({ skipServer: true })
      const providers = results.filter((r) => r.name !== 'llm_provider_summary')
      for (const p of providers) {
        expect(p.details?.server).toBeNull()
      }
    })

    it('does not call getResolvedConfig or fetchLlmKeys', async () => {
      await runLlmChecks({ skipServer: true })
      expect(getResolvedConfig).not.toHaveBeenCalled()
      expect(fetchLlmKeys).not.toHaveBeenCalled()
    })

    it('local checks still work', async () => {
      process.env.OPENAI_API_KEY = 'sk-test123'
      const results = await runLlmChecks({ skipServer: true })
      const openai = results.find((r) => r.name === 'llm_provider_openai')!
      expect(openai.details?.local).toBe(true)
      expect(openai.message).toContain('local configured')
    })

    it('server-unknown with no local shows correct message', async () => {
      const results = await runLlmChecks({ skipServer: true })
      const openai = results.find((r) => r.name === 'llm_provider_openai')!
      expect(openai.message).toContain('Server unknown, not local')
    })
  })
})
