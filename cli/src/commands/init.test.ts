/**
 * Tests for the init command.
 *
 * Covers:
 * - Creating agent project in a named subdirectory
 * - Creating agent project in current directory (no name)
 * - Skill type initialization
 * - Already initialized detection
 * - Tool type (no prompt.md)
 * - Agent type (custom_tools, max_turns, agent-specific templates)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

vi.mock('fs/promises')

import fs from 'fs/promises'
import path from 'path'
import { registerInitCommand } from './init'

const mockFs = vi.mocked(fs)

describe('init command', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()

    program = new Command()
    program.exitOverride()
    registerInitCommand(program)

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    // Default: files don't exist (ENOENT)
    mockFs.access.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    mockFs.mkdir.mockResolvedValue(undefined)
    mockFs.writeFile.mockResolvedValue(undefined)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    vi.restoreAllMocks()
  })

  describe('with name argument (subdirectory creation)', () => {
    it('creates a subdirectory when name is provided', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-agent'])

      expect(mockFs.mkdir).toHaveBeenCalledWith(
        path.join(process.cwd(), 'my-agent'),
        { recursive: true }
      )
    })

    it('writes orchagent.json into the subdirectory', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-agent'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      expect(manifestCall).toBeDefined()
      expect(manifestCall![0]).toBe(path.join(process.cwd(), 'my-agent', 'orchagent.json'))

      const manifest = JSON.parse(manifestCall![1] as string)
      expect(manifest.name).toBe('my-agent')
    })

    it('writes prompt.md into the subdirectory for prompt type', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-agent'])

      const promptCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('prompt.md')
      )
      expect(promptCall).toBeDefined()
      expect(promptCall![0]).toBe(path.join(process.cwd(), 'my-agent', 'prompt.md'))
    })

    it('writes schema.json into the subdirectory', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-agent'])

      const schemaCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('schema.json')
      )
      expect(schemaCall).toBeDefined()
      expect(schemaCall![0]).toBe(path.join(process.cwd(), 'my-agent', 'schema.json'))
    })

    it('shows cd instruction in next steps', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-agent'])

      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('cd my-agent'))
    })

    it('shows file paths with subdirectory prefix', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-agent'])

      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('my-agent/orchagent.json'))
    })
  })

  describe('without name argument (current directory)', () => {
    it('does not create a subdirectory', async () => {
      await program.parseAsync(['node', 'test', 'init'])

      expect(mockFs.mkdir).not.toHaveBeenCalled()
    })

    it('writes files to cwd', async () => {
      await program.parseAsync(['node', 'test', 'init'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      expect(manifestCall).toBeDefined()
      expect(manifestCall![0]).toBe(path.join(process.cwd(), 'orchagent.json'))
    })

    it('does not show cd instruction in next steps', async () => {
      await program.parseAsync(['node', 'test', 'init'])

      const cdCalls = stdoutSpy.mock.calls.filter(
        ([msg]) => typeof msg === 'string' && msg.includes('cd ')
      )
      expect(cdCalls).toHaveLength(0)
    })
  })

  describe('already initialized detection', () => {
    it('throws when orchagent.json exists in subdirectory', async () => {
      mockFs.access.mockResolvedValue(undefined) // file exists

      await expect(
        program.parseAsync(['node', 'test', 'init', 'my-agent'])
      ).rejects.toThrow('Already initialized')
    })

    it('throws when orchagent.json exists in cwd', async () => {
      mockFs.access.mockResolvedValue(undefined)

      await expect(
        program.parseAsync(['node', 'test', 'init'])
      ).rejects.toThrow('Already initialized')
    })
  })

  describe('tool type', () => {
    it('does not create prompt.md for tool type', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-tool', '--type', 'tool'])

      const promptCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('prompt.md')
      )
      expect(promptCall).toBeUndefined()
    })

    it('still creates orchagent.json and schema.json for tool type', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-tool', '--type', 'tool'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      const schemaCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('schema.json')
      )
      expect(manifestCall).toBeDefined()
      expect(schemaCall).toBeDefined()
    })

    it('sets type to tool in manifest', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-tool', '--type', 'tool'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      const manifest = JSON.parse(manifestCall![1] as string)
      expect(manifest.type).toBe('tool')
    })
  })

  describe('skill type', () => {
    it('creates SKILL.md in subdirectory when name provided', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-skill', '--type', 'skill'])

      expect(mockFs.mkdir).toHaveBeenCalledWith(
        path.join(process.cwd(), 'my-skill'),
        { recursive: true }
      )

      const skillCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('SKILL.md')
      )
      expect(skillCall).toBeDefined()
      expect(skillCall![0]).toBe(path.join(process.cwd(), 'my-skill', 'SKILL.md'))
      expect(skillCall![1]).toContain('name: my-skill')
    })

    it('creates SKILL.md in cwd when no name provided', async () => {
      await program.parseAsync(['node', 'test', 'init', '--type', 'skill'])

      expect(mockFs.mkdir).not.toHaveBeenCalled()

      const skillCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('SKILL.md')
      )
      expect(skillCall).toBeDefined()
      expect(skillCall![0]).toBe(path.join(process.cwd(), 'SKILL.md'))
    })

    it('throws when SKILL.md already exists in subdirectory', async () => {
      mockFs.access.mockResolvedValue(undefined) // file exists

      await expect(
        program.parseAsync(['node', 'test', 'init', 'my-skill', '--type', 'skill'])
      ).rejects.toThrow('Already initialized')
    })

    it('shows cd instruction for skill with name', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-skill', '--type', 'skill'])

      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('cd my-skill'))
    })
  })

  describe('agent type', () => {
    it('sets type to agent in manifest', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-agent', '--type', 'agent'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      expect(manifestCall).toBeDefined()
      const manifest = JSON.parse(manifestCall![1] as string)
      expect(manifest.type).toBe('agent')
    })

    it('does not include custom_tools in default manifest', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-agent', '--type', 'agent'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      const manifest = JSON.parse(manifestCall![1] as string)
      expect(manifest.custom_tools).toBeUndefined()
    })

    it('includes max_turns in manifest', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-agent', '--type', 'agent'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      const manifest = JSON.parse(manifestCall![1] as string)
      expect(manifest.max_turns).toBe(25)
    })

    it('includes supported_providers in manifest', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-agent', '--type', 'agent'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      const manifest = JSON.parse(manifestCall![1] as string)
      expect(manifest.supported_providers).toEqual(['anthropic'])
    })

    it('creates prompt.md with agent-specific content', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-agent', '--type', 'agent'])

      const promptCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('prompt.md')
      )
      expect(promptCall).toBeDefined()
      const content = promptCall![1] as string
      // Agent prompt should focus on domain expertise (platform context is auto-injected at runtime)
      expect(content).toContain('agent')
      expect(content).not.toContain('{{input}}')
    })

    it('creates schema.json with task input field', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-agent', '--type', 'agent'])

      const schemaCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('schema.json')
      )
      expect(schemaCall).toBeDefined()
      const schema = JSON.parse(schemaCall![1] as string)
      expect(schema.input.properties).toHaveProperty('task')
      expect(schema.output.properties).toHaveProperty('success')
    })

    it('does not create main.py', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-agent', '--type', 'agent'])

      const mainCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('main.py')
      )
      expect(mainCall).toBeUndefined()
    })

    it('shows schema.json in next steps', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-agent', '--type', 'agent'])

      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('schema.json'))
    })
  })

  describe('multiple inits in same parent directory', () => {
    it('can create two different agent subdirectories', async () => {
      // First init
      await program.parseAsync(['node', 'test', 'init', 'agent-a'])

      vi.clearAllMocks()
      mockFs.access.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      mockFs.mkdir.mockResolvedValue(undefined)
      mockFs.writeFile.mockResolvedValue(undefined)
      stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

      // Second init with different name - should work fine
      const program2 = new Command()
      program2.exitOverride()
      registerInitCommand(program2)
      await program2.parseAsync(['node', 'test', 'init', 'agent-b'])

      expect(mockFs.mkdir).toHaveBeenCalledWith(
        path.join(process.cwd(), 'agent-b'),
        { recursive: true }
      )
    })
  })
})
