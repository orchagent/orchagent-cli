import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
import path from 'path'
import fs from 'fs/promises'
import os from 'os'

vi.mock('../lib/config')
vi.mock('../lib/api', () => {
  const ApiError = class extends Error {
    status: number
    payload?: unknown
    constructor(message: string, status: number, payload?: unknown) {
      super(message)
      this.status = status
      this.payload = payload
    }
  }

  return {
    ApiError,
    publicRequest: vi.fn(),
    request: vi.fn(),
    listMyAgents: vi.fn(),
    getOrg: vi.fn(),
    downloadCodeBundle: vi.fn(),
    downloadCodeBundleAuthenticated: vi.fn(),
    resolveWorkspaceIdForOrg: vi.fn().mockResolvedValue(undefined),
  }
})
vi.mock('../lib/analytics')
vi.mock('../lib/output')

import { registerPullCommand } from './pull'
import { getResolvedConfig, loadConfig } from '../lib/config'
import {
  publicRequest,
  request,
  listMyAgents,
  getOrg,
  downloadCodeBundle,
  downloadCodeBundleAuthenticated,
  ApiError,
} from '../lib/api'
import { track } from '../lib/analytics'
import { printJson } from '../lib/output'

const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockLoadConfig = vi.mocked(loadConfig)
const mockPublicRequest = vi.mocked(publicRequest)
const mockRequest = vi.mocked(request)
const mockListMyAgents = vi.mocked(listMyAgents)
const mockGetOrg = vi.mocked(getOrg)
const mockDownloadCodeBundle = vi.mocked(downloadCodeBundle)
const mockDownloadCodeBundleAuthenticated = vi.mocked(downloadCodeBundleAuthenticated)
const mockTrack = vi.mocked(track)
const mockPrintJson = vi.mocked(printJson)

// Helper to create a valid test directory
function testOutputDir(): string {
  return path.join(os.tmpdir(), `orchagent-pull-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
}

// Standard download response
function makeDownloadResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'agent',
    run_mode: 'on_demand',
    execution_engine: 'direct_llm',
    callable: false,
    name: 'my-agent',
    version: 'v3',
    description: 'A test agent',
    prompt: 'You are a helpful assistant.',
    input_schema: { type: 'object', properties: { text: { type: 'string' } } },
    output_schema: { type: 'object', properties: { result: { type: 'string' } } },
    supported_providers: ['anthropic'],
    default_models: { anthropic: 'claude-sonnet-4-5-20250929' },
    default_skills: [],
    skills_locked: false,
    ...overrides,
  }
}

describe('pull command', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let outputDir: string

  beforeEach(() => {
    vi.clearAllMocks()

    program = new Command()
    program.exitOverride()
    registerPullCommand(program)

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    outputDir = testOutputDir()

    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'acme',
    })

    mockLoadConfig.mockResolvedValue({
      workspace: undefined,
      default_org: undefined,
    })

    mockTrack.mockResolvedValue(undefined)
  })

  afterEach(async () => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
    // Clean up test output dirs
    await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {})
  })

  // ─── Test 1: Public direct_llm agent without login ───────────────────────

  it('pulls a public direct_llm agent', async () => {
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: undefined,
      apiUrl: 'https://api.test.com',
      defaultOrg: undefined,
    })

    mockPublicRequest.mockResolvedValue(makeDownloadResponse())

    await program.parseAsync([
      'node', 'test', 'pull', 'acme/my-agent', '--output', outputDir,
    ])

    expect(mockPublicRequest).toHaveBeenCalledWith(
      expect.any(Object),
      '/public/agents/acme/my-agent/latest/download'
    )

    // Check files were written
    const manifest = JSON.parse(await fs.readFile(path.join(outputDir, 'orchagent.json'), 'utf-8'))
    expect(manifest.name).toBe('my-agent')
    expect(manifest.type).toBe('agent')

    const prompt = await fs.readFile(path.join(outputDir, 'prompt.md'), 'utf-8')
    expect(prompt).toBe('You are a helpful assistant.')

    const schema = JSON.parse(await fs.readFile(path.join(outputDir, 'schema.json'), 'utf-8'))
    expect(schema.input).toBeDefined()
    expect(schema.output).toBeDefined()
  })

  // ─── Test 2: Short ref using workspace/default-org fallback ──────────────

  it('resolves short ref using workspace fallback', async () => {
    mockLoadConfig.mockResolvedValue({ workspace: 'my-workspace' })
    mockPublicRequest.mockResolvedValue(makeDownloadResponse())

    await program.parseAsync([
      'node', 'test', 'pull', 'my-agent', '--output', outputDir,
    ])

    expect(mockPublicRequest).toHaveBeenCalledWith(
      expect.any(Object),
      '/public/agents/my-workspace/my-agent/latest/download'
    )
  })

  it('resolves short ref using defaultOrg fallback', async () => {
    mockLoadConfig.mockResolvedValue({})
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'acme',
    })

    mockPublicRequest.mockResolvedValue(makeDownloadResponse())

    await program.parseAsync([
      'node', 'test', 'pull', 'my-agent', '--output', outputDir,
    ])

    expect(mockPublicRequest).toHaveBeenCalledWith(
      expect.any(Object),
      '/public/agents/acme/my-agent/latest/download'
    )
  })

  // ─── Test 3: Missing org with short ref and no defaults ──────────────────

  it('errors when short ref has no org fallback', async () => {
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: undefined,
      apiUrl: 'https://api.test.com',
      defaultOrg: undefined,
    })
    mockLoadConfig.mockResolvedValue({})

    await expect(
      program.parseAsync(['node', 'test', 'pull', 'my-agent', '--output', outputDir])
    ).rejects.toThrow('Missing org')
  })

  // ─── Test 4: Pull managed_loop writes manifest, prompt, schema ───────────

  it('pulls managed_loop and writes all files', async () => {
    mockPublicRequest.mockResolvedValue(
      makeDownloadResponse({
        execution_engine: 'managed_loop',
        prompt: 'Loop prompt here.',
      })
    )

    await program.parseAsync([
      'node', 'test', 'pull', 'acme/my-agent', '--output', outputDir,
    ])

    const manifest = JSON.parse(await fs.readFile(path.join(outputDir, 'orchagent.json'), 'utf-8'))
    expect(manifest.name).toBe('my-agent')

    const prompt = await fs.readFile(path.join(outputDir, 'prompt.md'), 'utf-8')
    expect(prompt).toBe('Loop prompt here.')

    const schema = JSON.parse(await fs.readFile(path.join(outputDir, 'schema.json'), 'utf-8'))
    expect(schema.input).toBeDefined()
  })

  // ─── Test 5: code_runtime with bundle ────────────────────────────────────

  it('pulls code_runtime with bundle', async () => {
    mockPublicRequest.mockResolvedValue(
      makeDownloadResponse({
        type: 'tool',
        execution_engine: 'code_runtime',
        has_bundle: true,
        entrypoint: 'main.py',
        prompt: undefined,
      })
    )

    // Create a minimal zip file (just the PK header - unzip will fail but we catch that in the test)
    // For this test, we simulate bundle failure gracefully
    mockDownloadCodeBundle.mockRejectedValue(new ApiError('Not found', 404))
    mockDownloadCodeBundleAuthenticated.mockRejectedValue(new ApiError('Not found', 404))

    await program.parseAsync([
      'node', 'test', 'pull', 'acme/my-agent', '--output', outputDir,
    ])

    const manifest = JSON.parse(await fs.readFile(path.join(outputDir, 'orchagent.json'), 'utf-8'))
    expect(manifest.name).toBe('my-agent')
    expect(manifest.entrypoint).toBe('main.py')
    expect(manifest.runtime).toEqual({ command: 'python main.py' })

    // No prompt.md for code_runtime
    await expect(fs.access(path.join(outputDir, 'prompt.md'))).rejects.toThrow()
  })

  // ─── Test 6: code_runtime without bundle ─────────────────────────────────

  it('pulls code_runtime without bundle and warns', async () => {
    mockPublicRequest.mockResolvedValue(
      makeDownloadResponse({
        type: 'tool',
        execution_engine: 'code_runtime',
        has_bundle: false,
        prompt: undefined,
      })
    )

    await program.parseAsync([
      'node', 'test', 'pull', 'acme/my-agent', '--output', outputDir,
    ])

    const output = stdoutSpy.mock.calls.map((c) => c[0]).join('')
    expect(output).toContain('Warning:')
    expect(output).toContain('No downloadable bundle')
  })

  // ─── Test 7: --output custom path ────────────────────────────────────────

  it('uses custom output path', async () => {
    const customDir = testOutputDir()
    mockPublicRequest.mockResolvedValue(makeDownloadResponse())

    try {
      await program.parseAsync([
        'node', 'test', 'pull', 'acme/my-agent', '--output', customDir,
      ])

      const manifest = JSON.parse(await fs.readFile(path.join(customDir, 'orchagent.json'), 'utf-8'))
      expect(manifest.name).toBe('my-agent')
    } finally {
      await fs.rm(customDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  // ─── Test 8: Existing dir without --overwrite errors ─────────────────────

  it('errors when output dir exists without --overwrite', async () => {
    await fs.mkdir(outputDir, { recursive: true })

    mockPublicRequest.mockResolvedValue(makeDownloadResponse())

    await expect(
      program.parseAsync([
        'node', 'test', 'pull', 'acme/my-agent', '--output', outputDir,
      ])
    ).rejects.toThrow('already exists')
  })

  // ─── Test 9: --overwrite replaces existing dir ───────────────────────────

  it('--overwrite replaces existing contents', async () => {
    await fs.mkdir(outputDir, { recursive: true })
    await fs.writeFile(path.join(outputDir, 'old-file.txt'), 'old content')

    mockPublicRequest.mockResolvedValue(makeDownloadResponse())

    await program.parseAsync([
      'node', 'test', 'pull', 'acme/my-agent', '--output', outputDir, '--overwrite',
    ])

    // Old file should be gone
    await expect(fs.access(path.join(outputDir, 'old-file.txt'))).rejects.toThrow()

    // New files should exist
    const manifest = JSON.parse(await fs.readFile(path.join(outputDir, 'orchagent.json'), 'utf-8'))
    expect(manifest.name).toBe('my-agent')
  })

  // ─── Test 10: --json prints structured summary and still writes files ────

  it('--json prints structured summary and writes files', async () => {
    mockPublicRequest.mockResolvedValue(makeDownloadResponse())

    await program.parseAsync([
      'node', 'test', 'pull', 'acme/my-agent', '--output', outputDir, '--json',
    ])

    expect(mockPrintJson).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        requested_ref: 'acme/my-agent@latest',
        resolved_ref: 'acme/my-agent@v3',
        engine: 'direct_llm',
        source: 'public_download',
        files_written: expect.arrayContaining(['orchagent.json']),
      })
    )

    // Files should still be written
    const manifest = JSON.parse(await fs.readFile(path.join(outputDir, 'orchagent.json'), 'utf-8'))
    expect(manifest.name).toBe('my-agent')
  })

  // ─── Test 11: 403 server-only non-owner ──────────────────────────────────

  it('403 server-only non-owner gives friendly error', async () => {
    mockPublicRequest.mockRejectedValue(
      new ApiError('Download disabled', 403, {
        error: { code: 'DOWNLOAD_DISABLED', message: 'Download disabled' },
      })
    )
    mockListMyAgents.mockResolvedValue([])

    await expect(
      program.parseAsync([
        'node', 'test', 'pull', 'acme/my-agent', '--output', outputDir,
      ])
    ).rejects.toThrow('server-only')
  })

  // ─── Test 12: 403 owner path succeeds ────────────────────────────────────

  it('403 owner path falls back to authenticated', async () => {
    mockPublicRequest.mockRejectedValue(
      new ApiError('Download disabled', 403, {
        error: { code: 'DOWNLOAD_DISABLED', message: 'Download disabled' },
      })
    )

    mockListMyAgents.mockResolvedValue([
      {
        id: 'agent-id-1',
        name: 'my-agent',
        version: 'v3',
        type: 'agent',
        org_slug: 'acme',
        created_at: '2026-01-01T00:00:00Z',
      } as any,
    ])

    mockRequest.mockResolvedValue({
      id: 'agent-id-1',
      name: 'my-agent',
      version: 'v3',
      type: 'agent',
      execution_engine: 'direct_llm',
      description: 'Test agent',
      prompt: 'Owner prompt.',
      input_schema: null,
      output_schema: null,
      supported_providers: ['anthropic'],
      tags: ['test'],
    } as any)

    await program.parseAsync([
      'node', 'test', 'pull', 'acme/my-agent', '--output', outputDir,
    ])

    const manifest = JSON.parse(await fs.readFile(path.join(outputDir, 'orchagent.json'), 'utf-8'))
    expect(manifest.name).toBe('my-agent')
    expect(manifest.tags).toEqual(['test'])
  })

  // ─── Test 13: 404 private owned agent succeeds ──────────────────────────

  it('404 private owned agent falls back to authenticated', async () => {
    mockPublicRequest.mockRejectedValue(new ApiError('Not found', 404))

    mockGetOrg.mockResolvedValue({ id: 'org-1', name: 'Acme', slug: 'acme', created_at: '2026-01-01' })

    mockListMyAgents.mockResolvedValue([
      {
        id: 'agent-id-2',
        name: 'my-agent',
        version: 'v1',
        type: 'agent',
        org_slug: 'acme',
        created_at: '2026-01-01T00:00:00Z',
      } as any,
    ])

    mockRequest.mockResolvedValue({
      id: 'agent-id-2',
      name: 'my-agent',
      version: 'v1',
      type: 'agent',
      execution_engine: 'direct_llm',
      description: 'Private agent',
      prompt: 'Private prompt.',
    } as any)

    await program.parseAsync([
      'node', 'test', 'pull', 'acme/my-agent', '--output', outputDir,
    ])

    const prompt = await fs.readFile(path.join(outputDir, 'prompt.md'), 'utf-8')
    expect(prompt).toBe('Private prompt.')
  })

  it('does not resolve private fallback from another org with same agent name', async () => {
    mockPublicRequest.mockRejectedValue(new ApiError('Not found', 404))

    mockGetOrg.mockResolvedValue({ id: 'org-1', name: 'Acme', slug: 'acme', created_at: '2026-01-01' })
    mockListMyAgents.mockResolvedValue([
      {
        id: 'agent-id-other',
        name: 'my-agent',
        version: 'v9',
        type: 'agent',
        org_slug: 'other-org',
        created_at: '2026-01-01T00:00:00Z',
      } as any,
    ])

    await expect(
      program.parseAsync([
        'node', 'test', 'pull', 'acme/my-agent', '--output', outputDir,
      ])
    ).rejects.toThrow('not found')
  })

  // ─── Test 14: Skill target errors ────────────────────────────────────────

  it('rejects skills with helpful error', async () => {
    mockPublicRequest.mockResolvedValue(
      makeDownloadResponse({ type: 'skill' })
    )

    await expect(
      program.parseAsync([
        'node', 'test', 'pull', 'acme/my-skill', '--output', outputDir,
      ])
    ).rejects.toThrow('skill')
  })

  // ─── Analytics tracking ──────────────────────────────────────────────────

  it('tracks cli_pull analytics event', async () => {
    mockPublicRequest.mockResolvedValue(makeDownloadResponse())

    await program.parseAsync([
      'node', 'test', 'pull', 'acme/my-agent', '--output', outputDir,
    ])

    expect(mockTrack).toHaveBeenCalledWith('cli_pull', {
      org: 'acme',
      agent: 'my-agent',
      version: 'v3',
      engine: 'direct_llm',
      source: 'public_download',
    })
  })

  // ─── Manifest reconstruction ─────────────────────────────────────────────

  it('reconstructs manifest with all relevant fields', async () => {
    mockPublicRequest.mockResolvedValue(
      makeDownloadResponse({
        default_skills: ['acme/helper@v1'],
        skills_locked: true,
        default_models: { anthropic: 'claude-sonnet-4-5-20250929', openai: 'gpt-4o' },
        supported_providers: ['anthropic', 'openai'],
      })
    )

    await program.parseAsync([
      'node', 'test', 'pull', 'acme/my-agent', '--output', outputDir,
    ])

    const manifest = JSON.parse(await fs.readFile(path.join(outputDir, 'orchagent.json'), 'utf-8'))
    expect(manifest.default_skills).toEqual(['acme/helper@v1'])
    expect(manifest.skills_locked).toBe(true)
    expect(manifest.default_models).toEqual({ anthropic: 'claude-sonnet-4-5-20250929', openai: 'gpt-4o' })
    expect(manifest.supported_providers).toEqual(['anthropic', 'openai'])
  })

  it('preserves managed_loop config for round-trip publish', async () => {
    const loopConfig = {
      max_turns: 12,
      custom_tools: [
        {
          name: 'repo_scan',
          description: 'Scan repository',
          command: 'python scan.py',
          input_schema: { type: 'object' },
        },
      ],
    }
    mockPublicRequest.mockResolvedValue(
      makeDownloadResponse({
        execution_engine: 'managed_loop',
        loop: loopConfig,
      })
    )

    await program.parseAsync([
      'node', 'test', 'pull', 'acme/my-agent', '--output', outputDir,
    ])

    const manifest = JSON.parse(await fs.readFile(path.join(outputDir, 'orchagent.json'), 'utf-8'))
    expect(manifest.loop).toEqual(loopConfig)
    expect(manifest.max_turns).toBe(12)
    expect(manifest.custom_tools).toEqual(loopConfig.custom_tools)
  })

  it('preserves orchestration dependencies', async () => {
    mockPublicRequest.mockResolvedValue(
      makeDownloadResponse({
        dependencies: [{ id: 'acme/helper', version: 'v2' }],
      })
    )

    await program.parseAsync([
      'node', 'test', 'pull', 'acme/my-agent', '--output', outputDir,
    ])

    const manifest = JSON.parse(await fs.readFile(path.join(outputDir, 'orchagent.json'), 'utf-8'))
    expect(manifest.manifest).toEqual({
      dependencies: [{ id: 'acme/helper', version: 'v2' }],
    })
  })

  it('falls back to authenticated bundle download when public bundle is 403', async () => {
    mockPublicRequest.mockRejectedValue(
      new ApiError('Download disabled', 403, {
        error: { code: 'DOWNLOAD_DISABLED', message: 'Download disabled' },
      })
    )

    mockListMyAgents.mockResolvedValue([
      {
        id: 'agent-id-3',
        name: 'my-agent',
        version: 'v3',
        type: 'agent',
        org_slug: 'acme',
        created_at: '2026-01-01T00:00:00Z',
      } as any,
    ])

    mockRequest.mockResolvedValue({
      id: 'agent-id-3',
      name: 'my-agent',
      version: 'v3',
      type: 'tool',
      execution_engine: 'code_runtime',
      description: 'Tool agent',
      code_bundle_url: 'supabase://bundles/agent-id-3.zip',
      entrypoint: 'main.py',
    } as any)

    mockDownloadCodeBundle.mockRejectedValue(new ApiError('Forbidden', 403))
    mockDownloadCodeBundleAuthenticated.mockRejectedValue(new ApiError('Not found', 404))

    await program.parseAsync([
      'node', 'test', 'pull', 'acme/my-agent', '--output', outputDir,
    ])

    expect(mockDownloadCodeBundle).toHaveBeenCalled()
    expect(mockDownloadCodeBundleAuthenticated).toHaveBeenCalledWith(
      expect.any(Object),
      'agent-id-3'
    )
  })

  it('omits schema.json when no schemas exist', async () => {
    mockPublicRequest.mockResolvedValue(
      makeDownloadResponse({
        input_schema: undefined,
        output_schema: undefined,
      })
    )

    await program.parseAsync([
      'node', 'test', 'pull', 'acme/my-agent', '--output', outputDir,
    ])

    await expect(fs.access(path.join(outputDir, 'schema.json'))).rejects.toThrow()
  })

  // ─── Test: code_runtime bundle extraction does not prompt for overwrite ──

  it('extracts bundle without interactive overwrite prompt (schema.json collision)', async () => {
    // Create a real zip containing schema.json + main.py using archiver.
    // Before the fix, unzip would prompt "replace schema.json? [y/n]" because
    // pull wrote schema.json before extraction.  With the fix, bundle is
    // extracted first and metadata files are written on top.
    const archiver = await import('archiver')
    const zipBuffer = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      const archive = archiver.default('zip', { zlib: { level: 0 } })
      archive.on('data', (chunk: Buffer) => chunks.push(chunk))
      archive.on('end', () => resolve(Buffer.concat(chunks)))
      archive.on('error', reject)
      archive.append('print("hello")', { name: 'main.py' })
      archive.append('{"input":{"type":"object"}}', { name: 'schema.json' })
      archive.append('orchagent-sdk>=0.1.0', { name: 'requirements.txt' })
      archive.finalize()
    })

    mockPublicRequest.mockResolvedValue(
      makeDownloadResponse({
        type: 'tool',
        execution_engine: 'code_runtime',
        has_bundle: true,
        entrypoint: 'main.py',
        prompt: undefined,
        input_schema: { type: 'object', properties: { query: { type: 'string' } } },
        output_schema: { type: 'object', properties: { answer: { type: 'string' } } },
      })
    )

    mockDownloadCodeBundle.mockResolvedValue(zipBuffer)

    await program.parseAsync([
      'node', 'test', 'pull', 'acme/my-agent', '--output', outputDir,
    ])

    // Verify bundle files were extracted
    const mainPy = await fs.readFile(path.join(outputDir, 'main.py'), 'utf-8')
    expect(mainPy).toBe('print("hello")')

    const reqTxt = await fs.readFile(path.join(outputDir, 'requirements.txt'), 'utf-8')
    expect(reqTxt).toBe('orchagent-sdk>=0.1.0')

    // Verify metadata files written AFTER extraction take precedence
    const manifest = JSON.parse(await fs.readFile(path.join(outputDir, 'orchagent.json'), 'utf-8'))
    expect(manifest.name).toBe('my-agent')
    expect(manifest.entrypoint).toBe('main.py')

    // schema.json should be the server-reconstructed version, not the bundle's raw copy
    const schema = JSON.parse(await fs.readFile(path.join(outputDir, 'schema.json'), 'utf-8'))
    expect(schema.input).toEqual({ type: 'object', properties: { query: { type: 'string' } } })
    expect(schema.output).toEqual({ type: 'object', properties: { answer: { type: 'string' } } })

    // Verify output mentions bundle extraction
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join('')
    expect(output).toContain('Bundle extracted')
  })

  it('omits prompt.md for code_runtime agents', async () => {
    mockPublicRequest.mockResolvedValue(
      makeDownloadResponse({
        execution_engine: 'code_runtime',
        has_bundle: false,
        prompt: undefined,
      })
    )

    await program.parseAsync([
      'node', 'test', 'pull', 'acme/my-agent', '--output', outputDir,
    ])

    await expect(fs.access(path.join(outputDir, 'prompt.md'))).rejects.toThrow()
  })
})
