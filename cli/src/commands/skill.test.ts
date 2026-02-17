/**
 * Tests for the skill command.
 *
 * Bug 8: Verify that duplicate frontmatter is stripped during skill install.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
import fs from 'fs/promises'
import os from 'os'

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
vi.mock('../lib/pricing', () => ({
  isPaidAgent: vi.fn().mockReturnValue(false),
  formatPrice: vi.fn().mockReturnValue('FREE'),
}))
vi.mock('../lib/installed', () => ({
  trackInstall: vi.fn().mockResolvedValue(undefined),
  computeHash: vi.fn().mockReturnValue('hash123'),
  untrackInstall: vi.fn().mockResolvedValue(undefined),
}))

import { registerSkillCommand } from './skill'
import { getPublicAgent, publicRequest, reportInstall } from '../lib/api'
import { getResolvedConfig, getDefaultFormats, getDefaultScope, loadConfig } from '../lib/config'

const mockFs = vi.mocked(fs)
const mockGetPublicAgent = vi.mocked(getPublicAgent)
const mockPublicRequest = vi.mocked(publicRequest)
const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockGetDefaultFormats = vi.mocked(getDefaultFormats)
const mockGetDefaultScope = vi.mocked(getDefaultScope)
const mockLoadConfig = vi.mocked(loadConfig)
const mockReportInstall = vi.mocked(reportInstall)

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
