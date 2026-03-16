import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { Command } from 'commander'
import yaml from 'yaml'

import { registerContextCommand } from './context'

function parseFrontmatter(raw: string): { frontmatter: any; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/)
  if (!match) {
    throw new Error('Missing YAML frontmatter')
  }

  return {
    frontmatter: yaml.parse(match[1]),
    body: match[2],
  }
}

describe('context command', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    program = new Command()
    program.name('orch')
    program.version('9.9.9')
    program.exitOverride()

    program.command('run <agent>').description('Run an agent').option('--json', 'Output JSON')
    program
      .command('publish')
      .description('Publish an agent')
      .option('--dry-run', 'Validate before publishing')

    registerContextCommand(program)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('prints YAML frontmatter and markdown guide', async () => {
    await program.parseAsync(['node', 'test', 'context'])

    const raw = stdoutSpy.mock.calls.map((call) => call[0]).join('')
    const { frontmatter, body } = parseFrontmatter(raw)

    expect(frontmatter.name).toBe('orchagent-cli')
    expect(frontmatter.version).toBe('9.9.9')
    expect(frontmatter.commands.some((cmd: any) => cmd.name === 'run')).toBe(true)

    const publish = frontmatter.commands.find((cmd: any) => cmd.name === 'publish')
    expect(publish).toBeDefined()
    expect(publish.mutations).toBe(true)
    expect(publish.dry_run).toBe(true)
    expect(publish.flags).toContain('--dry-run')

    expect(body).toContain('# orchagent CLI - Agent Guide')
    expect(body).toContain('## Top-Level Commands')
    expect(body).toContain('`publish`')
  })
})

