/**
 * Tests for `orch validate` command and validation engine.
 *
 * Covers: helper functions, valid agents (all types), valid skills,
 * error paths (missing files, bad JSON, bad names, bad types, etc.),
 * warning paths (deprecated fields, schema mismatches, env vars),
 * --json output, --server flag, and edge cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

// ── Mocks ──────────────────────────────────────────────────────────────

vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn(),
    access: vi.fn(),
    readdir: vi.fn(),
    stat: vi.fn(),
  },
}))

vi.mock('../lib/config', () => ({
  getResolvedConfig: vi.fn(),
  loadConfig: vi.fn().mockResolvedValue({}),
}))

vi.mock('../lib/api', () => ({
  getOrg: vi.fn(),
  validateAgentPublish: vi.fn(),
  request: vi.fn(),
}))

vi.mock('../lib/analytics', () => ({ track: vi.fn() }))

// Mock publish.ts scanner exports (used by lib/validate.ts)
vi.mock('./publish', () => ({
  extractTemplateVariables: vi.fn().mockReturnValue([]),
  scanUndeclaredEnvVars: vi.fn().mockResolvedValue([]),
  scanReservedPort: vi.fn().mockResolvedValue(false),
  detectSdkCompatible: vi.fn().mockResolvedValue(false),
  checkDependencies: vi.fn().mockResolvedValue([]),
}))

vi.mock('../lib/bundle', () => ({
  detectEntrypoint: vi.fn().mockResolvedValue(null),
  previewBundle: vi.fn().mockResolvedValue({ fileCount: 5, totalSizeBytes: 1024, entrypoint: 'main.py', excludePatterns: [] }),
  createCodeBundle: vi.fn(),
  validateBundle: vi.fn(),
}))

// ── Imports (after mocks) ──────────────────────────────────────────────

import { registerValidateCommand } from './validate'
import {
  validateAgentProject,
  canonicalizeManifestType,
  normalizeRunMode,
  inferExecutionEngine,
} from '../lib/validate'
import type { AgentManifest } from '../types'
import fs from 'fs/promises'
import { getResolvedConfig, loadConfig } from '../lib/config'
import { getOrg, validateAgentPublish, request } from '../lib/api'
import {
  extractTemplateVariables,
  scanUndeclaredEnvVars,
  scanReservedPort,
  detectSdkCompatible,
  checkDependencies,
} from './publish'
import { detectEntrypoint, previewBundle } from '../lib/bundle'

const mockFs = vi.mocked(fs)
const mockGetResolvedConfig = vi.mocked(getResolvedConfig)
const mockLoadConfig = vi.mocked(loadConfig)
const mockGetOrg = vi.mocked(getOrg)
const mockValidateAgentPublish = vi.mocked(validateAgentPublish)
const mockRequest = vi.mocked(request)
const mockExtractTemplateVariables = vi.mocked(extractTemplateVariables)
const mockScanUndeclaredEnvVars = vi.mocked(scanUndeclaredEnvVars)
const mockScanReservedPort = vi.mocked(scanReservedPort)
const mockDetectSdkCompatible = vi.mocked(detectSdkCompatible)
const mockCheckDependencies = vi.mocked(checkDependencies)
const mockDetectEntrypoint = vi.mocked(detectEntrypoint)
const mockPreviewBundle = vi.mocked(previewBundle)

// ── Helpers ────────────────────────────────────────────────────────────

let program: Command
let stdoutSpy: ReturnType<typeof vi.spyOn>
let stderrSpy: ReturnType<typeof vi.spyOn>
let cwdSpy: ReturnType<typeof vi.spyOn>

function allStdout(): string {
  return stdoutSpy.mock.calls.map(c => String(c[0])).join('')
}

function allStderr(): string {
  return stderrSpy.mock.calls.map(c => String(c[0])).join('')
}

function makeManifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    name: 'test-agent',
    version: 'v1',
    type: 'prompt',
    ...overrides,
  } as AgentManifest
}

function mockManifestFile(manifest: AgentManifest | Record<string, unknown>): void {
  mockFs.readFile.mockImplementation(async (filePath: any) => {
    const p = String(filePath)
    if (p.endsWith('orchagent.json')) return JSON.stringify(manifest)
    if (p.endsWith('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    if (p.endsWith('prompt.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    if (p.endsWith('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  })
}

function mockPromptAgent(manifest?: Partial<AgentManifest>, promptContent = 'You are a helpful assistant.'): void {
  const m = makeManifest({ type: 'prompt', ...manifest })
  mockFs.readFile.mockImplementation(async (filePath: any) => {
    const p = String(filePath)
    if (p.endsWith('orchagent.json')) return JSON.stringify(m)
    if (p.endsWith('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    if (p.endsWith('prompt.md')) return promptContent
    if (p.endsWith('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  })
}

function mockToolAgent(manifest?: Partial<AgentManifest>): void {
  const m = makeManifest({ type: 'tool', ...manifest })
  mockFs.readFile.mockImplementation(async (filePath: any) => {
    const p = String(filePath)
    if (p.endsWith('orchagent.json')) return JSON.stringify(m)
    if (p.endsWith('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    if (p.endsWith('prompt.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    if (p.endsWith('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  })
  mockDetectEntrypoint.mockResolvedValue('main.py')
}

function mockSkillFile(content: string): void {
  mockFs.readFile.mockImplementation(async (filePath: any) => {
    const p = String(filePath)
    if (p.endsWith('SKILL.md')) return content
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  })
}

// ── Setup / Teardown ───────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()

  program = new Command()
  program.exitOverride()
  registerValidateCommand(program)

  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/test/project')

  mockGetResolvedConfig.mockResolvedValue({
    apiKey: 'sk_test_123',
    apiUrl: 'https://api.test.com',
  } as any)
  mockLoadConfig.mockResolvedValue({} as any)
})

afterEach(() => {
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
  cwdSpy.mockRestore()
  vi.restoreAllMocks()
})

// ════════════════════════════════════════════════════════════════════════
// Helper function unit tests
// ════════════════════════════════════════════════════════════════════════

describe('canonicalizeManifestType', () => {
  it('accepts canonical types', () => {
    expect(canonicalizeManifestType('prompt')).toEqual({ canonicalType: 'prompt', rawType: 'prompt', valid: true })
    expect(canonicalizeManifestType('tool')).toEqual({ canonicalType: 'tool', rawType: 'tool', valid: true })
    expect(canonicalizeManifestType('agent')).toEqual({ canonicalType: 'agent', rawType: 'agent', valid: true })
    expect(canonicalizeManifestType('skill')).toEqual({ canonicalType: 'skill', rawType: 'skill', valid: true })
  })

  it('maps legacy aliases', () => {
    expect(canonicalizeManifestType('agentic')).toEqual({ canonicalType: 'agent', rawType: 'agentic', valid: true })
    expect(canonicalizeManifestType('code')).toEqual({ canonicalType: 'tool', rawType: 'code', valid: true })
  })

  it('defaults to agent when undefined', () => {
    expect(canonicalizeManifestType(undefined)).toEqual({ canonicalType: 'agent', rawType: 'agent', valid: true })
  })

  it('handles case insensitivity', () => {
    expect(canonicalizeManifestType('PROMPT')).toEqual({ canonicalType: 'prompt', rawType: 'prompt', valid: true })
    expect(canonicalizeManifestType('Tool')).toEqual({ canonicalType: 'tool', rawType: 'tool', valid: true })
  })

  it('rejects invalid types', () => {
    const result = canonicalizeManifestType('bogus')
    expect(result.valid).toBe(false)
  })
})

describe('normalizeRunMode', () => {
  it('accepts valid modes', () => {
    expect(normalizeRunMode('on_demand')).toEqual({ value: 'on_demand', valid: true })
    expect(normalizeRunMode('always_on')).toEqual({ value: 'always_on', valid: true })
  })

  it('defaults to on_demand when undefined', () => {
    expect(normalizeRunMode(undefined)).toEqual({ value: 'on_demand', valid: true })
  })

  it('rejects invalid modes', () => {
    const result = normalizeRunMode('continuous')
    expect(result.valid).toBe(false)
  })
})

describe('inferExecutionEngine', () => {
  it('infers code_runtime from runtime.command', () => {
    const m = makeManifest({ runtime: { command: 'python3 main.py' } })
    expect(inferExecutionEngine(m, 'prompt')).toEqual({ engine: 'code_runtime', conflict: false })
  })

  it('infers managed_loop from loop config', () => {
    const m = makeManifest({ loop: { max_turns: 10 } })
    expect(inferExecutionEngine(m, 'prompt')).toEqual({ engine: 'managed_loop', conflict: false })
  })

  it('detects conflict when both runtime.command and loop are set', () => {
    const m = makeManifest({ runtime: { command: 'python3 main.py' }, loop: { max_turns: 10 } })
    expect(inferExecutionEngine(m, 'prompt')).toEqual({ engine: null, conflict: true })
  })

  it('infers code_runtime from tool type', () => {
    const m = makeManifest({ type: 'tool' })
    expect(inferExecutionEngine(m, 'tool')).toEqual({ engine: 'code_runtime', conflict: false })
  })

  it('infers managed_loop from agent type', () => {
    const m = makeManifest({ type: 'agent' })
    expect(inferExecutionEngine(m, 'agent')).toEqual({ engine: 'managed_loop', conflict: false })
  })

  it('infers direct_llm for prompt type', () => {
    const m = makeManifest({ type: 'prompt' })
    expect(inferExecutionEngine(m, 'prompt')).toEqual({ engine: 'direct_llm', conflict: false })
  })
})

// ════════════════════════════════════════════════════════════════════════
// validateAgentProject() — Full validation engine tests
// ════════════════════════════════════════════════════════════════════════

describe('validateAgentProject', () => {
  // ── Happy paths ──

  describe('valid agents', () => {
    it('validates a prompt agent', async () => {
      mockPromptAgent()
      const result = await validateAgentProject('/test/project')
      expect(result.valid).toBe(true)
      expect(result.metadata.agentType).toBe('prompt')
      expect(result.metadata.executionEngine).toBe('direct_llm')
      expect(result.metadata.hasPrompt).toBe(true)
    })

    it('validates a tool agent with entrypoint', async () => {
      mockToolAgent()
      const result = await validateAgentProject('/test/project')
      expect(result.valid).toBe(true)
      expect(result.metadata.agentType).toBe('tool')
      expect(result.metadata.executionEngine).toBe('code_runtime')
      expect(result.metadata.bundleEntrypoint).toBe('main.py')
    })

    it('validates a tool agent with --url', async () => {
      mockManifestFile(makeManifest({ type: 'tool' }))
      const result = await validateAgentProject('/test/project', { url: 'https://example.com' })
      expect(result.valid).toBe(true)
    })

    it('validates an agent (managed_loop) type', async () => {
      const m = makeManifest({ type: 'agent', loop: { max_turns: 10 } })
      mockFs.readFile.mockImplementation(async (filePath: any) => {
        const p = String(filePath)
        if (p.endsWith('orchagent.json')) return JSON.stringify(m)
        if (p.endsWith('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        if (p.endsWith('prompt.md')) return 'You are an orchestrator.'
        if (p.endsWith('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      const result = await validateAgentProject('/test/project')
      expect(result.valid).toBe(true)
      expect(result.metadata.executionEngine).toBe('managed_loop')
      expect(result.metadata.maxTurns).toBe(10)
    })

    it('validates a skill (SKILL.md)', async () => {
      mockSkillFile('---\nname: my-skill\ndescription: A test skill\n---\nThis is the skill content.')
      const result = await validateAgentProject('/test/project')
      expect(result.valid).toBe(true)
      expect(result.metadata.isSkill).toBe(true)
      expect(result.metadata.agentName).toBe('my-skill')
    })
  })

  // ── Missing files ──

  describe('missing files', () => {
    it('errors when no orchagent.json or SKILL.md', async () => {
      mockFs.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      const result = await validateAgentProject('/test/project')
      expect(result.valid).toBe(false)
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'error', message: expect.stringContaining('No orchagent.json or SKILL.md') })
      )
    })

    it('errors when prompt.md missing for prompt agent', async () => {
      mockManifestFile(makeManifest({ type: 'prompt' }))
      const result = await validateAgentProject('/test/project')
      expect(result.valid).toBe(false)
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'error', message: expect.stringContaining('No prompt.md found') })
      )
    })

    it('errors when prompt.md missing for managed_loop agent', async () => {
      mockManifestFile(makeManifest({ type: 'agent', loop: { max_turns: 5 } }))
      const result = await validateAgentProject('/test/project')
      expect(result.valid).toBe(false)
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'error', message: expect.stringContaining('No prompt.md found') })
      )
    })
  })

  // ── Invalid JSON ──

  describe('invalid manifest', () => {
    it('errors on malformed JSON', async () => {
      mockFs.readFile.mockImplementation(async (filePath: any) => {
        const p = String(filePath)
        if (p.endsWith('orchagent.json')) return '{ invalid json }'
        if (p.endsWith('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      const result = await validateAgentProject('/test/project')
      expect(result.valid).toBe(false)
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'error', message: expect.stringContaining('Failed to parse orchagent.json') })
      )
    })
  })

  // ── Name validation ──

  describe('name validation', () => {
    it('errors when name is missing', async () => {
      mockPromptAgent({ name: undefined as any })
      const result = await validateAgentProject('/test/project')
      expect(result.valid).toBe(false)
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'error', message: expect.stringContaining('must have a "name"') })
      )
    })

    it('errors when name is uppercase', async () => {
      mockPromptAgent({ name: 'MyAgent' })
      const result = await validateAgentProject('/test/project')
      expect(result.valid).toBe(false)
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'error', message: expect.stringContaining('lowercase') })
      )
    })

    it('errors when name is too short', async () => {
      mockPromptAgent({ name: 'x' })
      const result = await validateAgentProject('/test/project')
      expect(result.valid).toBe(false)
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'error', message: expect.stringContaining('2-50 characters') })
      )
    })

    it('errors when name has consecutive hyphens', async () => {
      mockPromptAgent({ name: 'my--agent' })
      const result = await validateAgentProject('/test/project')
      expect(result.valid).toBe(false)
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'error', message: expect.stringContaining('consecutive hyphens') })
      )
    })

    it('errors when name starts with hyphen', async () => {
      mockPromptAgent({ name: '-my-agent' })
      const result = await validateAgentProject('/test/project')
      expect(result.valid).toBe(false)
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'error', message: expect.stringContaining('start/end with a letter or number') })
      )
    })
  })

  // ── Type validation ──

  describe('type validation', () => {
    it('errors on invalid type', async () => {
      mockPromptAgent({ type: 'bogus' as any })
      const result = await validateAgentProject('/test/project')
      expect(result.valid).toBe(false)
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'error', message: expect.stringContaining("Invalid type") })
      )
    })

    it('errors when orchagent.json has type: skill', async () => {
      mockManifestFile(makeManifest({ type: 'skill' }))
      const result = await validateAgentProject('/test/project')
      expect(result.valid).toBe(false)
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'error', message: expect.stringContaining('SKILL.md format') })
      )
    })

    it('accepts legacy agentic type', async () => {
      const m = makeManifest({ type: 'agentic' as any })
      mockFs.readFile.mockImplementation(async (filePath: any) => {
        const p = String(filePath)
        if (p.endsWith('orchagent.json')) return JSON.stringify(m)
        if (p.endsWith('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        if (p.endsWith('prompt.md')) return 'Prompt content'
        if (p.endsWith('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      const result = await validateAgentProject('/test/project')
      expect(result.valid).toBe(true)
      expect(result.metadata.agentType).toBe('agent')
    })
  })

  // ── Run mode ──

  describe('run mode validation', () => {
    it('errors on invalid run_mode', async () => {
      mockPromptAgent({ run_mode: 'continuous' as any })
      const result = await validateAgentProject('/test/project')
      expect(result.valid).toBe(false)
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'error', message: expect.stringContaining("run_mode must be") })
      )
    })

    it('errors when always_on with direct_llm', async () => {
      mockPromptAgent({ run_mode: 'always_on' })
      const result = await validateAgentProject('/test/project')
      expect(result.valid).toBe(false)
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'error', message: expect.stringContaining('always_on requires runtime.command') })
      )
    })
  })

  // ── Timeout ──

  describe('timeout validation', () => {
    it('errors on negative timeout', async () => {
      mockPromptAgent({ timeout_seconds: -1 })
      const result = await validateAgentProject('/test/project')
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'error', message: expect.stringContaining('positive integer') })
      )
    })

    it('errors on non-integer timeout', async () => {
      mockPromptAgent({ timeout_seconds: 1.5 })
      const result = await validateAgentProject('/test/project')
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'error', message: expect.stringContaining('positive integer') })
      )
    })
  })

  // ── Execution engine conflict ──

  describe('execution engine', () => {
    it('errors when both runtime.command and loop are set', async () => {
      mockPromptAgent({ runtime: { command: 'python3 main.py' }, loop: { max_turns: 5 } })
      const result = await validateAgentProject('/test/project')
      expect(result.valid).toBe(false)
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'error', message: expect.stringContaining('cannot both be set') })
      )
    })
  })

  // ── Managed loop validation ──

  describe('managed loop validation', () => {
    function mockManagedLoopAgent(loopOverrides: Record<string, unknown> = {}, manifestOverrides: Partial<AgentManifest> = {}): void {
      const m = makeManifest({
        type: 'agent',
        loop: { max_turns: 10, ...loopOverrides },
        ...manifestOverrides,
      })
      mockFs.readFile.mockImplementation(async (filePath: any) => {
        const p = String(filePath)
        if (p.endsWith('orchagent.json')) return JSON.stringify(m)
        if (p.endsWith('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        if (p.endsWith('prompt.md')) return 'System prompt.'
        if (p.endsWith('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
    }

    it('errors on max_turns out of range', async () => {
      mockManagedLoopAgent({}, { max_turns: 100 })
      const result = await validateAgentProject('/test/project')
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'error', message: expect.stringContaining('max_turns must be a number between 1 and 50') })
      )
    })

    it('errors on custom tool missing name', async () => {
      mockManagedLoopAgent({ custom_tools: [{ command: 'echo hi' }] })
      const result = await validateAgentProject('/test/project')
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'error', message: expect.stringContaining("must have 'name' and 'command'") })
      )
    })

    it('errors on custom tool with reserved name', async () => {
      mockManagedLoopAgent({ custom_tools: [{ name: 'bash', command: 'echo hi' }] })
      const result = await validateAgentProject('/test/project')
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'error', message: expect.stringContaining("conflicts with built-in") })
      )
    })

    it('errors on duplicate custom tool names', async () => {
      mockManagedLoopAgent({
        custom_tools: [
          { name: 'scan', command: 'echo scan' },
          { name: 'scan', command: 'echo scan2' },
        ],
      })
      const result = await validateAgentProject('/test/project')
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'error', message: expect.stringContaining("Duplicate custom tool name: 'scan'") })
      )
    })
  })

  // ── Code runtime validation ──

  describe('code runtime validation', () => {
    it('errors when no entrypoint and no --url', async () => {
      mockManifestFile(makeManifest({ type: 'tool' }))
      mockDetectEntrypoint.mockResolvedValue(null)
      const result = await validateAgentProject('/test/project')
      expect(result.valid).toBe(false)
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'error', message: expect.stringContaining('entry point file') })
      )
    })

    it('passes when entrypoint detected', async () => {
      mockToolAgent()
      const result = await validateAgentProject('/test/project')
      expect(result.valid).toBe(true)
      expect(result.metadata.bundleEntrypoint).toBe('main.py')
    })
  })

  // ── Docker validation ──

  describe('docker flag', () => {
    it('errors when --docker on non-code-runtime', async () => {
      mockPromptAgent()
      const result = await validateAgentProject('/test/project', { docker: true })
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'error', message: expect.stringContaining('only supported for code runtime') })
      )
    })

    it('errors when --docker but no Dockerfile', async () => {
      mockToolAgent()
      mockFs.access.mockRejectedValue(new Error('ENOENT'))
      const result = await validateAgentProject('/test/project', { docker: true })
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'error', message: expect.stringContaining('no Dockerfile found') })
      )
    })
  })

  // ── Warnings ──

  describe('warnings', () => {
    it('warns about deprecated prompt field', async () => {
      mockPromptAgent({ prompt: 'This is ignored' })
      const result = await validateAgentProject('/test/project')
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'warning', message: expect.stringContaining('"prompt" field') })
      )
    })

    it('warns about model vs default_models', async () => {
      const m = { ...makeManifest({ type: 'prompt' }), model: 'claude-sonnet-4-20250514' } as any
      mockFs.readFile.mockImplementation(async (filePath: any) => {
        const p = String(filePath)
        if (p.endsWith('orchagent.json')) return JSON.stringify(m)
        if (p.endsWith('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        if (p.endsWith('prompt.md')) return 'Hello'
        if (p.endsWith('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      const result = await validateAgentProject('/test/project')
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'warning', message: expect.stringContaining('"model" field is not recognized') })
      )
    })

    it('warns about ORCHAGENT_SERVICE_KEY in required_secrets', async () => {
      mockPromptAgent({ required_secrets: ['ORCHAGENT_SERVICE_KEY', 'MY_TOKEN'] })
      const result = await validateAgentProject('/test/project')
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'warning', message: expect.stringContaining('ORCHAGENT_SERVICE_KEY') })
      )
    })

    it('warns about inline schemas when schema.json exists', async () => {
      const m = makeManifest({ type: 'prompt', input_schema: { type: 'object' } })
      mockFs.readFile.mockImplementation(async (filePath: any) => {
        const p = String(filePath)
        if (p.endsWith('orchagent.json')) return JSON.stringify(m)
        if (p.endsWith('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        if (p.endsWith('prompt.md')) return 'Hello'
        if (p.endsWith('schema.json')) return JSON.stringify({ input: { type: 'object', properties: {} } })
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      const result = await validateAgentProject('/test/project')
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'warning', message: expect.stringContaining('Inline schemas') })
      )
    })

    it('warns about undeclared env vars', async () => {
      mockToolAgent()
      mockScanUndeclaredEnvVars.mockResolvedValue(['MY_SECRET', 'API_TOKEN'])
      const result = await validateAgentProject('/test/project')
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'warning', message: expect.stringContaining('MY_SECRET, API_TOKEN') })
      )
    })

    it('warns about reserved port 8080', async () => {
      mockToolAgent({ run_mode: 'always_on', runtime: { command: 'python3 main.py' } })
      mockScanReservedPort.mockResolvedValue(true)
      const result = await validateAgentProject('/test/project')
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'warning', message: expect.stringContaining('port 8080') })
      )
    })
  })

  // ── Misplaced manifest fields ──

  describe('misplaced fields', () => {
    it('errors on top-level manifest fields', async () => {
      const m = { ...makeManifest({ type: 'prompt' }), dependencies: [{ id: 'org/agent', version: 'v1' }] } as any
      mockFs.readFile.mockImplementation(async (filePath: any) => {
        const p = String(filePath)
        if (p.endsWith('orchagent.json')) return JSON.stringify(m)
        if (p.endsWith('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        if (p.endsWith('prompt.md')) return 'Hello'
        if (p.endsWith('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      const result = await validateAgentProject('/test/project')
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'error', message: expect.stringContaining('manifest fields') })
      )
    })
  })

  // ── Required secrets info ──

  describe('required secrets', () => {
    it('shows info when required_secrets defaults to empty array', async () => {
      mockToolAgent({ required_secrets: undefined })
      const result = await validateAgentProject('/test/project')
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'info', message: expect.stringContaining('defaulting to []') })
      )
    })

    it('does not warn when required_secrets explicitly set', async () => {
      mockToolAgent({ required_secrets: ['MY_TOKEN'] })
      const result = await validateAgentProject('/test/project')
      expect(result.metadata.requiredSecrets).toEqual(['MY_TOKEN'])
    })
  })

  // ── Skill validation ──

  describe('skill validation', () => {
    it('errors when SKILL.md has no frontmatter', async () => {
      mockSkillFile('Just some content without frontmatter')
      const result = await validateAgentProject('/test/project')
      expect(result.valid).toBe(false)
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'error', message: expect.stringContaining('frontmatter') })
      )
    })

    it('errors when SKILL.md frontmatter missing name', async () => {
      mockSkillFile('---\ndescription: A skill\n---\nContent here')
      const result = await validateAgentProject('/test/project')
      expect(result.valid).toBe(false)
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'error', message: expect.stringContaining('"name" field') })
      )
    })

    it('errors when SKILL.md frontmatter missing description', async () => {
      mockSkillFile('---\nname: my-skill\n---\nContent here')
      const result = await validateAgentProject('/test/project')
      expect(result.valid).toBe(false)
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'error', message: expect.stringContaining('"description" field') })
      )
    })

    it('errors when SKILL.md has no body content', async () => {
      mockSkillFile('---\nname: my-skill\ndescription: A skill\n---\n')
      const result = await validateAgentProject('/test/project')
      expect(result.valid).toBe(false)
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'error', message: expect.stringContaining('no content after frontmatter') })
      )
    })

    it('validates skill name format', async () => {
      mockSkillFile('---\nname: My-Skill\ndescription: A skill\n---\nContent')
      const result = await validateAgentProject('/test/project')
      expect(result.valid).toBe(false)
      expect(result.issues).toContainEqual(
        expect.objectContaining({ level: 'error', message: expect.stringContaining('lowercase') })
      )
    })
  })

  // ── Batch errors ──

  describe('batch error reporting', () => {
    it('collects multiple errors at once', async () => {
      const m = { name: 'X', type: 'prompt', version: 'v1' } as any
      mockFs.readFile.mockImplementation(async (filePath: any) => {
        const p = String(filePath)
        if (p.endsWith('orchagent.json')) return JSON.stringify(m)
        if (p.endsWith('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        if (p.endsWith('prompt.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        if (p.endsWith('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      const result = await validateAgentProject('/test/project')
      expect(result.valid).toBe(false)
      const errors = result.issues.filter(i => i.level === 'error')
      // Should have errors for: name too short, uppercase, missing prompt
      expect(errors.length).toBeGreaterThanOrEqual(2)
    })
  })
})

// ════════════════════════════════════════════════════════════════════════
// Command tests (orch validate)
// ════════════════════════════════════════════════════════════════════════

describe('orch validate command', () => {
  it('outputs success for valid agent', async () => {
    mockPromptAgent()
    await program.parseAsync(['node', 'test', 'validate'])
    const output = allStderr()
    expect(output).toContain('Validation passed')
  })

  it('exits with error for invalid agent', async () => {
    mockFs.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    await expect(
      program.parseAsync(['node', 'test', 'validate'])
    ).rejects.toThrow()
    const output = allStderr()
    expect(output).toContain('Validation failed')
  })

  it('supports --json flag', async () => {
    mockPromptAgent()
    await program.parseAsync(['node', 'test', 'validate', '--json'])
    const output = allStdout()
    const json = JSON.parse(output)
    expect(json.valid).toBe(true)
    expect(json.metadata.type).toBe('prompt')
    expect(json.metadata.execution_engine).toBe('direct_llm')
    expect(json.errors).toEqual([])
  })

  it('--json includes errors for invalid agent', async () => {
    mockFs.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    await expect(
      program.parseAsync(['node', 'test', 'validate', '--json'])
    ).rejects.toThrow()
    const output = allStdout()
    const json = JSON.parse(output)
    expect(json.valid).toBe(false)
    expect(json.errors.length).toBeGreaterThan(0)
  })

  it('supports lint alias', async () => {
    mockPromptAgent()
    await program.parseAsync(['node', 'test', 'lint'])
    const output = allStderr()
    expect(output).toContain('Validation passed')
  })

  it('passes --url to validation', async () => {
    mockManifestFile(makeManifest({ type: 'tool' }))
    await program.parseAsync(['node', 'test', 'validate', '--url', 'https://example.com'])
    const output = allStderr()
    expect(output).toContain('Validation passed')
  })

  it('shows warnings but still passes', async () => {
    mockPromptAgent({ prompt: 'This is ignored', required_secrets: ['ORCHAGENT_SERVICE_KEY'] })
    await program.parseAsync(['node', 'test', 'validate'])
    const output = allStderr()
    expect(output).toContain('Validation passed')
    expect(output).toContain('warning')
  })

  it('runs dependency checks when manifest has dependencies', async () => {
    const m = makeManifest({
      type: 'prompt',
      manifest: { dependencies: [{ id: 'joe/scanner', version: 'v1' }] },
    })
    mockFs.readFile.mockImplementation(async (filePath: any) => {
      const p = String(filePath)
      if (p.endsWith('orchagent.json')) return JSON.stringify(m)
      if (p.endsWith('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p.endsWith('prompt.md')) return 'System prompt'
      if (p.endsWith('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockGetOrg.mockResolvedValue({ id: 'org-1', slug: 'joe', name: 'Joe' } as any)
    mockCheckDependencies.mockResolvedValue([
      { ref: 'joe/scanner@v1', status: 'not_found' },
    ])

    await program.parseAsync(['node', 'test', 'validate'])
    expect(mockCheckDependencies).toHaveBeenCalled()
    const output = allStderr()
    expect(output).toContain('Unpublished dependency')
  })

  it('shows cross-org warning for dependencies in a different org (BUG-13-03)', async () => {
    const m = makeManifest({
      type: 'prompt',
      manifest: { dependencies: [{ id: 'other-org/private-agent', version: 'v1' }] },
    })
    mockFs.readFile.mockImplementation(async (filePath: any) => {
      const p = String(filePath)
      if (p.endsWith('orchagent.json')) return JSON.stringify(m)
      if (p.endsWith('SKILL.md')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p.endsWith('prompt.md')) return 'System prompt'
      if (p.endsWith('schema.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    mockGetOrg.mockResolvedValue({ id: 'org-1', slug: 'joe', name: 'Joe' } as any)
    mockCheckDependencies.mockResolvedValue([
      { ref: 'other-org/private-agent@v1', status: 'not_found_cross_org' },
    ])

    await program.parseAsync(['node', 'test', 'validate'])
    expect(mockCheckDependencies).toHaveBeenCalled()
    const output = allStderr()
    expect(output).not.toContain('Unpublished dependency')
    expect(output).toContain('not accessible from this workspace')
  })

  it('shows server validation with --server flag', async () => {
    mockPromptAgent()
    mockGetOrg.mockResolvedValue({ id: 'org-1', slug: 'joe', name: 'Joe' } as any)
    mockValidateAgentPublish.mockResolvedValue({ valid: true, errors: [], warnings: [] })

    await program.parseAsync(['node', 'test', 'validate', '--server'])
    const output = allStderr()
    expect(output).toContain('Server-side validation passed')
  })

  it('shows "[validation only]" label in output', async () => {
    mockPromptAgent()
    await program.parseAsync(['node', 'test', 'validate'])
    const output = allStderr()
    expect(output).toContain('[validation only]')
  })
})
