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

  describe('discord template', () => {
    it('creates correct files when --template discord is used', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-bot', '--template', 'discord'])

      const writtenFiles = mockFs.writeFile.mock.calls.map(([p]) => path.basename(p as string))
      expect(writtenFiles).toContain('orchagent.json')
      expect(writtenFiles).toContain('main.py')
      expect(writtenFiles).toContain('requirements.txt')
      expect(writtenFiles).toContain('.env.example')
      expect(writtenFiles).toContain('README.md')
    })

    it('does not create prompt.md or schema.json', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-bot', '--template', 'discord'])

      const writtenFiles = mockFs.writeFile.mock.calls.map(([p]) => path.basename(p as string))
      expect(writtenFiles).not.toContain('prompt.md')
      expect(writtenFiles).not.toContain('schema.json')
    })

    it('sets type to agent and run_mode to always_on in manifest', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-bot', '--template', 'discord'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      const manifest = JSON.parse(manifestCall![1] as string)
      expect(manifest.type).toBe('agent')
      expect(manifest.run_mode).toBe('always_on')
    })

    it('includes runtime.command in manifest', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-bot', '--template', 'discord'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      const manifest = JSON.parse(manifestCall![1] as string)
      expect(manifest.runtime).toEqual({ command: 'python main.py' })
    })

    it('includes supported_providers and required_secrets in manifest', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-bot', '--template', 'discord'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      const manifest = JSON.parse(manifestCall![1] as string)
      expect(manifest.supported_providers).toEqual(['anthropic'])
      expect(manifest.required_secrets).toEqual(['DISCORD_BOT_TOKEN', 'DISCORD_CHANNEL_IDS'])
    })

    it('includes discord tags in manifest', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-bot', '--template', 'discord'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      const manifest = JSON.parse(manifestCall![1] as string)
      expect(manifest.tags).toEqual(['discord', 'always-on'])
    })

    it('creates main.py with discord.py imports', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-bot', '--template', 'discord'])

      const mainCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('main.py')
      )
      expect(mainCall).toBeDefined()
      const content = mainCall![1] as string
      expect(content).toContain('import discord')
      expect(content).toContain('import anthropic')
      expect(content).toContain('discord.Client')
      expect(content).toContain('on_message')
    })

    it('creates requirements.txt with discord.py and anthropic', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-bot', '--template', 'discord'])

      const reqCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('requirements.txt')
      )
      expect(reqCall).toBeDefined()
      const content = reqCall![1] as string
      expect(content).toContain('discord.py')
      expect(content).toContain('anthropic')
    })

    it('creates .env.example with required env vars', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-bot', '--template', 'discord'])

      const envCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('.env.example')
      )
      expect(envCall).toBeDefined()
      const content = envCall![1] as string
      expect(content).toContain('DISCORD_BOT_TOKEN')
      expect(content).toContain('ANTHROPIC_API_KEY')
      expect(content).toContain('DISCORD_CHANNEL_IDS')
    })

    it('overrides --type when --template discord is set', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-bot', '--type', 'prompt', '--template', 'discord'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      const manifest = JSON.parse(manifestCall![1] as string)
      expect(manifest.type).toBe('agent')
      expect(manifest.run_mode).toBe('always_on')
      expect(manifest.runtime).toEqual({ command: 'python main.py' })
    })

    it('overrides --run-mode when --template discord is set', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-bot', '--run-mode', 'on_demand', '--template', 'discord'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      const manifest = JSON.parse(manifestCall![1] as string)
      expect(manifest.run_mode).toBe('always_on')
    })

    it('throws when combined with --orchestrator', async () => {
      await expect(
        program.parseAsync(['node', 'test', 'init', 'my-bot', '--orchestrator', '--template', 'discord'])
      ).rejects.toThrow('Cannot use --template with --orchestrator')
    })

    it('throws when combined with --type skill', async () => {
      await expect(
        program.parseAsync(['node', 'test', 'init', 'my-bot', '--type', 'skill', '--template', 'discord'])
      ).rejects.toThrow('Cannot use --template with --type skill')
    })

    it('throws for unknown template name', async () => {
      await expect(
        program.parseAsync(['node', 'test', 'init', 'my-bot', '--template', 'unknown'])
      ).rejects.toThrow("Unknown --template 'unknown'")
    })

    it('creates README with Discord setup instructions', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-bot', '--template', 'discord'])

      const readmeCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('README.md')
      )
      expect(readmeCall).toBeDefined()
      const content = readmeCall![1] as string
      expect(content).toContain('Discord')
      expect(content).toContain('Message Content Intent')
      expect(content).toContain('discord.com/developers')
      expect(content).toContain('orch publish')
    })

    it('shows discord-specific next steps', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-bot', '--template', 'discord'])

      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Discord bot'))
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Message Content Intent'))
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('.env.example'))
    })

    it('shows execution as code_runtime (discord)', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-bot', '--template', 'discord'])

      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('code_runtime (discord)'))
    })

    it('shows run mode as always_on', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-bot', '--template', 'discord'])

      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('always_on'))
    })

    it('works without a name argument (current directory)', async () => {
      await program.parseAsync(['node', 'test', 'init', '--template', 'discord'])

      expect(mockFs.mkdir).not.toHaveBeenCalled()

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      expect(manifestCall).toBeDefined()
      expect(manifestCall![0]).toBe(path.join(process.cwd(), 'orchagent.json'))
    })

    it('does not show schema.json in file list', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-bot', '--template', 'discord'])

      const schemaCalls = stdoutSpy.mock.calls.filter(
        ([msg]) => typeof msg === 'string' && msg.includes('schema.json')
      )
      expect(schemaCalls).toHaveLength(0)
    })
  })

  describe('github-weekly-summary template', () => {
    it('creates all 11 files in the correct locations', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-summary', '--template', 'github-weekly-summary'])

      const writtenFiles = mockFs.writeFile.mock.calls.map(([p]) => path.basename(p as string))
      expect(writtenFiles).toContain('orchagent.json')
      expect(writtenFiles).toContain('main.py')
      expect(writtenFiles).toContain('config.py')
      expect(writtenFiles).toContain('github_fetcher.py')
      expect(writtenFiles).toContain('activity_store.py')
      expect(writtenFiles).toContain('analyst.py')
      expect(writtenFiles).toContain('models.py')
      expect(writtenFiles).toContain('requirements.txt')
      expect(writtenFiles).toContain('weekly_summary.md')
      expect(writtenFiles).toContain('.env.example')
      expect(writtenFiles).toContain('README.md')
      expect(mockFs.writeFile.mock.calls).toHaveLength(11)
    })

    it('creates prompts/ subdirectory', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-summary', '--template', 'github-weekly-summary'])

      expect(mockFs.mkdir).toHaveBeenCalledWith(
        path.join(process.cwd(), 'my-summary', 'prompts'),
        { recursive: true }
      )
    })

    it('writes weekly_summary.md into prompts/ subdirectory', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-summary', '--template', 'github-weekly-summary'])

      const promptCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('weekly_summary.md')
      )
      expect(promptCall).toBeDefined()
      expect(promptCall![0]).toBe(
        path.join(process.cwd(), 'my-summary', 'prompts', 'weekly_summary.md')
      )
    })

    it('substitutes {{name}} in orchagent.json', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-summary', '--template', 'github-weekly-summary'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      expect(manifestCall).toBeDefined()
      const manifest = JSON.parse(manifestCall![1] as string)
      expect(manifest.name).toBe('my-summary')
      expect(manifestCall![1]).not.toContain('{{name}}')
    })

    it('substitutes {{name}} in README.md', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-summary', '--template', 'github-weekly-summary'])

      const readmeCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('README.md')
      )
      expect(readmeCall).toBeDefined()
      const content = readmeCall![1] as string
      expect(content).toContain('my-summary')
      expect(content).not.toContain('{{name}}')
    })

    it('has correct manifest structure', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-summary', '--template', 'github-weekly-summary'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      const manifest = JSON.parse(manifestCall![1] as string)
      expect(manifest.type).toBe('agent')
      expect(manifest.version).toBe('v1')
      expect(manifest.runtime).toEqual({ command: 'python main.py' })
      expect(manifest.required_secrets).toEqual([
        'ORCHAGENT_API_KEY',
        'DISCORD_WEBHOOK_URL',
        'ANTHROPIC_API_KEY',
        'GITHUB_REPOS',
      ])
      expect(manifest.bundle).toBeDefined()
      expect(manifest.bundle.include).toContain('*.py')
    })

    it('does not create prompt.md or schema.json', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-summary', '--template', 'github-weekly-summary'])

      const writtenFiles = mockFs.writeFile.mock.calls.map(([p]) => path.basename(p as string))
      expect(writtenFiles).not.toContain('prompt.md')
      expect(writtenFiles).not.toContain('schema.json')
    })

    it('throws when orchagent.json already exists', async () => {
      mockFs.access.mockResolvedValue(undefined)

      await expect(
        program.parseAsync(['node', 'test', 'init', 'my-summary', '--template', 'github-weekly-summary'])
      ).rejects.toThrow('Already initialized')
    })

    it('works without a name argument (current directory)', async () => {
      await program.parseAsync(['node', 'test', 'init', '--template', 'github-weekly-summary'])

      expect(mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )).toBeDefined()

      // Should not create project subdirectory (only prompts/)
      const mkdirCalls = mockFs.mkdir.mock.calls.map(([p]) => p as string)
      expect(mkdirCalls).toHaveLength(1)
      expect(mkdirCalls[0]).toContain('prompts')
    })

    it('creates subdirectory when name is provided', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-summary', '--template', 'github-weekly-summary'])

      // First mkdir: project dir, second: prompts/
      expect(mockFs.mkdir).toHaveBeenCalledWith(
        path.join(process.cwd(), 'my-summary'),
        { recursive: true }
      )
    })

    it('throws when combined with --orchestrator', async () => {
      await expect(
        program.parseAsync(['node', 'test', 'init', 'my-summary', '--orchestrator', '--template', 'github-weekly-summary'])
      ).rejects.toThrow('Cannot use --template with --orchestrator')
    })

    it('throws when combined with --type skill', async () => {
      await expect(
        program.parseAsync(['node', 'test', 'init', 'my-summary', '--type', 'skill', '--template', 'github-weekly-summary'])
      ).rejects.toThrow('Cannot use --template with --type skill')
    })

    it('shows next steps with github connect and schedule', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-summary', '--template', 'github-weekly-summary'])

      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('orch github connect'))
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('orch publish'))
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('orch schedule create'))
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('README.md'))
    })

    it('shows cd instruction when name provided', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-summary', '--template', 'github-weekly-summary'])

      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('cd my-summary'))
    })

    it('substitutes {{name}} in .env.example', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-summary', '--template', 'github-weekly-summary'])

      const envCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('.env.example')
      )
      expect(envCall).toBeDefined()
      const content = envCall![1] as string
      expect(content).toContain('my-summary')
      expect(content).not.toContain('{{name}}')
    })

    it('.env.example lists all required secrets', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-summary', '--template', 'github-weekly-summary'])

      const envCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('.env.example')
      )
      const content = envCall![1] as string
      expect(content).toContain('ORCHAGENT_API_KEY')
      expect(content).toContain('DISCORD_WEBHOOK_URL')
      expect(content).toContain('ANTHROPIC_API_KEY')
      expect(content).toContain('GITHUB_REPOS')
    })

    it('main.py contains the correct agent entrypoint', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-summary', '--template', 'github-weekly-summary'])

      const mainCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('main.py')
      )
      expect(mainCall).toBeDefined()
      const content = mainCall![1] as string
      expect(content).toContain('from config import Config')
      expect(content).toContain('from github_fetcher import GitHubFetcher')
      expect(content).toContain('asyncio.run(run())')
      expect(content).toContain('post_to_discord')
    })
  })

  describe('JS orchestrator (--orchestrator --language javascript)', () => {
    it('creates main.js with AgentClient SDK usage', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-orch', '--orchestrator', '--language', 'javascript'])

      const mainCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('main.js')
      )
      expect(mainCall).toBeDefined()
      const content = mainCall![1] as string
      expect(content).toContain("require('orchagent-sdk')")
      expect(content).toContain('client.call(')
      expect(content).toContain('AgentClient')
    })

    it('creates package.json with orchagent-sdk dependency', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-orch', '--orchestrator', '--language', 'javascript'])

      const pkgCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('package.json')
      )
      expect(pkgCall).toBeDefined()
      const content = pkgCall![1] as string
      expect(content).toContain('orchagent-sdk')
    })

    it('does not create main.py or requirements.txt', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-orch', '--orchestrator', '--language', 'javascript'])

      const mainPyCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('main.py')
      )
      const reqCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('requirements.txt')
      )
      expect(mainPyCall).toBeUndefined()
      expect(reqCall).toBeUndefined()
    })

    it('sets runtime.command to node main.js in manifest', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-orch', '--orchestrator', '--language', 'javascript'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      const manifest = JSON.parse(manifestCall![1] as string)
      expect(manifest.runtime).toEqual({ command: 'node main.js' })
      expect(manifest.entrypoint).toBe('main.js')
    })

    it('includes manifest.dependencies with placeholder', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-orch', '--orchestrator', '--language', 'javascript'])

      const manifestCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('orchagent.json')
      )
      const manifest = JSON.parse(manifestCall![1] as string)
      expect(manifest.manifest).toBeDefined()
      expect(manifest.manifest.dependencies).toEqual([{ id: 'org/agent-name', version: 'v1' }])
      expect(manifest.manifest.max_hops).toBe(3)
    })

    it('creates schema.json with task input field', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-orch', '--orchestrator', '--language', 'javascript'])

      const schemaCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('schema.json')
      )
      expect(schemaCall).toBeDefined()
      const schema = JSON.parse(schemaCall![1] as string)
      expect(schema.input.properties).toHaveProperty('task')
    })

    it('shows main.js in file list output', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-orch', '--orchestrator', '--language', 'javascript'])

      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('main.js'))
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('package.json'))
    })

    it('shows JS-specific next steps', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-orch', '--orchestrator', '--language', 'javascript'])

      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('main.js'))
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('manifest.dependencies'))
    })

    it('accepts --language js alias', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-orch', '--orchestrator', '--language', 'js'])

      const mainCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('main.js')
      )
      expect(mainCall).toBeDefined()
    })

    it('accepts --language typescript alias', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-orch', '--orchestrator', '--language', 'typescript'])

      const mainCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('main.js')
      )
      expect(mainCall).toBeDefined()
    })

    it('Python orchestrator is unchanged (default)', async () => {
      await program.parseAsync(['node', 'test', 'init', 'my-orch', '--orchestrator'])

      const mainPyCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('main.py')
      )
      expect(mainPyCall).toBeDefined()
      const content = mainPyCall![1] as string
      expect(content).toContain('from orchagent import AgentClient')

      const reqCall = mockFs.writeFile.mock.calls.find(
        ([p]) => (p as string).endsWith('requirements.txt')
      )
      expect(reqCall).toBeDefined()
    })
  })

  describe('JS managed_loop blocked', () => {
    it('throws for --type agent --language javascript', async () => {
      await expect(
        program.parseAsync(['node', 'test', 'init', 'my-agent', '--type', 'agent', '--language', 'javascript'])
      ).rejects.toThrow('JavaScript agent-type agents are not yet supported')
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
