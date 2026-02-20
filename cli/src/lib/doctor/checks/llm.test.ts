/**
 * Tests for LLM provider checks (local env vars only).
 *
 * Server-side LLM key management was removed in G-4 (unified secrets).
 * LLM keys are now managed through the workspace secrets vault.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { runLlmChecks } from './llm'

describe('runLlmChecks', () => {
  const originalEnv = process.env

  beforeEach(() => {
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
    const results = await runLlmChecks()
    expect(results).toHaveLength(5)
    expect(results.filter((r) => r.name.startsWith('llm_provider_') && r.name !== 'llm_provider_summary')).toHaveLength(4)
    expect(results.find((r) => r.name === 'llm_provider_summary')).toBeDefined()
  })

  it('all results have category "llm"', async () => {
    const results = await runLlmChecks()
    for (const r of results) {
      expect(r.category).toBe('llm')
    }
  })

  describe('no keys configured', () => {
    it('shows all providers as info (not configured)', async () => {
      const results = await runLlmChecks()
      const providers = results.filter((r) => r.name !== 'llm_provider_summary')
      for (const p of providers) {
        expect(p.status).toBe('info')
        expect(p.message).toContain('Not configured locally')
      }
    })

    it('summary is warning with fix suggestion', async () => {
      const results = await runLlmChecks()
      const summary = results.find((r) => r.name === 'llm_provider_summary')!
      expect(summary.status).toBe('warning')
      expect(summary.message).toBe('No LLM providers configured locally')
      expect(summary.fix).toContain('orch secrets set')
    })

    it('summary details show 0 configured out of total', async () => {
      const results = await runLlmChecks()
      const summary = results.find((r) => r.name === 'llm_provider_summary')!
      expect(summary.details?.configuredCount).toBe(0)
      expect(summary.details?.totalProviders).toBe(4)
    })
  })

  describe('local env var detection', () => {
    it('detects OPENAI_API_KEY', async () => {
      process.env.OPENAI_API_KEY = 'sk-test123'
      const results = await runLlmChecks()
      const openai = results.find((r) => r.name === 'llm_provider_openai')!
      expect(openai.status).toBe('success')
      expect(openai.message).toContain('Configured (local)')
      expect(openai.details?.local).toBe(true)
      expect(openai.details?.localEnvVar).toBe('OPENAI_API_KEY')
    })

    it('detects ANTHROPIC_API_KEY', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test123'
      const results = await runLlmChecks()
      const anthropic = results.find((r) => r.name === 'llm_provider_anthropic')!
      expect(anthropic.status).toBe('success')
      expect(anthropic.details?.local).toBe(true)
    })

    it('detects OLLAMA_HOST', async () => {
      process.env.OLLAMA_HOST = 'http://localhost:11434'
      const results = await runLlmChecks()
      const ollama = results.find((r) => r.name === 'llm_provider_ollama')!
      expect(ollama.status).toBe('success')
      expect(ollama.details?.local).toBe(true)
    })

    it('unconfigured providers show as info', async () => {
      process.env.OPENAI_API_KEY = 'sk-test123'
      const results = await runLlmChecks()
      const anthropic = results.find((r) => r.name === 'llm_provider_anthropic')!
      expect(anthropic.status).toBe('info')
      expect(anthropic.details?.local).toBe(false)
    })

    it('server is always null (local-only check)', async () => {
      process.env.OPENAI_API_KEY = 'sk-test123'
      const results = await runLlmChecks()
      for (const r of results.filter((r) => r.name !== 'llm_provider_summary')) {
        expect(r.details?.server).toBeNull()
      }
    })
  })

  describe('Google/Gemini overlap', () => {
    it('detects GEMINI_API_KEY', async () => {
      process.env.GEMINI_API_KEY = 'AIzaSy-test'
      const results = await runLlmChecks()
      const gemini = results.find((r) => r.name === 'llm_provider_gemini')!
      expect(gemini.status).toBe('success')
      expect(gemini.details?.localEnvVar).toBe('GEMINI_API_KEY')
    })

    it('detects GOOGLE_API_KEY when GEMINI_API_KEY not set', async () => {
      process.env.GOOGLE_API_KEY = 'AIzaSy-test'
      const results = await runLlmChecks()
      const gemini = results.find((r) => r.name === 'llm_provider_gemini')!
      expect(gemini.status).toBe('success')
      expect(gemini.details?.localEnvVar).toBe('GOOGLE_API_KEY')
    })

    it('prefers GEMINI_API_KEY when both set', async () => {
      process.env.GEMINI_API_KEY = 'AIzaSy-gemini'
      process.env.GOOGLE_API_KEY = 'AIzaSy-google'
      const results = await runLlmChecks()
      const gemini = results.find((r) => r.name === 'llm_provider_gemini')!
      expect(gemini.details?.localEnvVar).toBe('GEMINI_API_KEY')
    })
  })

  describe('format hints', () => {
    it('no hint for valid OpenAI key prefix', async () => {
      process.env.OPENAI_API_KEY = 'sk-test123'
      const results = await runLlmChecks()
      const openai = results.find((r) => r.name === 'llm_provider_openai')!
      expect(openai.details?.formatHint).toBeUndefined()
    })

    it('hint for OpenAI key with wrong prefix', async () => {
      process.env.OPENAI_API_KEY = 'bad-key-format'
      const results = await runLlmChecks()
      const openai = results.find((r) => r.name === 'llm_provider_openai')!
      expect(openai.details?.formatHint).toContain('sk-...')
      // Status should still be success (hint is informational)
      expect(openai.status).toBe('success')
    })

    it('hint for Anthropic key with wrong prefix', async () => {
      process.env.ANTHROPIC_API_KEY = 'wrong-prefix'
      const results = await runLlmChecks()
      const anthropic = results.find((r) => r.name === 'llm_provider_anthropic')!
      expect(anthropic.details?.formatHint).toContain('sk-ant-...')
    })

    it('no hint for valid Anthropic key prefix', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test123'
      const results = await runLlmChecks()
      const anthropic = results.find((r) => r.name === 'llm_provider_anthropic')!
      expect(anthropic.details?.formatHint).toBeUndefined()
    })

    it('no hint for Gemini (no reliable format)', async () => {
      process.env.GEMINI_API_KEY = 'any-value'
      const results = await runLlmChecks()
      const gemini = results.find((r) => r.name === 'llm_provider_gemini')!
      expect(gemini.details?.formatHint).toBeUndefined()
    })

    it('no hint for Ollama (endpoint, not key)', async () => {
      process.env.OLLAMA_HOST = 'http://localhost:11434'
      const results = await runLlmChecks()
      const ollama = results.find((r) => r.name === 'llm_provider_ollama')!
      expect(ollama.details?.formatHint).toBeUndefined()
    })
  })

  describe('summary logic', () => {
    it('0 configured = warning', async () => {
      const results = await runLlmChecks()
      const summary = results.find((r) => r.name === 'llm_provider_summary')!
      expect(summary.status).toBe('warning')
      expect(summary.message).toContain('No LLM providers configured')
    })

    it('1 configured = success', async () => {
      process.env.OPENAI_API_KEY = 'sk-test123'
      const results = await runLlmChecks()
      const summary = results.find((r) => r.name === 'llm_provider_summary')!
      expect(summary.status).toBe('success')
      expect(summary.message).toContain('1 local provider configured')
    })

    it('2+ configured = success with count', async () => {
      process.env.OPENAI_API_KEY = 'sk-test123'
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test123'
      const results = await runLlmChecks()
      const summary = results.find((r) => r.name === 'llm_provider_summary')!
      expect(summary.status).toBe('success')
      expect(summary.message).toContain('2 local providers configured')
    })

    it('all 4 configured = success', async () => {
      process.env.OPENAI_API_KEY = 'sk-test123'
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test123'
      process.env.GEMINI_API_KEY = 'AIzaSy-test'
      process.env.OLLAMA_HOST = 'http://localhost:11434'
      const results = await runLlmChecks()
      const summary = results.find((r) => r.name === 'llm_provider_summary')!
      expect(summary.status).toBe('success')
      expect(summary.details?.configuredCount).toBe(4)
    })
  })

  describe('skipServer option (no-op, kept for API compat)', () => {
    it('works the same with or without skipServer', async () => {
      process.env.OPENAI_API_KEY = 'sk-test123'
      const withSkip = await runLlmChecks({ skipServer: true })
      const without = await runLlmChecks()
      // Same number of results, same statuses
      expect(withSkip).toHaveLength(without.length)
      for (let i = 0; i < withSkip.length; i++) {
        expect(withSkip[i].status).toBe(without[i].status)
        expect(withSkip[i].name).toBe(without[i].name)
      }
    })
  })
})
