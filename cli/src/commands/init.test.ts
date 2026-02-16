/**
 * Tests for the init command.
 *
 * Covers:
 * - Creating agent project in a named subdirectory
 * - Creating agent project in current directory (no name)
 * - Skill type initialization
 * - Already initialized detection
 * - Tool type (code-runtime scaffolding)
 * - Prompt type (direct_llm scaffolding)
 * - Agent/agentic scaffolding behavior (managed_loop)
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

    it('sets canonical type and runtime in manifest', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-tool', '--type', 'tool'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      const manifest = JSON.parse(manifestCall![1] as string)
      expect(manifest.type).toBe('tool')
      expect(manifest.run_mode).toBe('on_demand')
      expect(manifest.runtime).toEqual({ command: 'python main.py' })
    })

    it('includes empty required_secrets in manifest', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-tool', '--type', 'tool'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      const manifest = JSON.parse(manifestCall![1] as string)
      expect(manifest.required_secrets).toEqual([])
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

  describe('prompt type (default)', () => {
    it('sets type to prompt in manifest', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-prompt', '--type', 'prompt'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      expect(manifestCall).toBeDefined()
      const manifest = JSON.parse(manifestCall![1] as string)
      expect(manifest.type).toBe('prompt')
    })

    it('defaults to prompt type when no --type is specified', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-agent'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      const manifest = JSON.parse(manifestCall![1] as string)
      expect(manifest.type).toBe('prompt')
    })

    it('creates prompt.md with simple template', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-prompt', '--type', 'prompt'])

      const promptCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('prompt.md')
      )
      expect(promptCall).toBeDefined()
      const content = promptCall![1] as string
      expect(content).toContain('{{input}}')
    })

    it('does not create main.py', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-prompt', '--type', 'prompt'])

      const mainCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('main.py')
      )
      expect(mainCall).toBeUndefined()
    })

    it('does not include required_secrets for prompt type', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-prompt', '--type', 'prompt'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      const manifest = JSON.parse(manifestCall![1] as string)
      expect(manifest.required_secrets).toBeUndefined()
    })

    it('shows schema.json in next steps', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-prompt', '--type', 'prompt'])

      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('schema.json'))
    })
  })

  describe('agent type (managed_loop)', () => {
    it('sets type to agent in manifest', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-agent', '--type', 'agent'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      expect(manifestCall).toBeDefined()
      const manifest = JSON.parse(manifestCall![1] as string)
      expect(manifest.type).toBe('agent')
    })

    it('includes max_turns in loop for agent type', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-agent', '--type', 'agent'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      const manifest = JSON.parse(manifestCall![1] as string)
      expect(manifest.loop?.max_turns).toBe(25)
    })

    it('includes supported_providers for agent type', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-agent', '--type', 'agent'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      const manifest = JSON.parse(manifestCall![1] as string)
      expect(manifest.supported_providers).toEqual(['anthropic'])
    })

    it('does not include custom_tools in default manifest', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-agent', '--type', 'agent'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      const manifest = JSON.parse(manifestCall![1] as string)
      expect(manifest.custom_tools).toBeUndefined()
    })

    it('includes empty required_secrets in manifest', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-agent', '--type', 'agent'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      const manifest = JSON.parse(manifestCall![1] as string)
      expect(manifest.required_secrets).toEqual([])
    })

    it('legacy agentic alias produces same result as agent type', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-agent', '--type', 'agentic'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      const manifest = JSON.parse(manifestCall![1] as string)
      expect(manifest.type).toBe('agent')
      expect(manifest.loop?.max_turns).toBe(25)
      expect(manifest.supported_providers).toEqual(['anthropic'])
    })

    it('creates prompt.md with agent content', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-agent', '--type', 'agent'])

      const promptCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('prompt.md')
      )
      expect(promptCall).toBeDefined()
      const content = promptCall![1] as string
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

  describe('orchestrator flag', () => {
    it('sets type to agent in manifest', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-orch', '--orchestrator'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      expect(manifestCall).toBeDefined()
      const manifest = JSON.parse(manifestCall![1] as string)
      expect(manifest.type).toBe('agent')
    })

    it('includes runtime.command in manifest', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-orch', '--orchestrator'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      const manifest = JSON.parse(manifestCall![1] as string)
      expect(manifest.runtime).toEqual({ command: 'python main.py' })
    })

    it('includes manifest.dependencies with placeholder', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-orch', '--orchestrator'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      const manifest = JSON.parse(manifestCall![1] as string)
      expect(manifest.manifest).toBeDefined()
      expect(manifest.manifest.manifest_version).toBe(1)
      expect(manifest.manifest.dependencies).toEqual([{ id: 'org/agent-name', version: 'v1' }])
      expect(manifest.manifest.max_hops).toBe(3)
      expect(manifest.manifest.timeout_ms).toBe(120000)
      expect(manifest.manifest.per_call_downstream_cap).toBe(50)
    })

    it('includes empty required_secrets', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-orch', '--orchestrator'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      const manifest = JSON.parse(manifestCall![1] as string)
      expect(manifest.required_secrets).toEqual([])
    })

    it('creates main.py with AgentClient SDK usage', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-orch', '--orchestrator'])

      const mainCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('main.py')
      )
      expect(mainCall).toBeDefined()
      const content = mainCall![1] as string
      expect(content).toContain('from orchagent import AgentClient')
      expect(content).toContain('client.call(')
      expect(content).toContain('asyncio.run(')
    })

    it('creates requirements.txt with orchagent-sdk', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-orch', '--orchestrator'])

      const reqCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('requirements.txt')
      )
      expect(reqCall).toBeDefined()
      const content = reqCall![1] as string
      expect(content).toContain('orchagent-sdk>=0.1.0')
    })

    it('creates schema.json with task input field', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-orch', '--orchestrator'])

      const schemaCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('schema.json')
      )
      expect(schemaCall).toBeDefined()
      const schema = JSON.parse(schemaCall![1] as string)
      expect(schema.input.properties).toHaveProperty('task')
      expect(schema.output.properties).toHaveProperty('success')
    })

    it('does not create prompt.md', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-orch', '--orchestrator'])

      const promptCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('prompt.md')
      )
      expect(promptCall).toBeUndefined()
    })

    it('shows orchestrator-specific next steps', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-orch', '--orchestrator'])

      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('manifest.dependencies'))
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Publish dependency agents first'))
    })

    it('shows requirements.txt in file list', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-orch', '--orchestrator'])

      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('requirements.txt'))
    })

    it('shows execution as code_runtime (orchestrator)', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-orch', '--orchestrator'])

      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('code_runtime (orchestrator)'))
    })

    it('overrides --type when --orchestrator is set', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-orch', '--type', 'prompt', '--orchestrator'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      const manifest = JSON.parse(manifestCall![1] as string)
      expect(manifest.type).toBe('agent')
      expect(manifest.manifest.dependencies).toBeDefined()
    })

    it('throws when combined with --type skill', async () => {
      await expect(
        program.parseAsync(['node', 'test', 'init', 'my-orch', '--type', 'skill', '--orchestrator'])
      ).rejects.toThrow('Cannot use --orchestrator with --type skill')
    })

    it('creates README with dependencies section', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-orch', '--orchestrator'])

      const readmeCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('README.md')
      )
      expect(readmeCall).toBeDefined()
      const content = readmeCall![1] as string
      expect(content).toContain('Dependencies')
      expect(content).toContain('Publish order')
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
