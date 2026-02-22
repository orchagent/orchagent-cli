/**
 * Tests for dev-server library module.
 *
 * Covers: agent config loading, engine inference, HTTP server endpoints,
 * request handling, CORS, error responses, and execution dispatch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import http from 'http'

vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn(),
    access: vi.fn(),
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    rm: vi.fn(),
  },
}))

vi.mock('./bundle', () => ({
  detectEntrypoint: vi.fn(),
}))

vi.mock('./config', () => ({
  getResolvedConfig: vi.fn().mockResolvedValue({
    apiKey: 'sk_test_123',
    apiUrl: 'https://api.test.com',
    defaultOrg: 'test-org',
  }),
}))

vi.mock('./llm', () => ({
  detectLlmKey: vi.fn(),
  getDefaultModel: vi.fn().mockReturnValue('gpt-4'),
  buildPrompt: vi.fn().mockReturnValue('built prompt'),
  callLlm: vi.fn(),
  PROVIDER_ENV_VARS: { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY' },
}))

import fs from 'fs/promises'
import {
  inferEngine,
  engineLabel,
  loadAgentConfig,
  createDevServer,
  type AgentConfig,
  type RequestLog,
} from './dev-server'
import { detectEntrypoint } from './bundle'
import { callLlm, detectLlmKey } from './llm'

const mockFs = vi.mocked(fs)
const mockDetectEntrypoint = vi.mocked(detectEntrypoint)

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeManifest(overrides: Record<string, unknown> = {}) {
  return {
    name: 'test-agent',
    version: 'v1',
    type: 'prompt',
    ...overrides,
  }
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    manifest: makeManifest() as any,
    engine: 'direct_llm',
    agentDir: '/tmp/test-agent',
    prompt: 'Test prompt with {{task}}',
    ...overrides,
  }
}

function httpRequest(
  port: number,
  method: string,
  path: string,
  body?: string
): Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: 'localhost', port, path, method, headers: body ? { 'Content-Type': 'application/json' } : {} },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 0,
            body: Buffer.concat(chunks).toString('utf-8'),
            headers: res.headers,
          })
        })
      }
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

// ─── Engine inference ───────────────────────────────────────────────────────

describe('inferEngine', () => {
  it('returns code_runtime for runtime.command', () => {
    expect(inferEngine(makeManifest({ runtime: { command: 'python3 main.py' } }) as any)).toBe('code_runtime')
  })

  it('returns managed_loop for loop config', () => {
    expect(inferEngine(makeManifest({ loop: { max_turns: 10 } }) as any)).toBe('managed_loop')
  })

  it('returns code_runtime for tool type', () => {
    expect(inferEngine(makeManifest({ type: 'tool' }) as any)).toBe('code_runtime')
  })

  it('returns managed_loop for agent type', () => {
    expect(inferEngine(makeManifest({ type: 'agent' }) as any)).toBe('managed_loop')
  })

  it('returns direct_llm for prompt type', () => {
    expect(inferEngine(makeManifest({ type: 'prompt' }) as any)).toBe('direct_llm')
  })

  it('handles legacy agentic type', () => {
    expect(inferEngine(makeManifest({ type: 'agentic' }) as any)).toBe('managed_loop')
  })

  it('handles legacy code type', () => {
    expect(inferEngine(makeManifest({ type: 'code' }) as any)).toBe('code_runtime')
  })

  it('runtime.command takes precedence over type', () => {
    expect(inferEngine(makeManifest({
      type: 'prompt',
      runtime: { command: 'python3 main.py' },
    }) as any)).toBe('code_runtime')
  })

  it('loop takes precedence over type for prompt', () => {
    expect(inferEngine(makeManifest({
      type: 'prompt',
      loop: { max_turns: 5 },
    }) as any)).toBe('managed_loop')
  })

  it('defaults to managed_loop when type defaults to agent', () => {
    // Default type is 'agent' when missing, which maps to managed_loop
    expect(inferEngine({ name: 'test', version: 'v1' } as any)).toBe('managed_loop')
  })
})

describe('engineLabel', () => {
  it('returns readable labels', () => {
    expect(engineLabel('direct_llm')).toBe('prompt')
    expect(engineLabel('managed_loop')).toBe('agent loop')
    expect(engineLabel('code_runtime')).toBe('code runtime')
  })
})

// ─── Agent config loading ───────────────────────────────────────────────────

describe('loadAgentConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads a prompt agent config', async () => {
    mockFs.readFile
      .mockResolvedValueOnce(JSON.stringify(makeManifest({ type: 'prompt' })))  // orchagent.json
      .mockResolvedValueOnce('You are a helpful agent.')                        // prompt.md
      .mockResolvedValueOnce(JSON.stringify({                                   // schema.json
        input: { type: 'object', properties: { task: { type: 'string' } } },
        output: { type: 'object' },
      }))

    const config = await loadAgentConfig('/tmp/agent')
    expect(config.engine).toBe('direct_llm')
    expect(config.prompt).toBe('You are a helpful agent.')
    expect(config.inputSchema).toBeTruthy()
    expect(config.outputSchema).toBeTruthy()
    expect(config.agentDir).toBe('/tmp/agent')
  })

  it('loads a code_runtime agent with detected entrypoint', async () => {
    mockFs.readFile
      .mockResolvedValueOnce(JSON.stringify(makeManifest({ type: 'tool' })))
      .mockRejectedValueOnce(new Error('no schema'))

    mockDetectEntrypoint.mockResolvedValue('main.py')

    const config = await loadAgentConfig('/tmp/tool')
    expect(config.engine).toBe('code_runtime')
    expect(config.entrypoint).toBe('main.py')
    expect(config.prompt).toBeUndefined()
  })

  it('loads managed_loop agent with custom tools', async () => {
    const manifest = makeManifest({
      type: 'agent',
      loop: { max_turns: 10 },
      custom_tools: [{ name: 'search', description: 'Search', command: 'echo test' }],
    })
    mockFs.readFile
      .mockResolvedValueOnce(JSON.stringify(manifest))
      .mockResolvedValueOnce('Agent prompt here.')
      .mockRejectedValueOnce(new Error('no schema'))

    const config = await loadAgentConfig('/tmp/loop-agent')
    expect(config.engine).toBe('managed_loop')
    expect(config.customTools).toHaveLength(1)
    expect(config.prompt).toBe('Agent prompt here.')
  })

  it('throws on missing orchagent.json', async () => {
    mockFs.readFile.mockRejectedValue(new Error('ENOENT'))
    await expect(loadAgentConfig('/tmp/no-agent')).rejects.toThrow()
  })

  it('throws on invalid JSON in orchagent.json', async () => {
    mockFs.readFile.mockResolvedValueOnce('{ invalid json')
    await expect(loadAgentConfig('/tmp/bad-json')).rejects.toThrow()
  })

  it('handles missing prompt.md gracefully', async () => {
    mockFs.readFile
      .mockResolvedValueOnce(JSON.stringify(makeManifest({ type: 'prompt' })))
      .mockRejectedValueOnce(new Error('ENOENT'))  // prompt.md
      .mockRejectedValueOnce(new Error('ENOENT'))  // schema.json

    const config = await loadAgentConfig('/tmp/no-prompt')
    expect(config.prompt).toBeUndefined()
  })

  it('uses manifest.entrypoint when set', async () => {
    mockFs.readFile
      .mockResolvedValueOnce(JSON.stringify(makeManifest({
        type: 'tool',
        entrypoint: 'custom_entry.py',
      })))
      .mockRejectedValueOnce(new Error('no schema'))

    mockDetectEntrypoint.mockResolvedValue(null)

    const config = await loadAgentConfig('/tmp/custom-entry')
    expect(config.entrypoint).toBe('custom_entry.py')
  })
})

// ─── HTTP server ────────────────────────────────────────────────────────────

describe('createDevServer', () => {
  let port: number
  let closeServer: (() => Promise<void>) | null = null
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    port = 14900 + Math.floor(Math.random() * 1000)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(async () => {
    if (closeServer) {
      await closeServer()
      closeServer = null
    }
    stderrSpy.mockRestore()
  })

  function startServer(
    config: AgentConfig | null = makeConfig(),
    callbacks: { onRequest?: (log: RequestLog) => void } = {}
  ): Promise<void> {
    const handle = createDevServer(port, false, () => config, callbacks)
    closeServer = handle.close
    return new Promise<void>((resolve) => {
      handle.server.listen(port, resolve)
    })
  }

  // ── GET / ──

  it('returns usage page on GET /', async () => {
    await startServer()
    const res = await httpRequest(port, 'GET', '/')
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('orchagent dev server')
    expect(res.body).toContain('POST')
  })

  // ── GET /health ──

  it('returns agent info on GET /health', async () => {
    await startServer()
    const res = await httpRequest(port, 'GET', '/health')
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.status).toBe('ok')
    expect(body.agent).toBe('test-agent')
    expect(body.engine).toBe('direct_llm')
    expect(body.has_prompt).toBe(true)
  })

  it('returns 503 on GET /health when config is null', async () => {
    await startServer(null)
    const res = await httpRequest(port, 'GET', '/health')
    expect(res.statusCode).toBe(503)
    const body = JSON.parse(res.body)
    expect(body.error).toContain('invalid')
  })

  it('returns agent info on GET /info', async () => {
    await startServer()
    const res = await httpRequest(port, 'GET', '/info')
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.agent).toBe('test-agent')
  })

  // ── POST /run ──

  it('returns 503 when agent config is null', async () => {
    const logs: RequestLog[] = []
    await startServer(null, { onRequest: (l) => logs.push(l) })

    const res = await httpRequest(port, 'POST', '/run', '{"task": "test"}')
    expect(res.statusCode).toBe(503)
    expect(logs).toHaveLength(1)
    expect(logs[0].statusCode).toBe(503)
  })

  it('returns 400 for invalid JSON body', async () => {
    const logs: RequestLog[] = []
    await startServer(makeConfig(), { onRequest: (l) => logs.push(l) })

    const res = await httpRequest(port, 'POST', '/run', 'not json {{{')
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body)
    expect(body.error).toContain('Invalid JSON')
    expect(logs[0].statusCode).toBe(400)
  })

  it('accepts empty body as empty object', async () => {
    // Mock callLlm for direct_llm execution
    vi.mocked(detectLlmKey).mockResolvedValue({ provider: 'openai', key: 'sk-test', model: 'gpt-4' })
    vi.mocked(callLlm).mockResolvedValue({ result: 'ok' })

    await startServer()
    const res = await httpRequest(port, 'POST', '/run', '')
    expect(res.statusCode).toBe(200)
  })

  it('POST / works as alias for POST /run', async () => {
    vi.mocked(detectLlmKey).mockResolvedValue({ provider: 'openai', key: 'sk-test', model: 'gpt-4' })
    vi.mocked(callLlm).mockResolvedValue({ result: 'hello' })

    await startServer()
    const res = await httpRequest(port, 'POST', '/', '{"task": "greet"}')
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.result).toBe('hello')
  })

  // ── CORS ──

  it('handles OPTIONS preflight', async () => {
    await startServer()
    const res = await httpRequest(port, 'OPTIONS', '/run')
    expect(res.statusCode).toBe(204)
  })

  it('includes CORS headers on responses', async () => {
    await startServer()
    const res = await httpRequest(port, 'GET', '/health')
    expect(res.headers['access-control-allow-origin']).toBe('*')
  })

  // ── 404 ──

  it('returns 404 for unknown routes', async () => {
    await startServer()
    const res = await httpRequest(port, 'GET', '/unknown')
    expect(res.statusCode).toBe(404)
  })

  it('returns 404 for PUT', async () => {
    await startServer()
    const res = await httpRequest(port, 'PUT', '/run')
    expect(res.statusCode).toBe(404)
  })

  // ── Request logging ──

  it('calls onRequest callback with correct log data', async () => {
    vi.mocked(detectLlmKey).mockResolvedValue({ provider: 'openai', key: 'sk-test', model: 'gpt-4' })
    vi.mocked(callLlm).mockResolvedValue({ answer: 42 })

    const logs: RequestLog[] = []
    await startServer(makeConfig(), { onRequest: (l) => logs.push(l) })

    await httpRequest(port, 'POST', '/run', '{"query": "test"}')

    expect(logs).toHaveLength(1)
    expect(logs[0].id).toBe(1)
    expect(logs[0].method).toBe('POST')
    expect(logs[0].path).toBe('/run')
    expect(logs[0].statusCode).toBe(200)
    expect(logs[0].durationMs).toBeGreaterThanOrEqual(0)
    expect(logs[0].inputPreview).toContain('query')
  })

  it('increments request IDs', async () => {
    vi.mocked(detectLlmKey).mockResolvedValue({ provider: 'openai', key: 'sk-test', model: 'gpt-4' })
    vi.mocked(callLlm).mockResolvedValue({})

    const logs: RequestLog[] = []
    await startServer(makeConfig(), { onRequest: (l) => logs.push(l) })

    await httpRequest(port, 'POST', '/run', '{}')
    await httpRequest(port, 'POST', '/run', '{}')
    await httpRequest(port, 'POST', '/run', '{}')

    expect(logs.map(l => l.id)).toEqual([1, 2, 3])
  })

  // ── Execution errors ──

  it('returns 500 when execution fails', async () => {
    vi.mocked(detectLlmKey).mockResolvedValue({ provider: 'openai', key: 'sk-test', model: 'gpt-4' })
    vi.mocked(callLlm).mockRejectedValue(new Error('LLM rate limit exceeded'))

    const logs: RequestLog[] = []
    await startServer(makeConfig(), { onRequest: (l) => logs.push(l) })

    const res = await httpRequest(port, 'POST', '/run', '{"task": "test"}')
    expect(res.statusCode).toBe(500)
    const body = JSON.parse(res.body)
    expect(body.error).toContain('rate limit')
    expect(logs[0].error).toContain('rate limit')
  })

  // ── Config with code_runtime shows entrypoint ──

  it('shows entrypoint in health for code_runtime', async () => {
    await startServer(makeConfig({
      manifest: makeManifest({ type: 'tool' }) as any,
      engine: 'code_runtime' as const,
      entrypoint: 'main.py',
      prompt: undefined,
    }))

    const res = await httpRequest(port, 'GET', '/health')
    const body = JSON.parse(res.body)
    expect(body.entrypoint).toBe('main.py')
    expect(body.engine).toBe('code_runtime')
  })
})
