/**
 * Tests for init-wizard.ts and interactive orch init features.
 *
 * Covers:
 * - printTemplateList output
 * - TEMPLATE_REGISTRY completeness
 * - runInitWizard use-case-driven flows (mocked readline)
 * - --list-templates flag on the init command
 * - Interactive wizard trigger detection
 * - "More templates..." sub-flow
 * - Language follow-up prompts
 * - Backward compatibility with flag-based init
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
    expect(names).toContain('cron-job')
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

  it('cron-job template has correct metadata', () => {
    const cronJob = TEMPLATE_REGISTRY.find(t => t.name === 'cron-job')!
    expect(cronJob.type).toBe('tool')
    expect(cronJob.language).toBe('both')
    expect(cronJob.runMode).toBe('on_demand')
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

  it('shows language and run mode columns', () => {
    printTemplateList()
    const output = stdoutSpy.mock.calls.map(([msg]) => msg).join('')
    expect(output).toContain('LANGUAGE')
    expect(output).toContain('RUN MODE')
    expect(output).toContain('python')
    expect(output).toContain('always_on')
    expect(output).toContain('on_demand')
  })

  it('includes cron-job in the listing', () => {
    printTemplateList()
    const output = stdoutSpy.mock.calls.map(([msg]) => msg).join('')
    expect(output).toContain('cron-job')
    expect(output).toContain('Scheduled task')
  })
})

// ---------------------------------------------------------------------------
// Use-case-driven wizard tests
// ---------------------------------------------------------------------------

describe('runInitWizard', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
  })

  // The wizard menu has 9 options:
  //   1) Prompt agent
  //   2) Tool (Python)
  //   3) Tool (JavaScript)
  //   4) Scheduled job
  //   5) Discord bot
  //   6) Orchestrator
  //   7) AI agent (LLM loop)
  //   8) Knowledge skill
  //   9) More templates...

  it('returns prompt type when selected (option 1)', async () => {
    mockQuestion
      .mockResolvedValueOnce('my-prompt')  // name
      .mockResolvedValueOnce('1')          // use case = prompt agent

    const result = await runInitWizard()

    expect(result.type).toBe('prompt')
    expect(result.language).toBe('python')
    expect(result.template).toBeUndefined()
    expect(result.runMode).toBe('on_demand')
    expect(mockClose).toHaveBeenCalled()
  })

  it('returns tool-python when selected (option 2)', async () => {
    mockQuestion
      .mockResolvedValueOnce('my-tool')    // name
      .mockResolvedValueOnce('2')          // use case = tool (python)

    const result = await runInitWizard()

    expect(result.type).toBe('tool')
    expect(result.language).toBe('python')
    expect(result.template).toBeUndefined()
    expect(result.runMode).toBe('on_demand')
    expect(result.orchestrator).toBe(false)
    expect(result.loop).toBe(false)
  })

  it('returns tool-javascript when selected (option 3)', async () => {
    mockQuestion
      .mockResolvedValueOnce('my-tool')    // name
      .mockResolvedValueOnce('3')          // use case = tool (javascript)

    const result = await runInitWizard()

    expect(result.type).toBe('tool')
    expect(result.language).toBe('javascript')
    expect(result.template).toBeUndefined()
    expect(result.runMode).toBe('on_demand')
  })

  it('returns cron-job template with python (option 4, language 1)', async () => {
    mockQuestion
      .mockResolvedValueOnce('my-job')     // name
      .mockResolvedValueOnce('4')          // use case = scheduled job
      .mockResolvedValueOnce('1')          // language = python

    const result = await runInitWizard()

    expect(result.type).toBe('tool')
    expect(result.language).toBe('python')
    expect(result.template).toBe('cron-job')
    expect(result.runMode).toBe('on_demand')
  })

  it('returns cron-job template with javascript (option 4, language 2)', async () => {
    mockQuestion
      .mockResolvedValueOnce('my-job')     // name
      .mockResolvedValueOnce('4')          // use case = scheduled job
      .mockResolvedValueOnce('2')          // language = javascript

    const result = await runInitWizard()

    expect(result.type).toBe('tool')
    expect(result.language).toBe('javascript')
    expect(result.template).toBe('cron-job')
    expect(result.runMode).toBe('on_demand')
  })

  it('returns discord python template (option 5, language 1)', async () => {
    mockQuestion
      .mockResolvedValueOnce('my-bot')     // name
      .mockResolvedValueOnce('5')          // use case = discord bot
      .mockResolvedValueOnce('1')          // language = python

    const result = await runInitWizard()

    expect(result.type).toBe('agent')
    expect(result.language).toBe('python')
    expect(result.template).toBe('discord')
    expect(result.runMode).toBe('always_on')
  })

  it('returns discord-js template (option 5, language 2)', async () => {
    mockQuestion
      .mockResolvedValueOnce('my-bot')     // name
      .mockResolvedValueOnce('5')          // use case = discord bot
      .mockResolvedValueOnce('2')          // language = javascript

    const result = await runInitWizard()

    expect(result.type).toBe('agent')
    expect(result.language).toBe('javascript')
    expect(result.template).toBe('discord-js')
    expect(result.runMode).toBe('always_on')
  })

  it('returns orchestrator with python (option 6, language 1)', async () => {
    mockQuestion
      .mockResolvedValueOnce('my-orch')    // name
      .mockResolvedValueOnce('6')          // use case = orchestrator
      .mockResolvedValueOnce('1')          // language = python

    const result = await runInitWizard()

    expect(result.type).toBe('agent')
    expect(result.language).toBe('python')
    expect(result.orchestrator).toBe(true)
    expect(result.loop).toBe(false)
    expect(result.runMode).toBe('on_demand')
  })

  it('returns orchestrator with javascript (option 6, language 2)', async () => {
    mockQuestion
      .mockResolvedValueOnce('my-orch')    // name
      .mockResolvedValueOnce('6')          // use case = orchestrator
      .mockResolvedValueOnce('2')          // language = javascript

    const result = await runInitWizard()

    expect(result.type).toBe('agent')
    expect(result.language).toBe('javascript')
    expect(result.orchestrator).toBe(true)
  })

  it('returns managed loop agent (option 7)', async () => {
    mockQuestion
      .mockResolvedValueOnce('my-agent')   // name
      .mockResolvedValueOnce('7')          // use case = AI agent (LLM loop)

    const result = await runInitWizard()

    expect(result.type).toBe('agent')
    expect(result.language).toBe('python')
    expect(result.loop).toBe(true)
    expect(result.orchestrator).toBe(false)
    expect(result.runMode).toBe('on_demand')
  })

  it('returns skill type (option 8)', async () => {
    mockQuestion
      .mockResolvedValueOnce('my-skill')   // name
      .mockResolvedValueOnce('8')          // use case = knowledge skill

    const result = await runInitWizard()

    expect(result.type).toBe('skill')
    expect(result.language).toBe('python')
    expect(result.template).toBeUndefined()
    expect(mockClose).toHaveBeenCalled()
  })

  // --- "More templates..." sub-flow ---

  it('more templates: picks fan-out with python (option 9)', async () => {
    mockQuestion
      .mockResolvedValueOnce('my-agent')   // name
      .mockResolvedValueOnce('9')          // use case = more templates
      .mockResolvedValueOnce('1')          // language = python
      // Template list for python: 1=none, 2=cron-job, 3=discord, 4=support-agent,
      // 5=fan-out, 6=pipeline, 7=map-reduce, 8=github-weekly-summary
      .mockResolvedValueOnce('5')          // template = fan-out

    const result = await runInitWizard()

    expect(result.template).toBe('fan-out')
    expect(result.type).toBe('agent')
    expect(result.language).toBe('python')
    expect(result.runMode).toBe('on_demand')
  })

  it('more templates: picks "No template" then falls back to type selection', async () => {
    mockQuestion
      .mockResolvedValueOnce('my-agent')   // name
      .mockResolvedValueOnce('9')          // use case = more templates
      .mockResolvedValueOnce('1')          // language = python
      .mockResolvedValueOnce('1')          // template = none
      .mockResolvedValueOnce('2')          // type = tool
      .mockResolvedValueOnce('1')          // run mode = on_demand

    const result = await runInitWizard()

    expect(result.type).toBe('tool')
    expect(result.language).toBe('python')
    expect(result.template).toBeUndefined()
    expect(result.runMode).toBe('on_demand')
  })

  it('more templates: agent type with orchestrator subtype', async () => {
    mockQuestion
      .mockResolvedValueOnce('my-agent')   // name
      .mockResolvedValueOnce('9')          // use case = more templates
      .mockResolvedValueOnce('1')          // language = python
      .mockResolvedValueOnce('1')          // template = none
      .mockResolvedValueOnce('3')          // type = agent
      .mockResolvedValueOnce('1')          // run mode = on_demand
      .mockResolvedValueOnce('2')          // agent subtype = orchestrator

    const result = await runInitWizard()

    expect(result.type).toBe('agent')
    expect(result.orchestrator).toBe(true)
    expect(result.loop).toBe(false)
  })

  it('more templates: agent type with managed loop', async () => {
    mockQuestion
      .mockResolvedValueOnce('my-agent')   // name
      .mockResolvedValueOnce('9')          // use case = more templates
      .mockResolvedValueOnce('1')          // language = python
      .mockResolvedValueOnce('1')          // template = none
      .mockResolvedValueOnce('3')          // type = agent
      .mockResolvedValueOnce('1')          // run mode = on_demand
      .mockResolvedValueOnce('3')          // agent subtype = managed loop

    const result = await runInitWizard()

    expect(result.type).toBe('agent')
    expect(result.loop).toBe(true)
  })

  it('more templates with javascript filters out python-only templates', async () => {
    mockQuestion
      .mockResolvedValueOnce('my-agent')   // name
      .mockResolvedValueOnce('9')          // use case = more templates
      .mockResolvedValueOnce('2')          // language = javascript

    // JS-compatible templates from registry: cron-job(both), discord-js(js), fan-out(both), pipeline(both), map-reduce(both)
    // So template list = [none, cron-job, discord-js, fan-out, pipeline, map-reduce] = 6 options
    // Pick "none" to verify filtering worked
    mockQuestion
      .mockResolvedValueOnce('1')          // template = none
      .mockResolvedValueOnce('2')          // type = tool
      .mockResolvedValueOnce('1')          // run mode = on_demand

    const result = await runInitWizard()

    // Python-only templates (discord, support-agent, github-weekly-summary) should be excluded
    const templatePromptCalls = stderrSpy.mock.calls
      .map(([msg]) => msg as string)
      .filter(msg => msg.includes('Pick a template'))
    expect(templatePromptCalls.length).toBe(1)

    expect(result.language).toBe('javascript')
  })

  // --- Edge cases ---

  it('uses cwd basename as default name', async () => {
    mockQuestion
      .mockResolvedValueOnce('')           // name = default (cwd basename)
      .mockResolvedValueOnce('1')          // use case = prompt

    const result = await runInitWizard()

    expect(result.name).toBeUndefined()
  })

  it('creates subdir when name differs from cwd', async () => {
    mockQuestion
      .mockResolvedValueOnce('different-name')  // name differs from cwd
      .mockResolvedValueOnce('1')               // use case = prompt

    const result = await runInitWizard()

    expect(result.name).toBe('different-name')
  })

  it('retries on invalid selection input', async () => {
    mockQuestion
      .mockResolvedValueOnce('my-agent')   // name
      .mockResolvedValueOnce('invalid')    // invalid type selection
      .mockResolvedValueOnce('0')          // out of range
      .mockResolvedValueOnce('1')          // valid: prompt

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

  it('wizard prints header on stderr', async () => {
    mockQuestion
      .mockResolvedValueOnce('my-agent')
      .mockResolvedValueOnce('1')  // prompt

    await runInitWizard()

    const stderrOutput = stderrSpy.mock.calls.map(([msg]) => msg as string).join('')
    expect(stderrOutput).toContain('orch init')
    expect(stderrOutput).toContain('interactive setup')
  })

  it('wizard shows "What do you want to build?" question', async () => {
    mockQuestion
      .mockResolvedValueOnce('my-agent')
      .mockResolvedValueOnce('1')  // prompt

    await runInitWizard()

    const stderrOutput = stderrSpy.mock.calls.map(([msg]) => msg as string).join('')
    expect(stderrOutput).toContain('What do you want to build?')
  })
})

// ---------------------------------------------------------------------------
// --list-templates flag
// ---------------------------------------------------------------------------

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
    expect(output).toContain('cron-job')
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

// ---------------------------------------------------------------------------
// Backward compatibility — flag-based init still works
// ---------------------------------------------------------------------------

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

  it('--template cron-job works via flags', async () => {
    await program.parseAsync(['node', 'test', 'init', 'my-job', '--template', 'cron-job'])

    const manifestCall = mockFs.writeFile.mock.calls.find(
      ([p]) => (p as string).endsWith('orchagent.json')
    )
    expect(manifestCall).toBeDefined()
    const manifest = JSON.parse(manifestCall![1] as string)
    expect(manifest.type).toBe('tool')
    expect(manifest.tags).toContain('cron')

    const writtenFiles = mockFs.writeFile.mock.calls.map(([p]) => (p as string).split('/').pop())
    expect(writtenFiles).toContain('main.py')
    expect(writtenFiles).toContain('schema.json')
    expect(writtenFiles).toContain('README.md')
  })

  it('--template cron-job with --language javascript works', async () => {
    await program.parseAsync(['node', 'test', 'init', 'my-job', '--template', 'cron-job', '--language', 'javascript'])

    const manifestCall = mockFs.writeFile.mock.calls.find(
      ([p]) => (p as string).endsWith('orchagent.json')
    )
    expect(manifestCall).toBeDefined()
    const manifest = JSON.parse(manifestCall![1] as string)
    expect(manifest.runtime.command).toBe('node main.js')
    expect(manifest.entrypoint).toBe('main.js')

    const writtenFiles = mockFs.writeFile.mock.calls.map(([p]) => (p as string).split('/').pop())
    expect(writtenFiles).toContain('main.js')
    expect(writtenFiles).toContain('package.json')
    expect(writtenFiles).toContain('schema.json')
  })
})
