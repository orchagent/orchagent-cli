import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Command } from 'commander'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

vi.mock('../lib/config', () => ({
  getResolvedConfig: vi.fn(),
}))

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
    getAgentWithFallback: vi.fn(),
    resolveWorkspaceIdForOrg: vi.fn(),
  }
})

vi.mock('../lib/analytics', () => ({
  track: vi.fn().mockResolvedValue(undefined),
}))

import { registerScaffoldCommand } from './scaffold'
import { getResolvedConfig } from '../lib/config'
import {
  ApiError,
  getAgentWithFallback,
  resolveWorkspaceIdForOrg,
} from '../lib/api'

const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockGetAgentWithFallback = vi.mocked(getAgentWithFallback)
const mockResolveWorkspaceIdForOrg = vi.mocked(resolveWorkspaceIdForOrg)

function testDir(): string {
  return path.join(
    os.tmpdir(),
    `orchagent-scaffold-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
}

function allStdout(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((c) => c[0]).join('')
}

describe('orch scaffold orchestration', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let cwdBefore: string
  let workspaceDir: string

  beforeEach(async () => {
    vi.clearAllMocks()

    program = new Command()
    program.exitOverride()
    registerScaffoldCommand(program)

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    cwdBefore = process.cwd()
    workspaceDir = testDir()
    await fs.mkdir(workspaceDir, { recursive: true })
    process.chdir(workspaceDir)

    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'acme',
    })

    mockResolveWorkspaceIdForOrg.mockResolvedValue(undefined)
    mockGetAgentWithFallback.mockImplementation(
      async (_config, org, agent, version) =>
        ({
          id: `${org}-${agent}-${version}`,
          org_slug: org,
          name: agent,
          version: version === 'latest' ? 'v9' : version,
          type: 'agent',
          callable: true,
          description: `${agent} dependency`,
          input_schema: {
            type: 'object',
            properties: {
              task: { type: 'string' },
            },
            required: ['task'],
          },
        }) as any
    )
  })

  afterEach(async () => {
    process.chdir(cwdBefore)
    await fs.rm(workspaceDir, { recursive: true, force: true })
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('generates orchestrator scaffold with pinned dependencies and files', async () => {
    await program.parseAsync([
      'node',
      'test',
      'scaffold',
      'orchestration',
      'acme/scanner',
      'acme/auditor@v2',
    ])

    const manifest = JSON.parse(await fs.readFile(path.join(workspaceDir, 'orchagent.json'), 'utf-8'))
    const prompt = await fs.readFile(path.join(workspaceDir, 'prompt.md'), 'utf-8')
    const schema = JSON.parse(await fs.readFile(path.join(workspaceDir, 'schema.json'), 'utf-8'))

    expect(manifest.name).toBe(path.basename(workspaceDir))
    expect(manifest.manifest.dependencies).toEqual([
      { id: 'acme/scanner', version: 'v9' },
      { id: 'acme/auditor', version: 'v2' },
    ])
    expect(manifest.custom_tools).toHaveLength(2)
    expect(manifest.custom_tools[0].command).toContain('acme/scanner@v9')
    expect(manifest.custom_tools[1].command).toContain('acme/auditor@v2')
    expect(prompt).toContain('call_scanner')
    expect(prompt).toContain('acme/scanner@v9')
    expect(prompt).toContain('{{task}}')
    expect(schema.input.required).toEqual(['task'])
    expect(schema.output.required).toEqual(['result', 'used_tools'])
  })

  it('uses default org for single-segment refs', async () => {
    await program.parseAsync([
      'node',
      'test',
      'scaffold',
      'orchestration',
      'scanner@v3',
    ])

    expect(mockGetAgentWithFallback).toHaveBeenCalledWith(
      expect.anything(),
      'acme',
      'scanner',
      'v3',
      undefined
    )
  })

  it('errors when ref omits org and no default org is set', async () => {
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: undefined,
    })

    await expect(
      program.parseAsync(['node', 'test', 'scaffold', 'orchestration', 'scanner'])
    ).rejects.toThrow('Missing org')
  })

  it('rejects dependencies with callable: false', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      id: 'agent-1',
      org_slug: 'acme',
      name: 'scanner',
      version: 'v1',
      type: 'agent',
      callable: false,
    } as any)

    await expect(
      program.parseAsync(['node', 'test', 'scaffold', 'orchestration', 'acme/scanner'])
    ).rejects.toThrow('callable: false')
  })

  it('rejects skill dependencies', async () => {
    mockGetAgentWithFallback.mockResolvedValue({
      id: 'skill-1',
      org_slug: 'acme',
      name: 'scan-rules',
      version: 'v1',
      type: 'skill',
      callable: false,
    } as any)

    await expect(
      program.parseAsync(['node', 'test', 'scaffold', 'orchestration', 'acme/scan-rules'])
    ).rejects.toThrow('is a skill')
  })

  it('dedupes identical dependency refs', async () => {
    await program.parseAsync([
      'node',
      'test',
      'scaffold',
      'orchestration',
      'acme/scanner@v2',
      'acme/scanner@v2',
    ])

    const manifest = JSON.parse(await fs.readFile(path.join(workspaceDir, 'orchagent.json'), 'utf-8'))
    expect(manifest.manifest.dependencies).toEqual([
      { id: 'acme/scanner', version: 'v2' },
    ])
    expect(allStdout(stdoutSpy)).toContain('Removed duplicate dependency refs')
  })

  it('errors on conflicting dependency versions for the same agent', async () => {
    mockGetAgentWithFallback.mockImplementation(
      async (_config, org, agent, version) =>
        ({
          id: `${org}-${agent}-${version}`,
          org_slug: org,
          name: agent,
          version,
          type: 'agent',
          callable: true,
        }) as any
    )

    await expect(
      program.parseAsync([
        'node',
        'test',
        'scaffold',
        'orchestration',
        'acme/scanner@v1',
        'acme/scanner@v2',
      ])
    ).rejects.toThrow('Conflicting dependency versions provided')
  })

  it('refuses to overwrite existing files without --force', async () => {
    await fs.writeFile(path.join(workspaceDir, 'prompt.md'), 'existing prompt\n')

    await expect(
      program.parseAsync([
        'node',
        'test',
        'scaffold',
        'orchestration',
        'acme/scanner',
      ])
    ).rejects.toThrow('Refusing to overwrite existing files')
  })

  it('overwrites existing files with --force', async () => {
    await fs.writeFile(path.join(workspaceDir, 'prompt.md'), 'old prompt\n')

    await program.parseAsync([
      'node',
      'test',
      'scaffold',
      'orchestration',
      'acme/scanner',
      '--force',
    ])

    const prompt = await fs.readFile(path.join(workspaceDir, 'prompt.md'), 'utf-8')
    expect(prompt).toContain('orchestration agent')
    expect(prompt).toContain('call_scanner')
  })

  it('supports custom output directory and name', async () => {
    const outputDir = path.join(workspaceDir, 'generated')

    await program.parseAsync([
      'node',
      'test',
      'scaffold',
      'orchestration',
      'acme/scanner',
      '--output',
      outputDir,
      '--name',
      'security-orchestrator',
    ])

    const manifest = JSON.parse(await fs.readFile(path.join(outputDir, 'orchagent.json'), 'utf-8'))
    expect(manifest.name).toBe('security-orchestrator')
    expect(await fs.readFile(path.join(outputDir, 'prompt.md'), 'utf-8')).toContain(
      'security-orchestrator'
    )
  })

  it('prints JSON summary with --json', async () => {
    await program.parseAsync([
      'node',
      'test',
      'scaffold',
      'orchestration',
      'acme/scanner',
      '--json',
    ])

    const parsed = JSON.parse(allStdout(stdoutSpy))
    expect(parsed.name).toBe(path.basename(workspaceDir))
    expect(parsed.dependencies).toEqual(['acme/scanner@v9'])
    expect(parsed.files).toEqual(['orchagent.json', 'prompt.md', 'schema.json'])
  })

  it('passes resolved workspace id for dependency lookups', async () => {
    mockResolveWorkspaceIdForOrg.mockResolvedValue('ws_team_123')

    await program.parseAsync([
      'node',
      'test',
      'scaffold',
      'orchestration',
      'team-org/scanner',
    ])

    expect(mockGetAgentWithFallback).toHaveBeenCalledWith(
      expect.anything(),
      'team-org',
      'scanner',
      'latest',
      'ws_team_123'
    )
  })

  it('maps dependency not found errors to a friendly message', async () => {
    mockGetAgentWithFallback.mockRejectedValue(new ApiError('Not found', 404))

    await expect(
      program.parseAsync(['node', 'test', 'scaffold', 'orchestration', 'acme/missing'])
    ).rejects.toThrow('Dependency agent not found: acme/missing@latest')
  })

  it('validates orchestrator name format', async () => {
    await expect(
      program.parseAsync([
        'node',
        'test',
        'scaffold',
        'orchestration',
        'acme/scanner',
        '--name',
        'Bad_Name',
      ])
    ).rejects.toThrow('Agent name must be lowercase')
  })
})
