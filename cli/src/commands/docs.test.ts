/**
 * Tests for docs command topic routing.
 * Covers T12-13: `orch docs orchestration` topic missing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

vi.mock('open', () => ({ default: vi.fn() }))

import { registerDocsCommand } from './docs'
import open from 'open'

const mockOpen = vi.mocked(open)

describe('docs command — topic routing', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    mockOpen.mockResolvedValue({} as any)

    program = new Command()
    program.exitOverride()
    registerDocsCommand(program)

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
  })

  it('opens homepage with no topic', async () => {
    await program.parseAsync(['node', 'test', 'docs'])

    expect(mockOpen).toHaveBeenCalledWith('https://docs.orchagent.io/')
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('opens CLI docs for "cli" topic', async () => {
    await program.parseAsync(['node', 'test', 'docs', 'cli'])

    expect(mockOpen).toHaveBeenCalledWith('https://docs.orchagent.io/using-agents/cli-commands')
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('opens agents docs for "agents" topic', async () => {
    await program.parseAsync(['node', 'test', 'docs', 'agents'])

    expect(mockOpen).toHaveBeenCalledWith('https://docs.orchagent.io/building-agents/agent-types')
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('opens orchestration docs for "orchestration" topic (T12-13)', async () => {
    await program.parseAsync(['node', 'test', 'docs', 'orchestration'])

    expect(mockOpen).toHaveBeenCalledWith('https://docs.orchagent.io/building-agents/orchestration')
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('opens SDK docs for "sdk" topic', async () => {
    await program.parseAsync(['node', 'test', 'docs', 'sdk'])

    expect(mockOpen).toHaveBeenCalledWith('https://docs.orchagent.io/building-agents/sdk')
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('opens API docs for "api" topic', async () => {
    await program.parseAsync(['node', 'test', 'docs', 'api'])

    expect(mockOpen).toHaveBeenCalledWith('https://docs.orchagent.io/api-reference/overview')
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('opens quickstart for "quickstart" topic', async () => {
    await program.parseAsync(['node', 'test', 'docs', 'quickstart'])

    expect(mockOpen).toHaveBeenCalledWith('https://docs.orchagent.io/quickstart')
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('opens scheduling docs for "scheduling" topic', async () => {
    await program.parseAsync(['node', 'test', 'docs', 'scheduling'])

    expect(mockOpen).toHaveBeenCalledWith('https://docs.orchagent.io/using-agents/scheduling')
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('opens services docs for "services" topic', async () => {
    await program.parseAsync(['node', 'test', 'docs', 'services'])

    expect(mockOpen).toHaveBeenCalledWith('https://docs.orchagent.io/using-agents/services')
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('opens security docs for "security" topic', async () => {
    await program.parseAsync(['node', 'test', 'docs', 'security'])

    expect(mockOpen).toHaveBeenCalledWith('https://docs.orchagent.io/concepts/security')
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('opens billing docs for "billing" topic', async () => {
    await program.parseAsync(['node', 'test', 'docs', 'billing'])

    expect(mockOpen).toHaveBeenCalledWith('https://docs.orchagent.io/concepts/billing')
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('warns on unknown topic and falls back to homepage', async () => {
    await program.parseAsync(['node', 'test', 'docs', 'nonexistent'])

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown topic'))
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('nonexistent'))
    expect(mockOpen).toHaveBeenCalledWith('https://docs.orchagent.io/')
  })

  it('lists all valid topics in error message for unknown topic', async () => {
    await program.parseAsync(['node', 'test', 'docs', 'badtopic'])

    const errorOutput = stderrSpy.mock.calls.map(c => c[0]).join('')
    expect(errorOutput).toContain('orchestration')
    expect(errorOutput).toContain('cli')
    expect(errorOutput).toContain('agents')
    expect(errorOutput).toContain('sdk')
  })
})
