/**
 * Tests for the skill command.
 *
 * Bug 8: Verify that duplicate frontmatter is stripped during skill install.
 * U-2: Verify that skill create prompts for confirmation before writing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
import fs from 'fs/promises'
import os from 'os'

const mockQuestion = vi.fn()
const mockClose = vi.fn()
vi.mock('readline/promises', () => ({
  default: {
    createInterface: vi.fn(() => ({
      question: mockQuestion,
      close: mockClose,
    })),
  },
  createInterface: vi.fn(() => ({
    question: mockQuestion,
    close: mockClose,
  })),
}))

vi.mock('fs/promises')
vi.mock('../lib/config', () => {
  const FORMAT_SKILL_DIRS = {
    'claude-code': { name: 'Claude Code', projectPath: '.claude/skills', userPath: '.claude/skills' },
    cursor: { name: 'Cursor', projectPath: '.cursor/skills', userPath: '.cursor/skills' },
    amp: { name: 'Amp', projectPath: '.agents/skills', userPath: '.agents/skills' },
    opencode: { name: 'OpenCode', projectPath: '.opencode/skill', userPath: '.opencode/skill' },
    antigravity: { name: 'Antigravity', projectPath: '.agent/skills', userPath: '.agent/skills' },
  }
  return {
    getResolvedConfig: vi.fn().mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'test-org',
    }),
    getDefaultFormats: vi.fn().mockResolvedValue(['claude-code']),
    getDefaultScope: vi.fn().mockResolvedValue('project'),
    setDefaultFormats: vi.fn(),
    loadConfig: vi.fn().mockResolvedValue({}),
    FORMAT_SKILL_DIRS,
    VALID_FORMAT_IDS: Object.keys(FORMAT_SKILL_DIRS),
  }
})
vi.mock('../lib/api', () => {
  const ApiError = class extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.status = status
    }
  }
  return {
    getPublicAgent: vi.fn(),
    publicRequest: vi.fn(),
    ApiError,
    getOrg: vi.fn(),
    listMyAgents: vi.fn(),
    reportInstall: vi.fn().mockReturnValue(Promise.resolve()),
    request: vi.fn(),
    resolveWorkspaceIdForOrg: vi.fn().mockResolvedValue(undefined),
  }
})
vi.mock('../lib/analytics', () => ({
  track: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../lib/installed', () => ({
  trackInstall: vi.fn().mockResolvedValue(undefined),
  computeHash: vi.fn().mockReturnValue('hash123'),
  untrackInstall: vi.fn().mockResolvedValue(undefined),
  getInstalled: vi.fn().mockResolvedValue([]),
}))

import { registerSkillCommand } from './skill'
import { getPublicAgent, publicRequest, reportInstall, listMyAgents } from '../lib/api'
import { getResolvedConfig, getDefaultFormats, getDefaultScope, loadConfig } from '../lib/config'
import { getInstalled } from '../lib/installed'
import type { Agent } from '../types'
import type { InstalledAgent } from '../lib/installed'

const mockFs = vi.mocked(fs)
const mockGetPublicAgent = vi.mocked(getPublicAgent)
const mockPublicRequest = vi.mocked(publicRequest)
const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockGetDefaultFormats = vi.mocked(getDefaultFormats)
const mockGetDefaultScope = vi.mocked(getDefaultScope)
const mockLoadConfig = vi.mocked(loadConfig)
const mockReportInstall = vi.mocked(reportInstall)
const mockListMyAgents = vi.mocked(listMyAgents)
const mockGetInstalled = vi.mocked(getInstalled)

describe('Bug 8: Skill install - duplicate frontmatter stripping', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerSkillCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockFs.mkdir.mockResolvedValue(undefined)
    mockFs.writeFile.mockResolvedValue(undefined)
    // Re-set mocks cleared by vi.clearAllMocks()
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'test-org',
    })
    mockGetDefaultFormats.mockResolvedValue(['claude-code'] as any)
    mockGetDefaultScope.mockResolvedValue('project' as any)
    mockLoadConfig.mockResolvedValue({})
    mockReportInstall.mockReturnValue(Promise.resolve() as any)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('strips frontmatter from skill prompt before wrapping', async () => {
    mockGetPublicAgent.mockResolvedValue({
      id: 'skill-123',
      org_name: 'Test Org',
      org_slug: 'test-org',
      name: 'my-skill',
      version: 'v1',
      type: 'skill',
      supported_providers: ['any'],
      is_public: true,
    } as any)

    // Skill download returns prompt WITH frontmatter
    mockPublicRequest.mockResolvedValue({
      type: 'skill',
      name: 'my-skill',
      version: 'v1',
      description: 'A test skill',
      prompt: '---\nname: my-skill\ndescription: A test skill\n---\n\n# Instructions\n\nDo something useful.',
    })

    await program.parseAsync([
      'node', 'test', 'skill', 'install', 'test-org/my-skill',
    ])

    // Check what was written to the file
    const writeCall = mockFs.writeFile.mock.calls.find(
      call => call[0].toString().endsWith('my-skill.md')
    )
    expect(writeCall).toBeTruthy()
    const content = writeCall![1] as string

    // Should have exactly ONE frontmatter-like section (the header + ---), not two
    const dashes = content.match(/^---$/gm)
    expect(dashes).toHaveLength(1) // Only the separator between description and content

    // Should contain the skill content without the original frontmatter
    expect(content).toContain('# my-skill')
    expect(content).toContain('# Instructions')
    expect(content).toContain('Do something useful.')

    // Should NOT contain the YAML frontmatter content inline
    expect(content).not.toContain('name: my-skill')
  })

  it('handles skill prompt without frontmatter (no stripping needed)', async () => {
    mockGetPublicAgent.mockResolvedValue({
      id: 'skill-123',
      org_name: 'Test Org',
      org_slug: 'test-org',
      name: 'clean-skill',
      version: 'v1',
      type: 'skill',
      supported_providers: ['any'],
      is_public: true,
    } as any)

    mockPublicRequest.mockResolvedValue({
      type: 'skill',
      name: 'clean-skill',
      version: 'v1',
      description: 'A clean skill',
      prompt: '# Instructions\n\nDo something useful.',
    })

    await program.parseAsync([
      'node', 'test', 'skill', 'install', 'test-org/clean-skill',
    ])

    const writeCall = mockFs.writeFile.mock.calls.find(
      call => call[0].toString().endsWith('clean-skill.md')
    )
    expect(writeCall).toBeTruthy()
    const content = writeCall![1] as string

    // Content should be preserved as-is
    expect(content).toContain('# Instructions')
    expect(content).toContain('Do something useful.')
  })
})

describe('BUG-C: orch skill list', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  function allStdout(): string {
    return stdoutSpy.mock.calls.map(c => c[0]).join('')
  }

  function makeSkillAgent(overrides: Partial<Agent> & { name: string; version: string }): Agent {
    return {
      id: `id-${overrides.name}-${overrides.version}`,
      type: 'skill',
      created_at: '2026-02-01T00:00:00Z',
      ...overrides,
    } as Agent
  }

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerSkillCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: 'sk_test_123',
      apiUrl: 'https://api.test.com',
      defaultOrg: 'test-org',
    })
    mockLoadConfig.mockResolvedValue({})
    mockListMyAgents.mockResolvedValue([])
    mockGetInstalled.mockResolvedValue([])
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('lists published skills from API', async () => {
    mockListMyAgents.mockResolvedValue([
      makeSkillAgent({ name: 'scan-rules', version: 'v1', description: 'Security scanning rules' }),
      makeSkillAgent({ name: 'code-style', version: 'v2', description: 'Code style guidelines' }),
      // Non-skill agent should be filtered out
      { id: 'agent-1', name: 'my-agent', version: 'v1', type: 'agent', created_at: '2026-02-01T00:00:00Z' } as Agent,
    ])

    await program.parseAsync(['node', 'test', 'skill', 'list'])

    const output = allStdout()
    expect(output).toContain('scan-rules')
    expect(output).toContain('code-style')
    expect(output).not.toContain('my-agent')
  })

  it('shows locally installed skills', async () => {
    const installed: InstalledAgent[] = [
      {
        agent: 'joe/scan-rules',
        version: 'v1',
        format: 'claude-code',
        scope: 'project',
        path: '/project/.claude/skills/scan-rules.md',
        installedAt: '2026-02-20T10:00:00Z',
        adapterVersion: '0.3.90',
        contentHash: 'abc123',
      },
    ]
    mockGetInstalled.mockResolvedValue(installed)

    await program.parseAsync(['node', 'test', 'skill', 'list'])

    const output = allStdout()
    expect(output).toContain('scan-rules')
    expect(output).toContain('Installed')
  })

  it('shows empty state with helpful message when no skills exist', async () => {
    await program.parseAsync(['node', 'test', 'skill', 'list'])

    const output = allStdout()
    expect(output).toContain('No skills')
    expect(output).toContain('orch skill install')
  })

  it('supports --json flag with published skills', async () => {
    mockListMyAgents.mockResolvedValue([
      makeSkillAgent({ name: 'scan-rules', version: 'v1', description: 'Security rules' }),
    ])

    await program.parseAsync(['node', 'test', 'skill', 'list', '--json'])

    const output = allStdout()
    const parsed = JSON.parse(output)
    expect(parsed.published).toHaveLength(1)
    expect(parsed.published[0].name).toBe('scan-rules')
  })

  it('supports --json flag with installed skills', async () => {
    const installed: InstalledAgent[] = [
      {
        agent: 'joe/scan-rules',
        version: 'v1',
        format: 'claude-code',
        scope: 'project',
        path: '/project/.claude/skills/scan-rules.md',
        installedAt: '2026-02-20T10:00:00Z',
        adapterVersion: '0.3.90',
        contentHash: 'abc123',
      },
    ]
    mockGetInstalled.mockResolvedValue(installed)

    await program.parseAsync(['node', 'test', 'skill', 'list', '--json'])

    const output = allStdout()
    const parsed = JSON.parse(output)
    expect(parsed.installed).toHaveLength(1)
    expect(parsed.installed[0].agent).toBe('joe/scan-rules')
  })

  it('does not crash when not authenticated (no apiKey)', async () => {
    mockGetResolvedConfig.mockResolvedValue({
      apiKey: '',
      apiUrl: 'https://api.test.com',
      defaultOrg: '',
    })
    const installed: InstalledAgent[] = [
      {
        agent: 'joe/scan-rules',
        version: 'v1',
        format: 'claude-code',
        scope: 'user',
        path: '/home/.claude/skills/scan-rules.md',
        installedAt: '2026-02-20T10:00:00Z',
        adapterVersion: '0.3.90',
        contentHash: 'abc123',
      },
    ]
    mockGetInstalled.mockResolvedValue(installed)

    await program.parseAsync(['node', 'test', 'skill', 'list'])

    const output = allStdout()
    // Should still show installed skills without API call
    expect(output).toContain('scan-rules')
    expect(mockListMyAgents).not.toHaveBeenCalled()
  })

  it('deduplicates to latest version per skill name', async () => {
    mockListMyAgents.mockResolvedValue([
      makeSkillAgent({ name: 'scan-rules', version: 'v1', created_at: '2026-01-01T00:00:00Z' }),
      makeSkillAgent({ name: 'scan-rules', version: 'v2', created_at: '2026-02-01T00:00:00Z' }),
      makeSkillAgent({ name: 'scan-rules', version: 'v3', created_at: '2026-03-01T00:00:00Z' }),
    ])

    await program.parseAsync(['node', 'test', 'skill', 'list'])

    const output = allStdout()
    expect(output).toContain('v3')
    // Should show version count
    expect(output).toContain('3 total')
  })

  it('does not reference /explore page', async () => {
    await program.parseAsync(['node', 'test', 'skill', 'list'])

    const output = allStdout()
    expect(output).not.toContain('/explore')
    expect(output).not.toContain('discover')
  })
})

describe('U-2: orch skill create confirmation prompt', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let originalIsTTY: boolean | undefined

  function allStdout(): string {
    return stdoutSpy.mock.calls.map(c => c[0]).join('')
  }

  beforeEach(() => {
    vi.clearAllMocks()
    program = new Command()
    program.exitOverride()
    registerSkillCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    mockFs.writeFile.mockResolvedValue(undefined)
    // SKILL.md does not exist by default
    mockFs.access.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    originalIsTTY = process.stdout.isTTY
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, writable: true })
    vi.restoreAllMocks()
  })

  it('prompts for confirmation in TTY mode and creates file on "y"', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true })
    mockQuestion.mockResolvedValue('y')

    await program.parseAsync(['node', 'test', 'skill', 'create', 'my-skill'])

    expect(mockQuestion).toHaveBeenCalledTimes(1)
    expect(mockQuestion.mock.calls[0][0]).toContain('SKILL.md')
    expect(mockClose).toHaveBeenCalled()
    expect(mockFs.writeFile).toHaveBeenCalled()
    expect(allStdout()).toContain('Created skill')
  })

  it('prompts for confirmation in TTY mode and aborts on "n"', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true })
    mockQuestion.mockResolvedValue('n')

    await program.parseAsync(['node', 'test', 'skill', 'create', 'my-skill'])

    expect(mockQuestion).toHaveBeenCalledTimes(1)
    expect(mockClose).toHaveBeenCalled()
    expect(mockFs.writeFile).not.toHaveBeenCalled()
    expect(allStdout()).toContain('Aborted')
  })

  it('aborts on empty input (default is No)', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true })
    mockQuestion.mockResolvedValue('')

    await program.parseAsync(['node', 'test', 'skill', 'create', 'my-skill'])

    expect(mockFs.writeFile).not.toHaveBeenCalled()
    expect(allStdout()).toContain('Aborted')
  })

  it('accepts "yes" (full word) as confirmation', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true })
    mockQuestion.mockResolvedValue('yes')

    await program.parseAsync(['node', 'test', 'skill', 'create', 'my-skill'])

    expect(mockFs.writeFile).toHaveBeenCalled()
    expect(allStdout()).toContain('Created skill')
  })

  it('--yes flag skips confirmation in TTY mode', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true })

    await program.parseAsync(['node', 'test', 'skill', 'create', 'my-skill', '--yes'])

    expect(mockQuestion).not.toHaveBeenCalled()
    expect(mockFs.writeFile).toHaveBeenCalled()
    expect(allStdout()).toContain('Created skill')
  })

  it('-y shorthand skips confirmation', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true })

    await program.parseAsync(['node', 'test', 'skill', 'create', 'my-skill', '-y'])

    expect(mockQuestion).not.toHaveBeenCalled()
    expect(mockFs.writeFile).toHaveBeenCalled()
  })

  it('skips confirmation in non-TTY mode (scripts/CI)', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, writable: true })

    await program.parseAsync(['node', 'test', 'skill', 'create', 'my-skill'])

    expect(mockQuestion).not.toHaveBeenCalled()
    expect(mockFs.writeFile).toHaveBeenCalled()
    expect(allStdout()).toContain('Created skill')
  })

  it('still errors if SKILL.md already exists (before confirmation)', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true })
    mockFs.access.mockResolvedValue(undefined) // file exists

    await expect(
      program.parseAsync(['node', 'test', 'skill', 'create', 'my-skill'])
    ).rejects.toThrow()

    // Should not prompt — error happens before confirmation
    expect(mockQuestion).not.toHaveBeenCalled()
    expect(mockFs.writeFile).not.toHaveBeenCalled()
  })

  it('uses directory name when no name argument provided', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true })
    mockQuestion.mockResolvedValue('y')

    await program.parseAsync(['node', 'test', 'skill', 'create'])

    expect(mockFs.writeFile).toHaveBeenCalled()
    // The template should contain the cwd basename as the skill name
    const writeCall = mockFs.writeFile.mock.calls[0]
    const content = writeCall[1] as string
    expect(content).toContain('name:')
  })
})
