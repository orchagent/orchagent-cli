/**
 * Tests for the info command.
 *
 * Bug 5: Verify that orch info works for server-only agents
 * by using public metadata endpoint instead of /download.
 * UX-006: Verify that orch info shows dependencies, skills, and custom tools.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

vi.mock('../lib/config', () => ({
  getResolvedConfig: vi.fn(),
  loadConfig: vi.fn().mockResolvedValue({}),
}))
vi.mock('../lib/api', () => {
  const ApiError = class extends Error {
    status: number
    payload: unknown
    constructor(message: string, status: number) {
      super(message)
      this.status = status
    }
  }
  return {
    ApiError,
    getOrg: vi.fn(),
    listMyAgents: vi.fn(),
    getPublicAgent: vi.fn(),
    resolveWorkspaceIdForOrg: vi.fn().mockResolvedValue(undefined),
  }
})

import { registerInfoCommand } from './info'
import { getResolvedConfig } from '../lib/config'
import { getPublicAgent, getOrg, listMyAgents } from '../lib/api'

const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockGetPublicAgent = vi.mocked(getPublicAgent)
const mockGetOrg = vi.mocked(getOrg)
const mockListMyAgents = vi.mocked(listMyAgents)

function allStdout(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map(c => c[0]).join('')
}

describe('Bug 5: orch info for server-only agents', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerInfoCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'test-org',
    })
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('uses public metadata endpoint (not /download) for agent info', async () => {
    mockGetPublicAgent.mockResolvedValue({
      id: 'agent-123',
      org_name: 'OrchAgent',
      org_slug: 'orchagent',
      name: 'leak-finder',
      version: 'v1',
      type: 'tool',
      description: 'Finds API key leaks',
      supported_providers: ['any'],
      is_public: true,
      input_schema: {
        properties: { repo_url: { type: 'string', description: 'Repository URL' } },
        required: ['repo_url'],
      },
    } as any)

    await program.parseAsync(['node', 'test', 'info', 'orchagent/leak-finder'])

    // Should call getPublicAgent (metadata endpoint), NOT download endpoint
    expect(mockGetPublicAgent).toHaveBeenCalledWith(
      expect.any(Object),
      'orchagent',
      'leak-finder',
      'latest'
    )

    // Should display agent info
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('leak-finder'))
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Finds API key leaks'))
  })

  it('works for server-only agents (allow_local_download=false)', async () => {
    mockGetPublicAgent.mockResolvedValue({
      id: 'agent-456',
      org_name: 'OrchAgent',
      org_slug: 'orchagent',
      name: 'server-only-agent',
      version: 'v1',
      type: 'tool',
      description: 'A server-only agent',
      supported_providers: ['openai'],
      is_public: true,
      allow_local_download: false,
      pricing_mode: 'per_call',
      price_per_call_cents: 50,
    } as any)

    // Should NOT throw — previously this would fail with 403
    await program.parseAsync(['node', 'test', 'info', 'orchagent/server-only-agent'])

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('server-only-agent'))
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('A server-only agent'))
  })

  it('outputs JSON when --json is specified', async () => {
    mockGetPublicAgent.mockResolvedValue({
      id: 'agent-789',
      org_name: 'TestOrg',
      org_slug: 'testorg',
      name: 'json-agent',
      version: 'v1',
      type: 'prompt',
      description: 'A test agent',
      supported_providers: ['any'],
      is_public: true,
    } as any)

    await program.parseAsync(['node', 'test', 'info', 'testorg/json-agent', '--json'])

    // Should output valid JSON
    const jsonOutput = stdoutSpy.mock.calls.find(call =>
      call[0].toString().includes('"name"')
    )
    expect(jsonOutput).toBeTruthy()
    const parsed = JSON.parse(jsonOutput![0] as string)
    expect(parsed.name).toBe('json-agent')
    expect(parsed.type).toBe('prompt')
  })
})

describe('UX-006: orch info shows dependencies', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerInfoCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'test-org',
    })
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('displays manifest dependencies', async () => {
    mockGetPublicAgent.mockResolvedValue({
      id: 'agent-dep-1',
      org_name: 'Joe',
      org_slug: 'joe',
      name: 'stock-assistant',
      version: 'v1',
      type: 'agent',
      description: 'Stock management orchestrator',
      supported_providers: ['anthropic'],
      manifest: {
        manifest_version: 1,
        dependencies: [
          { id: 'stocksure/stock-predictor', version: 'v3' },
          { id: 'joe/audit-agent', version: 'v1' },
        ],
        max_hops: 2,
        timeout_ms: 180000,
        per_call_downstream_cap: 50,
      },
    } as any)

    await program.parseAsync(['node', 'test', 'info', 'joe/stock-assistant'])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('Dependencies:')
    expect(output).toContain('stocksure/stock-predictor')
    expect(output).toContain('@v3')
    expect(output).toContain('joe/audit-agent')
    expect(output).toContain('@v1')
  })

  it('displays default skills', async () => {
    mockGetPublicAgent.mockResolvedValue({
      id: 'agent-skill-1',
      org_name: 'Joe',
      org_slug: 'joe',
      name: 'scanner-tool',
      version: 'v2',
      type: 'tool',
      description: 'Security scanner',
      supported_providers: ['any'],
      default_skills: ['joe/scan-rules@v1', 'joe/vuln-db@v2'],
    } as any)

    await program.parseAsync(['node', 'test', 'info', 'joe/scanner-tool'])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('Skills:')
    expect(output).toContain('joe/scan-rules@v1')
    expect(output).toContain('joe/vuln-db@v2')
  })

  it('displays custom tools from manifest', async () => {
    mockGetPublicAgent.mockResolvedValue({
      id: 'agent-tools-1',
      org_name: 'Joe',
      org_slug: 'joe',
      name: 'build-agent',
      version: 'v1',
      type: 'agent',
      description: 'Build automation agent',
      supported_providers: ['anthropic'],
      manifest: {
        manifest_version: 1,
        dependencies: [],
        max_hops: 0,
        timeout_ms: 60000,
        per_call_downstream_cap: 0,
        custom_tools: [
          { name: 'run_tests', description: 'Run the test suite', command: 'npm test' },
          { name: 'lint', description: 'Run linter', command: 'eslint .' },
        ],
      },
    } as any)

    await program.parseAsync(['node', 'test', 'info', 'joe/build-agent'])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('Custom Tools:')
    expect(output).toContain('run_tests')
    expect(output).toContain('Run the test suite')
    expect(output).toContain('lint')
    expect(output).toContain('Run linter')
  })

  it('displays all dependency types together', async () => {
    mockGetPublicAgent.mockResolvedValue({
      id: 'agent-all-1',
      org_name: 'Joe',
      org_slug: 'joe',
      name: 'mega-orchestrator',
      version: 'v1',
      type: 'agent',
      description: 'Full orchestrator',
      supported_providers: ['anthropic'],
      default_skills: ['joe/format-skill@v1'],
      manifest: {
        manifest_version: 1,
        dependencies: [{ id: 'joe/sub-agent', version: 'v2' }],
        max_hops: 3,
        timeout_ms: 300000,
        per_call_downstream_cap: 100,
        custom_tools: [{ name: 'deploy', description: 'Deploy to prod' }],
      },
    } as any)

    await program.parseAsync(['node', 'test', 'info', 'joe/mega-orchestrator'])

    const output = allStdout(stdoutSpy)
    // All three sections should appear
    expect(output).toContain('Dependencies:')
    expect(output).toContain('joe/sub-agent')
    expect(output).toContain('Skills:')
    expect(output).toContain('joe/format-skill@v1')
    expect(output).toContain('Custom Tools:')
    expect(output).toContain('deploy')
  })

  it('does not display dependency sections when agent has none', async () => {
    mockGetPublicAgent.mockResolvedValue({
      id: 'agent-none-1',
      org_name: 'Joe',
      org_slug: 'joe',
      name: 'simple-prompt',
      version: 'v1',
      type: 'prompt',
      description: 'A simple prompt agent',
      supported_providers: ['any'],
    } as any)

    await program.parseAsync(['node', 'test', 'info', 'joe/simple-prompt'])

    const output = allStdout(stdoutSpy)
    expect(output).not.toContain('Dependencies:')
    expect(output).not.toContain('Skills:')
    expect(output).not.toContain('Custom Tools:')
  })

  it('includes dependencies in JSON output', async () => {
    mockGetPublicAgent.mockResolvedValue({
      id: 'agent-json-dep',
      org_name: 'Joe',
      org_slug: 'joe',
      name: 'json-dep-agent',
      version: 'v1',
      type: 'agent',
      description: 'Agent with deps',
      supported_providers: ['anthropic'],
      default_skills: ['joe/my-skill@v1'],
      manifest: {
        manifest_version: 1,
        dependencies: [{ id: 'joe/helper', version: 'v2' }],
        max_hops: 2,
        timeout_ms: 60000,
        per_call_downstream_cap: 10,
        custom_tools: [{ name: 'check', description: 'Run checks' }],
      },
    } as any)

    await program.parseAsync(['node', 'test', 'info', 'joe/json-dep-agent', '--json'])

    const jsonOutput = stdoutSpy.mock.calls.find(call =>
      call[0].toString().includes('"name"')
    )
    expect(jsonOutput).toBeTruthy()
    const parsed = JSON.parse(jsonOutput![0] as string)
    expect(parsed.dependencies).toEqual([{ id: 'joe/helper', version: 'v2' }])
    expect(parsed.default_skills).toEqual(['joe/my-skill@v1'])
    expect(parsed.custom_tools).toEqual([{ name: 'check', description: 'Run checks' }])
  })

  it('handles empty manifest dependencies gracefully', async () => {
    mockGetPublicAgent.mockResolvedValue({
      id: 'agent-empty-manifest',
      org_name: 'Joe',
      org_slug: 'joe',
      name: 'empty-manifest',
      version: 'v1',
      type: 'agent',
      description: 'Agent with empty manifest',
      supported_providers: ['any'],
      manifest: {
        manifest_version: 1,
        dependencies: [],
        max_hops: 0,
        timeout_ms: 60000,
        per_call_downstream_cap: 0,
      },
      default_skills: [],
    } as any)

    await program.parseAsync(['node', 'test', 'info', 'joe/empty-manifest'])

    const output = allStdout(stdoutSpy)
    expect(output).not.toContain('Dependencies:')
    expect(output).not.toContain('Skills:')
    expect(output).not.toContain('Custom Tools:')
  })

  it('handles null manifest and default_skills', async () => {
    mockGetPublicAgent.mockResolvedValue({
      id: 'agent-null-manifest',
      org_name: 'Joe',
      org_slug: 'joe',
      name: 'null-manifest',
      version: 'v1',
      type: 'prompt',
      description: 'No manifest',
      supported_providers: ['any'],
      manifest: null,
      default_skills: null,
    } as any)

    await program.parseAsync(['node', 'test', 'info', 'joe/null-manifest'])

    const output = allStdout(stdoutSpy)
    expect(output).not.toContain('Dependencies:')
    expect(output).not.toContain('Skills:')
    expect(output).not.toContain('Custom Tools:')
  })

  it('shows dependencies via private agent fallback path', async () => {
    const { ApiError } = await import('../lib/api')
    mockGetPublicAgent.mockRejectedValue(new ApiError('Not found', 404))
    mockGetOrg.mockResolvedValue({
      id: 'org-1',
      name: 'Joe',
      slug: 'joe',
      created_at: '2026-01-01T00:00:00Z',
    })
    mockListMyAgents.mockResolvedValue([
      {
        id: 'private-agent-1',
        name: 'private-orch',
        version: 'v1',
        type: 'agent',
        description: 'Private orchestrator',
        supported_providers: ['anthropic'],
        created_at: '2026-01-01T00:00:00Z',
        default_skills: ['joe/internal-skill@v1'],
        manifest: {
          manifest_version: 1,
          dependencies: [{ id: 'joe/private-helper', version: 'v3' }],
          max_hops: 2,
          timeout_ms: 120000,
          per_call_downstream_cap: 20,
        },
      } as any,
    ])

    await program.parseAsync(['node', 'test', 'info', 'joe/private-orch@v1'])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('Dependencies:')
    expect(output).toContain('joe/private-helper')
    expect(output).toContain('@v3')
    expect(output).toContain('Skills:')
    expect(output).toContain('joe/internal-skill@v1')
  })

  it('displays environment from private agent fallback (UX-006)', async () => {
    const { ApiError } = await import('../lib/api')
    mockGetPublicAgent.mockRejectedValue(new ApiError('Not found', 404))
    mockGetOrg.mockResolvedValue({
      id: 'org-1',
      name: 'Joe',
      slug: 'joe',
      created_at: '2026-01-01T00:00:00Z',
    })
    mockListMyAgents.mockResolvedValue([
      {
        id: 'private-env-1',
        name: 'private-env-agent',
        version: 'v1',
        type: 'tool',
        description: 'Private agent with env pinning',
        supported_providers: ['any'],
        created_at: '2026-01-01T00:00:00Z',
        manifest: {
          manifest_version: 1,
          dependencies: [],
          max_hops: 0,
          timeout_ms: 60000,
          per_call_downstream_cap: 0,
          environment: {
            python_version: '3.12',
            node_version: '18',
          },
        },
      } as any,
    ])

    await program.parseAsync(['node', 'test', 'info', 'joe/private-env-agent@v1'])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('Environment:')
    expect(output).toContain('Python 3.12')
    expect(output).toContain('Node 18')
  })

  it('handles custom tools without descriptions', async () => {
    mockGetPublicAgent.mockResolvedValue({
      id: 'agent-tools-nodesc',
      org_name: 'Joe',
      org_slug: 'joe',
      name: 'minimal-tools',
      version: 'v1',
      type: 'agent',
      description: 'Minimal custom tools',
      supported_providers: ['any'],
      manifest: {
        manifest_version: 1,
        dependencies: [],
        max_hops: 0,
        timeout_ms: 60000,
        per_call_downstream_cap: 0,
        custom_tools: [
          { name: 'build', command: 'make build' },
          { name: 'clean', command: 'make clean' },
        ],
      },
    } as any)

    await program.parseAsync(['node', 'test', 'info', 'joe/minimal-tools'])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('Custom Tools:')
    expect(output).toContain('build')
    expect(output).toContain('clean')
    // No em-dash for tools without descriptions
    expect(output).not.toContain('build —')
    expect(output).not.toContain('clean —')
  })
})

describe('IDEA-013: orch info shows environment pinning', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerInfoCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'test-org',
    })
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('displays environment pinning when present', async () => {
    mockGetPublicAgent.mockResolvedValue({
      id: 'agent-env-1',
      org_name: 'Joe',
      org_slug: 'joe',
      name: 'pinned-agent',
      version: 'v1',
      type: 'tool',
      description: 'Agent with environment pinning',
      supported_providers: ['any'],
      manifest: {
        manifest_version: 1,
        dependencies: [],
        max_hops: 0,
        timeout_ms: 60000,
        per_call_downstream_cap: 0,
        environment: {
          python_version: '3.11',
          node_version: '20',
        },
      },
    } as any)

    await program.parseAsync(['node', 'test', 'info', 'joe/pinned-agent'])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('Environment:')
    expect(output).toContain('Python 3.11')
    expect(output).toContain('Node 20')
  })

  it('displays pip and npm flags', async () => {
    mockGetPublicAgent.mockResolvedValue({
      id: 'agent-env-2',
      org_name: 'Joe',
      org_slug: 'joe',
      name: 'flags-agent',
      version: 'v1',
      type: 'tool',
      description: 'Agent with pip/npm flags',
      supported_providers: ['any'],
      manifest: {
        manifest_version: 1,
        dependencies: [],
        max_hops: 0,
        timeout_ms: 60000,
        per_call_downstream_cap: 0,
        environment: {
          pip_flags: '--no-deps --pre',
          npm_flags: '--legacy-peer-deps',
        },
      },
    } as any)

    await program.parseAsync(['node', 'test', 'info', 'joe/flags-agent'])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('Environment:')
    expect(output).toContain('pip flags: --no-deps --pre')
    expect(output).toContain('npm flags: --legacy-peer-deps')
  })

  it('does not display environment section when not present', async () => {
    mockGetPublicAgent.mockResolvedValue({
      id: 'agent-env-3',
      org_name: 'Joe',
      org_slug: 'joe',
      name: 'no-env-agent',
      version: 'v1',
      type: 'prompt',
      description: 'Agent without environment pinning',
      supported_providers: ['any'],
      manifest: {
        manifest_version: 1,
        dependencies: [],
        max_hops: 0,
        timeout_ms: 60000,
        per_call_downstream_cap: 0,
      },
    } as any)

    await program.parseAsync(['node', 'test', 'info', 'joe/no-env-agent'])

    const output = allStdout(stdoutSpy)
    expect(output).not.toContain('Environment:')
  })

  it('includes environment in JSON output', async () => {
    mockGetPublicAgent.mockResolvedValue({
      id: 'agent-env-4',
      org_name: 'Joe',
      org_slug: 'joe',
      name: 'json-env-agent',
      version: 'v1',
      type: 'tool',
      description: 'Agent with env for JSON output',
      supported_providers: ['any'],
      manifest: {
        manifest_version: 1,
        dependencies: [],
        max_hops: 0,
        timeout_ms: 60000,
        per_call_downstream_cap: 0,
        environment: {
          python_version: '3.11',
          node_version: '20',
          pip_flags: '--no-deps',
          npm_flags: '--legacy-peer-deps',
        },
      },
    } as any)

    await program.parseAsync(['node', 'test', 'info', 'joe/json-env-agent', '--json'])

    const jsonOutput = stdoutSpy.mock.calls.find(call =>
      call[0].toString().includes('"name"')
    )
    expect(jsonOutput).toBeTruthy()
    const parsed = JSON.parse(jsonOutput![0] as string)
    expect(parsed.environment).toEqual({
      python_version: '3.11',
      node_version: '20',
      pip_flags: '--no-deps',
      npm_flags: '--legacy-peer-deps',
    })
  })

  it('displays environment from private agent fallback', async () => {
    const { ApiError } = await import('../lib/api')
    mockGetPublicAgent.mockRejectedValue(new ApiError('Not found', 404))
    mockGetOrg.mockResolvedValue({
      id: 'org-1',
      name: 'Joe',
      slug: 'joe',
      created_at: '2026-01-01T00:00:00Z',
    })
    mockListMyAgents.mockResolvedValue([
      {
        id: 'private-env-agent-1',
        name: 'private-pinned',
        version: 'v1',
        type: 'agent',
        description: 'Private agent with env pinning',
        supported_providers: ['anthropic'],
        created_at: '2026-01-01T00:00:00Z',
        manifest: {
          manifest_version: 1,
          dependencies: [],
          max_hops: 0,
          timeout_ms: 60000,
          per_call_downstream_cap: 0,
          environment: {
            python_version: '3.11',
            node_version: '20',
          },
        },
      } as any,
    ])

    await program.parseAsync(['node', 'test', 'info', 'joe/private-pinned@v1'])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('Environment:')
    expect(output).toContain('Python 3.11')
    expect(output).toContain('Node 20')
  })
})

describe('Surface secrets in orch info', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerInfoCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'test-org',
    })
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('displays required secrets', async () => {
    mockGetPublicAgent.mockResolvedValue({
      id: 'agent-secrets-1',
      org_name: 'OrchAgent',
      org_slug: 'orchagent',
      name: 'cto-agent',
      version: 'v1',
      type: 'agent',
      description: 'AI CTO agent',
      supported_providers: ['anthropic'],
      required_secrets: ['MONITOR_URLS', 'ANTHROPIC_API_KEY'],
    } as any)

    await program.parseAsync(['node', 'test', 'info', 'orchagent/cto-agent'])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('Secrets (required):')
    expect(output).toContain('MONITOR_URLS')
    expect(output).toContain('ANTHROPIC_API_KEY')
  })

  it('displays optional secrets', async () => {
    mockGetPublicAgent.mockResolvedValue({
      id: 'agent-secrets-2',
      org_name: 'OrchAgent',
      org_slug: 'orchagent',
      name: 'cto-agent',
      version: 'v1',
      type: 'agent',
      description: 'AI CTO agent',
      supported_providers: ['anthropic'],
      required_secrets: ['MONITOR_URLS'],
      optional_secrets: ['DISCORD_WEBHOOK_URL', 'SLACK_WEBHOOK_URL'],
    } as any)

    await program.parseAsync(['node', 'test', 'info', 'orchagent/cto-agent'])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('Secrets (optional):')
    expect(output).toContain('DISCORD_WEBHOOK_URL')
    expect(output).toContain('SLACK_WEBHOOK_URL')
  })

  it('displays both required and optional secrets together', async () => {
    mockGetPublicAgent.mockResolvedValue({
      id: 'agent-secrets-3',
      org_name: 'OrchAgent',
      org_slug: 'orchagent',
      name: 'cto-agent',
      version: 'v1',
      type: 'agent',
      description: 'AI CTO agent',
      supported_providers: ['anthropic'],
      required_secrets: ['MONITOR_URLS', 'ANTHROPIC_API_KEY'],
      optional_secrets: ['DISCORD_WEBHOOK_URL', 'BACKUP_S3_ENDPOINT'],
    } as any)

    await program.parseAsync(['node', 'test', 'info', 'orchagent/cto-agent'])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('Secrets (required): MONITOR_URLS, ANTHROPIC_API_KEY')
    expect(output).toContain('Secrets (optional): DISCORD_WEBHOOK_URL, BACKUP_S3_ENDPOINT')
  })

  it('does not display secrets section when none exist', async () => {
    mockGetPublicAgent.mockResolvedValue({
      id: 'agent-secrets-4',
      org_name: 'Joe',
      org_slug: 'joe',
      name: 'simple-agent',
      version: 'v1',
      type: 'prompt',
      description: 'A simple agent',
      supported_providers: ['any'],
    } as any)

    await program.parseAsync(['node', 'test', 'info', 'joe/simple-agent'])

    const output = allStdout(stdoutSpy)
    expect(output).not.toContain('Secrets')
  })

  it('includes secrets in JSON output', async () => {
    mockGetPublicAgent.mockResolvedValue({
      id: 'agent-secrets-5',
      org_name: 'OrchAgent',
      org_slug: 'orchagent',
      name: 'cto-agent',
      version: 'v1',
      type: 'agent',
      description: 'AI CTO agent',
      supported_providers: ['anthropic'],
      required_secrets: ['MONITOR_URLS'],
      optional_secrets: ['DISCORD_WEBHOOK_URL'],
    } as any)

    await program.parseAsync(['node', 'test', 'info', 'orchagent/cto-agent', '--json'])

    const jsonOutput = stdoutSpy.mock.calls.find(call =>
      call[0].toString().includes('"name"')
    )
    expect(jsonOutput).toBeTruthy()
    const parsed = JSON.parse(jsonOutput![0] as string)
    expect(parsed.required_secrets).toEqual(['MONITOR_URLS'])
    expect(parsed.optional_secrets).toEqual(['DISCORD_WEBHOOK_URL'])
  })

  it('shows secrets via private agent fallback path', async () => {
    const { ApiError } = await import('../lib/api')
    mockGetPublicAgent.mockRejectedValue(new ApiError('Not found', 404))
    mockGetOrg.mockResolvedValue({
      id: 'org-1',
      name: 'Joe',
      slug: 'joe',
      created_at: '2026-01-01T00:00:00Z',
    })
    mockListMyAgents.mockResolvedValue([
      {
        id: 'private-agent-secrets',
        name: 'private-cto',
        version: 'v1',
        type: 'agent',
        description: 'Private CTO agent',
        supported_providers: ['anthropic'],
        created_at: '2026-01-01T00:00:00Z',
        required_secrets: ['MONITOR_URLS', 'ANTHROPIC_API_KEY'],
        optional_secrets: ['DISCORD_WEBHOOK_URL'],
      } as any,
    ])

    await program.parseAsync(['node', 'test', 'info', 'joe/private-cto@v1'])

    const output = allStdout(stdoutSpy)
    expect(output).toContain('Secrets (required): MONITOR_URLS, ANTHROPIC_API_KEY')
    expect(output).toContain('Secrets (optional): DISCORD_WEBHOOK_URL')
  })

  it('handles null/undefined secrets gracefully', async () => {
    mockGetPublicAgent.mockResolvedValue({
      id: 'agent-secrets-null',
      org_name: 'Joe',
      org_slug: 'joe',
      name: 'null-secrets',
      version: 'v1',
      type: 'prompt',
      description: 'Agent with null secrets',
      supported_providers: ['any'],
      required_secrets: null,
      optional_secrets: null,
    } as any)

    await program.parseAsync(['node', 'test', 'info', 'joe/null-secrets'])

    const output = allStdout(stdoutSpy)
    expect(output).not.toContain('Secrets')
  })
})
