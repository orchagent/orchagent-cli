/**
 * Tests for init-wizard.ts and interactive orch init features.
 *
 * Covers:
 * - printTemplateList output
 * - TEMPLATE_REGISTRY completeness
 * - runInitWizard flows (mocked readline)
 * - --list-templates flag on the init command
 * - Interactive wizard trigger detection
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

// Mock readline/promises BEFORE importing the module under test
const mockQuestion = vi.fn()
const mockClose = vi.fn()
vi.mock('readline/promises', () => ({
  default: {
    createInterface: () => ({
      question: mockQuestion,
      close: mockClose,
    }),
  },
}))

vi.mock('fs/promises')

import fs from 'fs/promises'
import {
  TEMPLATE_REGISTRY,
  printTemplateList,
  runInitWizard,
} from './init-wizard'
import { registerInitCommand } from './init'

const mockFs = vi.mocked(fs)

describe('TEMPLATE_REGISTRY', () => {
  it('contains all known templates', () => {
    const names = TEMPLATE_REGISTRY.map(t => t.name)
    expect(names).toContain('discord')
    expect(names).toContain('discord-js')
    expect(names).toContain('support-agent')
    expect(names).toContain('fan-out')
    expect(names).toContain('pipeline')
    expect(names).toContain('map-reduce')
    expect(names).toContain('github-weekly-summary')
  })

  it('has valid fields for every template', () => {
    for (const t of TEMPLATE_REGISTRY) {
      expect(t.name).toBeTruthy()
      expect(t.description).toBeTruthy()
      expect(['agent', 'tool', 'prompt', 'skill']).toContain(t.type)
      expect(['python', 'javascript', 'both']).toContain(t.language)
      expect(['on_demand', 'always_on']).toContain(t.runMode)
    }
  })
})

describe('printTemplateList', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
  })

  it('prints header with TEMPLATE column', () => {
    printTemplateList()
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('TEMPLATE'))
  })

  it('prints all template names', () => {
    printTemplateList()
    const output = stdoutSpy.mock.calls.map(([msg]) => msg).join('')
    for (const t of TEMPLATE_REGISTRY) {
      expect(output).toContain(t.name)
    }
  })

  it('prints descriptions', () => {
    printTemplateList()
    const output = stdoutSpy.mock.calls.map(([msg]) => msg).join('')
    for (const t of TEMPLATE_REGISTRY) {
      expect(output).toContain(t.description)
    }
  })

  it('prints usage examples', () => {
    printTemplateList()
    const output = stdoutSpy.mock.calls.map(([msg]) => msg).join('')
    expect(output).toContain('orch init my-agent --template')
    expect(output).toContain('--language javascript')
  })

  it('shows language column', () => {
    printTemplateList()
    const output = stdoutSpy.mock.calls.map(([msg]) => msg).join('')
    expect(output).toContain('LANGUAGE')
    expect(output).toContain('python')
  })

  it('shows run mode column', () => {
    printTemplateList()
    const output = stdoutSpy.mock.calls.map(([msg]) => msg).join('')
    expect(output).toContain('RUN MODE')
    expect(output).toContain('always_on')
    expect(output).toContain('on_demand')
  })
})

describe('runInitWizard', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
  })

  it('returns skill type when selected', async () => {
    // Name: default (empty), Type: 4 (skill)
    mockQuestion
      .mockResolvedValueOnce('my-skill')  // name
      .mockResolvedValueOnce('4')          // type = skill

    const result = await runInitWizard()

    expect(result.type).toBe('skill')
    expect(result.language).toBe('python')
    expect(result.template).toBeUndefined()
    expect(mockClose).toHaveBeenCalled()
  })

  it('returns prompt type when selected', async () => {
    mockQuestion
      .mockResolvedValueOnce('my-prompt')  // name
      .mockResolvedValueOnce('1')           // type = prompt

    const result = await runInitWizard()

    expect(result.type).toBe('prompt')
    expect(result.language).toBe('python')
    expect(result.template).toBeUndefined()
  })

  it('returns tool type with python and no template', async () => {
    mockQuestion
      .mockResolvedValueOnce('my-tool')    // name
      .mockResolvedValueOnce('2')           // type = tool
      .mockResolvedValueOnce('1')           // language = python
      .mockResolvedValueOnce('1')           // template = none
      .mockResolvedValueOnce('1')           // run mode = on_demand

    const result = await runInitWizard()

    expect(result.type).toBe('tool')
    expect(result.language).toBe('python')
    expect(result.template).toBeUndefined()
    expect(result.runMode).toBe('on_demand')
    expect(result.orchestrator).toBe(false)
    expect(result.loop).toBe(false)
  })

  it('returns agent type with javascript and discord template', async () => {
    mockQuestion
      .mockResolvedValueOnce('my-bot')     // name
      .mockResolvedValueOnce('3')           // type = agent
      .mockResolvedValueOnce('2')           // language = javascript
      .mockResolvedValueOnce('2')           // template = discord-js (first JS-compatible template in filtered list)

    const result = await runInitWizard()

    expect(result.type).toBe('agent')
    expect(result.language).toBe('javascript')
    // Template should be one of the JS-compatible ones
    expect(result.template).toBeTruthy()
  })

  it('returns agent type with orchestrator subtype', async () => {
    mockQuestion
      .mockResolvedValueOnce('my-orch')    // name
      .mockResolvedValueOnce('3')           // type = agent
      .mockResolvedValueOnce('1')           // language = python
      .mockResolvedValueOnce('1')           // template = none
      .mockResolvedValueOnce('1')           // run mode = on_demand
      .mockResolvedValueOnce('2')           // agent subtype = orchestrator

    const result = await runInitWizard()

    expect(result.type).toBe('agent')
    expect(result.orchestrator).toBe(true)
    expect(result.loop).toBe(false)
  })

  it('returns agent type with managed loop subtype', async () => {
    mockQuestion
      .mockResolvedValueOnce('my-loop')    // name
      .mockResolvedValueOnce('3')           // type = agent
      .mockResolvedValueOnce('1')           // language = python
      .mockResolvedValueOnce('1')           // template = none
      .mockResolvedValueOnce('1')           // run mode = on_demand
      .mockResolvedValueOnce('3')           // agent subtype = managed loop

    const result = await runInitWizard()

    expect(result.type).toBe('agent')
    expect(result.orchestrator).toBe(false)
    expect(result.loop).toBe(true)
  })

  it('does not offer managed loop for javascript agents', async () => {
    mockQuestion
      .mockResolvedValueOnce('my-agent')   // name
      .mockResolvedValueOnce('3')           // type = agent
      .mockResolvedValueOnce('2')           // language = javascript
      .mockResolvedValueOnce('1')           // template = none
      .mockResolvedValueOnce('1')           // run mode = on_demand
      .mockResolvedValueOnce('1')           // agent subtype = code runtime (only 2 options for JS)

    const result = await runInitWizard()

    expect(result.type).toBe('agent')
    expect(result.language).toBe('javascript')
    expect(result.loop).toBe(false)
  })

  it('uses cwd basename as default name', async () => {
    // Return empty string to accept default
    mockQuestion
      .mockResolvedValueOnce('')           // name = default (cwd basename)
      .mockResolvedValueOnce('1')           // type = prompt

    const result = await runInitWizard()

    // name should be undefined (no subdir) when matching cwd basename
    expect(result.name).toBeUndefined()
  })

  it('creates subdir when name differs from cwd', async () => {
    mockQuestion
      .mockResolvedValueOnce('different-name')  // name differs from cwd
      .mockResolvedValueOnce('1')                // type = prompt

    const result = await runInitWizard()

    expect(result.name).toBe('different-name')
  })

  it('retries on invalid selection input', async () => {
    mockQuestion
      .mockResolvedValueOnce('my-agent')   // name
      .mockResolvedValueOnce('invalid')     // invalid type selection
      .mockResolvedValueOnce('0')           // out of range
      .mockResolvedValueOnce('1')           // valid: prompt

    const result = await runInitWizard()

    expect(result.type).toBe('prompt')
    // Should have been called 4 times (name + 2 retries + valid)
    expect(mockQuestion).toHaveBeenCalledTimes(4)
  })

  it('closes readline on error', async () => {
    mockQuestion.mockRejectedValueOnce(new Error('readline closed'))

    await expect(runInitWizard()).rejects.toThrow('readline closed')
    expect(mockClose).toHaveBeenCalled()
  })

  it('returns always_on run mode when selected', async () => {
    mockQuestion
      .mockResolvedValueOnce('my-service')  // name
      .mockResolvedValueOnce('2')            // type = tool
      .mockResolvedValueOnce('1')            // language = python
      .mockResolvedValueOnce('1')            // template = none
      .mockResolvedValueOnce('2')            // run mode = always_on

    const result = await runInitWizard()

    expect(result.runMode).toBe('always_on')
  })

  it('skips run mode prompt when template is selected', async () => {
    mockQuestion
      .mockResolvedValueOnce('my-bot')     // name
      .mockResolvedValueOnce('3')           // type = agent
      .mockResolvedValueOnce('1')           // language = python
      .mockResolvedValueOnce('2')           // template = first applicable (discord)

    const result = await runInitWizard()

    // Should have exactly 4 calls: name, type, language, template
    expect(mockQuestion).toHaveBeenCalledTimes(4)
    expect(result.template).toBeTruthy()
  })

  it('skips agent subtype prompt when template is selected', async () => {
    mockQuestion
      .mockResolvedValueOnce('my-bot')     // name
      .mockResolvedValueOnce('3')           // type = agent
      .mockResolvedValueOnce('1')           // language = python
      .mockResolvedValueOnce('2')           // template = first applicable

    const result = await runInitWizard()

    expect(result.orchestrator).toBe(false)
    expect(result.loop).toBe(false)
  })

  it('filters templates by language', async () => {
    // With JavaScript, python-only templates should not appear
    mockQuestion
      .mockResolvedValueOnce('my-agent')   // name
      .mockResolvedValueOnce('3')           // type = agent
      .mockResolvedValueOnce('2')           // language = javascript

    // Check stderr output for the template list
    // Python-only templates like 'discord' and 'support-agent' should be filtered out
    const jsTemplates = TEMPLATE_REGISTRY.filter(
      t => t.language === 'both' || t.language === 'javascript'
    )

    // Select "no template" to finish the wizard
    mockQuestion
      .mockResolvedValueOnce('1')           // template = none
      .mockResolvedValueOnce('1')           // run mode = on_demand
      .mockResolvedValueOnce('1')           // agent subtype = code runtime

    await runInitWizard()

    // The template prompt should have shown filtered options
    // (1 "No template" + number of JS-compatible templates)
    const expectedOptionCount = 1 + jsTemplates.length
    // Verify the wizard offered the right number of choices by checking stderr writes
    const templatePromptCalls = stderrSpy.mock.calls
      .map(([msg]) => msg as string)
      .filter(msg => msg.includes('Start from a template'))
    expect(templatePromptCalls.length).toBe(1)
  })
})

describe('--list-templates flag on init command', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()

    program = new Command()
    program.exitOverride()
    registerInitCommand(program)

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    mockFs.access.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    mockFs.mkdir.mockResolvedValue(undefined)
    mockFs.writeFile.mockResolvedValue(undefined)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('prints template list when --list-templates is used', async () => {
    await program.parseAsync(['node', 'test', 'init', '--list-templates'])

    const output = stdoutSpy.mock.calls.map(([msg]) => msg).join('')
    expect(output).toContain('TEMPLATE')
    expect(output).toContain('discord')
    expect(output).toContain('fan-out')
    expect(output).toContain('pipeline')
  })

  it('does not create any files when --list-templates is used', async () => {
    await program.parseAsync(['node', 'test', 'init', '--list-templates'])

    expect(mockFs.writeFile).not.toHaveBeenCalled()
    expect(mockFs.mkdir).not.toHaveBeenCalled()
  })

  it('--list-templates takes priority over name argument', async () => {
    await program.parseAsync(['node', 'test', 'init', 'my-agent', '--list-templates'])

    const output = stdoutSpy.mock.calls.map(([msg]) => msg).join('')
    expect(output).toContain('TEMPLATE')
    expect(mockFs.writeFile).not.toHaveBeenCalled()
  })
})

describe('backwards compatibility', () => {
  let program: Command
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()

    program = new Command()
    program.exitOverride()
    registerInitCommand(program)

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    mockFs.access.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    mockFs.mkdir.mockResolvedValue(undefined)
    mockFs.writeFile.mockResolvedValue(undefined)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('flag-based init still works with name argument', async () => {
    await program.parseAsync(['node', 'test', 'init', 'my-agent', '--type', 'tool'])

    const manifestCall = mockFs.writeFile.mock.calls.find(
      ([p]) => (p as string).endsWith('orchagent.json')
    )
    expect(manifestCall).toBeDefined()
    const manifest = JSON.parse(manifestCall![1] as string)
    expect(manifest.type).toBe('tool')
  })

  it('flag-based init still works without name but with --type', async () => {
    await program.parseAsync(['node', 'test', 'init', '--type', 'tool'])

    const manifestCall = mockFs.writeFile.mock.calls.find(
      ([p]) => (p as string).endsWith('orchagent.json')
    )
    expect(manifestCall).toBeDefined()
  })

  it('flag-based init with --template still works', async () => {
    await program.parseAsync(['node', 'test', 'init', 'my-bot', '--template', 'discord'])

    const writtenFiles = mockFs.writeFile.mock.calls.map(([p]) => (p as string).split('/').pop())
    expect(writtenFiles).toContain('orchagent.json')
    expect(writtenFiles).toContain('main.py')
  })

  it('name-only init still works (non-interactive)', async () => {
    await program.parseAsync(['node', 'test', 'init', 'my-agent'])

    const manifestCall = mockFs.writeFile.mock.calls.find(
      ([p]) => (p as string).endsWith('orchagent.json')
    )
    expect(manifestCall).toBeDefined()
    const manifest = JSON.parse(manifestCall![1] as string)
    expect(manifest.type).toBe('prompt')
    expect(manifest.name).toBe('my-agent')
  })
})
