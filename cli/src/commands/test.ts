import { Command } from 'commander'
import fs from 'fs/promises'
import path from 'path'
import { spawn } from 'child_process'
import chalk from 'chalk'
import yaml from 'yaml'
import deepEqual from 'fast-deep-equal'
import chokidar from 'chokidar'

import { CliError } from '../lib/errors'
import { printJson } from '../lib/output'
import { loadDotEnv } from '../lib/dotenv'
import { getResolvedConfig } from '../lib/config'
import {
  detectLlmKey,
  getDefaultModel,
  buildPrompt,
  callLlm,
  type LlmProvider,
} from '../lib/llm'
import { detectEntrypoint } from '../lib/bundle'
import { runMockedAgentFixtureTests } from '../lib/test-mock-runner'
import type { AgentManifest, ResolvedConfig } from '../types'

// ─── Types ───────────────────────────────────────────────────────────────────

type AgentType = 'prompt' | 'code-python' | 'code-js' | 'skill' | 'unknown'

type TestFiles = {
  python: string[]
  javascript: string[]
  fixtures: string[]
}

type TestFixture = {
  input: Record<string, unknown>
  expected_output?: Record<string, unknown>
  expected_contains?: string[]
  description?: string
  mocks?: Record<string, unknown>
}

type ExecutionEngine = 'direct_llm' | 'managed_loop' | 'code_runtime'

type ValidationMessage = {
  level: 'error' | 'warning' | 'info'
  text: string
}

type AgentValidation = {
  messages: ValidationMessage[]
  executionEngine?: ExecutionEngine
  entrypoint?: string
  agentName?: string
  agentType?: string
  isSkill: boolean
}

// ─── Utility functions ───────────────────────────────────────────────────────

function validateFixture(data: unknown, fixturePath: string): TestFixture {
  const fileName = path.basename(fixturePath)

  if (typeof data !== 'object' || data === null) {
    throw new CliError(`Invalid fixture ${fileName}: must be a JSON object`)
  }

  const obj = data as Record<string, unknown>

  if (!obj.input || typeof obj.input !== 'object') {
    throw new CliError(
      `Invalid fixture ${fileName}: missing required "input" field.\n` +
      `  Expected format: { "input": {...}, "expected_output": {...} }`
    )
  }

  if (!obj.expected_output && !obj.expected_contains) {
    throw new CliError(
      `Invalid fixture ${fileName}: must have "expected_output" or "expected_contains".\n` +
      `  Add one of:\n` +
      `    "expected_output": {"key": "exact value to match"}\n` +
      `    "expected_contains": ["substring to find"]`
    )
  }

  return data as TestFixture
}

interface SkillFrontmatter {
  name: string
  description: string
}

async function parseSkillMd(filePath: string): Promise<{
  frontmatter: SkillFrontmatter
  body: string
} | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!match) return null
    const frontmatter = yaml.parse(match[1]) as SkillFrontmatter
    const body = match[2].trim()
    if (!frontmatter.name || !frontmatter.description) return null
    return { frontmatter, body }
  } catch {
    return null
  }
}

/**
 * Run a shell command (for test runners like pytest/vitest)
 * Uses shell: true because test runner commands may need PATH resolution
 */
function runCommand(
  command: string,
  args: string[],
  cwd: string,
  verbose: boolean
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: true,
    })

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (data) => {
      const text = data.toString()
      stdout += text
      if (verbose) {
        process.stdout.write(text)
      }
    })

    proc.stderr?.on('data', (data) => {
      const text = data.toString()
      stderr += text
      // Always show stderr for test output
      process.stderr.write(text)
    })

    proc.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr })
    })

    proc.on('error', (err) => {
      resolve({ code: 1, stdout, stderr: err.message })
    })
  })
}

async function commandExists(command: string): Promise<boolean> {
  const isWindows = process.platform === 'win32'
  const checker = isWindows ? 'where' : 'which'

  try {
    const proc = spawn(checker, [command], { shell: true, stdio: 'ignore' })
    return new Promise((resolve) => {
      proc.on('close', (code) => resolve(code === 0))
      proc.on('error', () => resolve(false))
    })
  } catch {
    return false
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

function extractTemplateVariables(template: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  const pattern = /\{\{(\w+)\}\}/g
  let match
  while ((match = pattern.exec(template)) !== null) {
    if (!seen.has(match[1])) {
      seen.add(match[1])
      result.push(match[1])
    }
  }
  return result
}

// ─── Validation ──────────────────────────────────────────────────────────────

function inferEngine(manifest: AgentManifest, rawType: string): ExecutionEngine {
  const hasRuntimeCommand = Boolean(manifest.runtime?.command?.trim())
  const hasLoop = Boolean(manifest.loop && Object.keys(manifest.loop).length > 0)

  if (hasRuntimeCommand) return 'code_runtime'
  if (hasLoop) return 'managed_loop'
  if (rawType === 'tool' || rawType === 'code') return 'code_runtime'
  if (rawType === 'agentic') return 'managed_loop'
  if (rawType === 'agent') {
    if (manifest.custom_tools?.length || manifest.max_turns) return 'managed_loop'
    return 'managed_loop'
  }
  return 'direct_llm'
}

function engineLabel(engine: ExecutionEngine): string {
  switch (engine) {
    case 'direct_llm': return 'prompt'
    case 'managed_loop': return 'agent loop'
    case 'code_runtime': return 'code runtime'
  }
}

async function validateAgent(agentDir: string): Promise<AgentValidation> {
  const msgs: ValidationMessage[] = []
  const err = (text: string) => msgs.push({ level: 'error', text })
  const warn = (text: string) => msgs.push({ level: 'warning', text })
  const info = (text: string) => msgs.push({ level: 'info', text })

  // Check for SKILL.md (skills are a separate path)
  const skillPath = path.join(agentDir, 'SKILL.md')
  const skillData = await parseSkillMd(skillPath)
  if (skillData) {
    info(`Skill: ${skillData.frontmatter.name}`)
    if (!skillData.frontmatter.description) {
      err('SKILL.md frontmatter missing "description"')
    }
    return { messages: msgs, isSkill: true, agentName: skillData.frontmatter.name }
  }

  // If SKILL.md exists but is invalid
  if (await fileExists(skillPath)) {
    warn('SKILL.md found but has invalid frontmatter (needs name + description in YAML)')
  }

  // Read orchagent.json
  const manifestPath = path.join(agentDir, 'orchagent.json')
  let manifest: AgentManifest
  try {
    const raw = await fs.readFile(manifestPath, 'utf-8')
    manifest = JSON.parse(raw)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      err('orchagent.json not found — create one with: orch init')
    } else {
      err(`orchagent.json is not valid JSON: ${(e as Error).message}`)
    }
    return { messages: msgs, isSkill: false }
  }

  // Name
  if (!manifest.name) {
    err("'name' field is required in orchagent.json")
  }

  // Type
  const rawType = (manifest.type || 'agent').trim().toLowerCase()
  const validTypes = ['prompt', 'tool', 'agent', 'skill', 'agentic', 'code']
  if (!validTypes.includes(rawType)) {
    err(`Invalid type '${manifest.type}' — use: prompt, tool, or agent`)
  }
  if (rawType === 'agentic') warn("Type 'agentic' is deprecated — use 'agent'")
  if (rawType === 'code') warn("Type 'code' is deprecated — use 'tool'")
  if (rawType === 'skill') err("Skills should use SKILL.md, not orchagent.json with type='skill'")

  // Engine inference
  const hasRuntimeCommand = Boolean(manifest.runtime?.command?.trim())
  const hasLoop = Boolean(manifest.loop && Object.keys(manifest.loop).length > 0)

  if (hasRuntimeCommand && hasLoop) {
    err('runtime.command and loop cannot both be set — choose one execution model')
  }

  const engine = inferEngine(manifest, rawType)

  // run_mode
  const runMode = (manifest.run_mode || 'on_demand').trim().toLowerCase()
  if (runMode !== 'on_demand' && runMode !== 'always_on') {
    err("run_mode must be 'on_demand' or 'always_on'")
  }
  if (runMode === 'always_on' && engine === 'direct_llm') {
    err('run_mode=always_on requires runtime.command or loop configuration')
  }

  // File structure: prompt.md
  const hasPrompt = await fileExists(path.join(agentDir, 'prompt.md'))
  if ((engine === 'direct_llm' || engine === 'managed_loop') && !hasPrompt) {
    const label = engine === 'direct_llm' ? 'prompt agents' : 'agent-type agents'
    err(`prompt.md not found (required for ${label})`)
  }

  // File structure: entrypoint for code_runtime
  let entrypoint: string | undefined
  if (engine === 'code_runtime') {
    entrypoint = manifest.entrypoint || await detectEntrypoint(agentDir) || undefined
    if (!entrypoint && !manifest.runtime?.command && !manifest.source_url) {
      err('No entrypoint found — create main.py, app.py, or set entrypoint in orchagent.json')
    } else if (entrypoint && !await fileExists(path.join(agentDir, entrypoint))) {
      err(`Entrypoint '${entrypoint}' declared but file not found`)
    }
  }

  // schema.json validity
  const schemaPath = path.join(agentDir, 'schema.json')
  const hasSchema = await fileExists(schemaPath)
  if (hasSchema) {
    try {
      const raw = await fs.readFile(schemaPath, 'utf-8')
      JSON.parse(raw)
    } catch {
      err('schema.json contains invalid JSON')
    }
  }

  // Deprecated fields
  if (manifest.prompt) {
    warn("'prompt' field in orchagent.json is ignored — use prompt.md file")
  }
  if (manifest.input_schema && hasSchema) {
    warn("'input_schema' in orchagent.json is ignored — schema.json takes priority")
  }
  if (manifest.output_schema && hasSchema) {
    warn("'output_schema' in orchagent.json is ignored — schema.json takes priority")
  }

  // Misplaced manifest fields (common error: dependencies at top level instead of under manifest)
  const orchestrationFields = ['manifest_version', 'dependencies', 'max_hops', 'timeout_ms', 'per_call_downstream_cap']
  const misplaced = orchestrationFields.filter(f => (f in (manifest as Record<string, unknown>)) && !manifest.manifest)
  if (misplaced.length > 0) {
    err(`Orchestration fields (${misplaced.join(', ')}) must be nested under a "manifest" key`)
  }

  // required_secrets
  if (manifest.required_secrets !== undefined) {
    if (!Array.isArray(manifest.required_secrets)) {
      err('required_secrets must be an array of strings')
    } else {
      if (manifest.required_secrets.includes('ORCHAGENT_SERVICE_KEY')) {
        warn('ORCHAGENT_SERVICE_KEY in required_secrets is not needed — the gateway auto-injects it for orchestrator agents')
      }
      // Check if secrets are available in local environment
      const missingSecrets = manifest.required_secrets.filter(s => !process.env[s])
      if (missingSecrets.length > 0) {
        warn(`Required secrets not in local environment: ${missingSecrets.join(', ')} — fixture tests may fail`)
      }
    }
  }

  // requirements.txt: orchagent vs orchagent-sdk
  const reqPath = path.join(agentDir, 'requirements.txt')
  if (await fileExists(reqPath)) {
    try {
      const reqContent = await fs.readFile(reqPath, 'utf-8')
      if (/^orchagent\b/m.test(reqContent) && !/^orchagent-sdk\b/m.test(reqContent)) {
        warn("requirements.txt has 'orchagent' — did you mean 'orchagent-sdk'?")
      }
    } catch {
      // Can't read, skip
    }
  }

  // custom_tools validation
  if (engine === 'managed_loop' && manifest.custom_tools) {
    const reservedNames = new Set(['bash', 'read_file', 'write_file', 'list_files', 'submit_result'])
    const seenNames = new Set<string>()
    for (const tool of manifest.custom_tools) {
      if (!tool.name || !tool.command) {
        err(`Custom tool missing 'name' or 'command': ${JSON.stringify(tool)}`)
      }
      if (tool.name && reservedNames.has(tool.name)) {
        err(`Custom tool '${tool.name}' conflicts with built-in tool name`)
      }
      if (tool.name && seenNames.has(tool.name)) {
        err(`Duplicate custom tool name: '${tool.name}'`)
      }
      if (tool.name) seenNames.add(tool.name)
    }
  }

  // max_turns range
  if (manifest.max_turns !== undefined) {
    if (typeof manifest.max_turns !== 'number' || manifest.max_turns < 1 || manifest.max_turns > 50) {
      err('max_turns must be a number between 1 and 50')
    }
  }

  // Template variable mismatch (prompt.md vars vs schema.json)
  if ((engine === 'direct_llm' || engine === 'managed_loop') && hasPrompt && hasSchema) {
    try {
      const prompt = await fs.readFile(path.join(agentDir, 'prompt.md'), 'utf-8')
      const schemaRaw = await fs.readFile(schemaPath, 'utf-8')
      const schemas = JSON.parse(schemaRaw)
      const templateVars = extractTemplateVariables(prompt)
      if (templateVars.length > 0 && schemas.input?.properties) {
        const schemaProps = Object.keys(schemas.input.properties)
        const missing = templateVars.filter(v => !schemaProps.includes(v))
        if (missing.length > 0) {
          warn(`prompt.md uses {{${missing.join('}}, {{')}}} but schema.json doesn't define ${missing.length === 1 ? 'it' : 'them'}`)
        }
      }
    } catch {
      // Already caught above
    }
  }

  return {
    messages: msgs,
    executionEngine: engine,
    entrypoint,
    agentName: manifest.name || undefined,
    agentType: rawType,
    isSkill: false,
  }
}

function printValidation(validation: AgentValidation): boolean {
  const errors = validation.messages.filter(m => m.level === 'error')
  const warnings = validation.messages.filter(m => m.level === 'warning')
  const infos = validation.messages.filter(m => m.level === 'info')

  process.stderr.write(chalk.bold('\nValidating agent...\n'))

  // Agent summary line
  if (validation.isSkill) {
    process.stderr.write(`  ${chalk.bold('Type:')} skill\n`)
  } else if (validation.agentType && validation.executionEngine) {
    process.stderr.write(`  ${chalk.bold('Type:')} ${validation.agentType} (${engineLabel(validation.executionEngine)})\n`)
    if (validation.entrypoint) {
      process.stderr.write(`  ${chalk.bold('Entrypoint:')} ${validation.entrypoint}\n`)
    }
  }

  if (validation.agentName) {
    process.stderr.write(`  ${chalk.bold('Name:')} ${validation.agentName}\n`)
  }

  process.stderr.write('\n')

  // Messages
  for (const msg of errors) {
    process.stderr.write(chalk.red(`  ✗ ${msg.text}\n`))
  }
  for (const msg of warnings) {
    process.stderr.write(chalk.yellow(`  ⚠ ${msg.text}\n`))
  }
  for (const msg of infos) {
    process.stderr.write(chalk.gray(`  ℹ ${msg.text}\n`))
  }

  if (errors.length === 0) {
    process.stderr.write(chalk.green('  ✓ Configuration valid\n'))
  }

  process.stderr.write('\n')
  return errors.length === 0
}

// ─── Test discovery ──────────────────────────────────────────────────────────

async function walkDir(dir: string, files: string[] = []): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (['node_modules', '__pycache__', '.git', 'dist', 'build', '.venv', 'venv'].includes(entry.name)) {
          continue
        }
        await walkDir(fullPath, files)
      } else if (entry.isFile()) {
        files.push(fullPath)
      }
    }
  } catch {
    // Directory doesn't exist or not readable
  }
  return files
}

async function discoverTests(agentDir: string): Promise<TestFiles> {
  const result: TestFiles = {
    python: [],
    javascript: [],
    fixtures: [],
  }

  const allFiles = await walkDir(agentDir)

  for (const file of allFiles) {
    const basename = path.basename(file)
    const relPath = path.relative(agentDir, file)

    // Python test patterns: test_*.py, *_test.py
    if (basename.endsWith('.py')) {
      if (basename.startsWith('test_') || basename.endsWith('_test.py')) {
        result.python.push(file)
      }
    }

    // JS/TS test patterns: *.test.ts, *.test.js, *.spec.ts, *.spec.js
    if (basename.endsWith('.test.ts') || basename.endsWith('.test.js') ||
        basename.endsWith('.spec.ts') || basename.endsWith('.spec.js')) {
      result.javascript.push(file)
    }

    // Fixture patterns: tests/fixture*.json
    if (basename.endsWith('.json') && basename.startsWith('fixture')) {
      if (relPath.includes('tests' + path.sep) || relPath.startsWith('tests' + path.sep)) {
        result.fixtures.push(file)
      }
    }
  }

  return result
}

// ─── Test runners ────────────────────────────────────────────────────────────

async function runPythonTests(agentDir: string, verbose: boolean): Promise<number> {
  process.stderr.write(chalk.blue('\nRunning Python tests...\n\n'))

  const hasPytest = await commandExists('pytest')

  if (hasPytest) {
    const args = verbose ? ['-v'] : []
    const { code } = await runCommand('pytest', args, agentDir, verbose)
    return code
  }

  const pythonCommands = process.platform === 'win32'
    ? ['python', 'py', 'python3']
    : ['python3', 'python']

  for (const pythonCmd of pythonCommands) {
    if (await commandExists(pythonCmd)) {
      const args = ['-m', 'pytest']
      if (verbose) args.push('-v')
      const { code } = await runCommand(pythonCmd, args, agentDir, verbose)
      return code
    }
  }

  process.stderr.write(chalk.red('No Python interpreter found. Install Python and pytest.\n'))
  return 1
}

async function runJsTests(agentDir: string, verbose: boolean): Promise<number> {
  process.stderr.write(chalk.blue('\nRunning JavaScript/TypeScript tests...\n\n'))

  const hasVitest = await fileExists(path.join(agentDir, 'node_modules', '.bin', 'vitest'))

  if (hasVitest) {
    const args = ['run']
    if (verbose) args.push('--reporter=verbose')
    const { code } = await runCommand('npx', ['vitest', ...args], agentDir, verbose)
    return code
  }

  const packageJsonPath = path.join(agentDir, 'package.json')
  if (await fileExists(packageJsonPath)) {
    try {
      const raw = await fs.readFile(packageJsonPath, 'utf-8')
      const pkg = JSON.parse(raw)
      if (pkg.scripts?.test) {
        const { code } = await runCommand('npm', ['test'], agentDir, verbose)
        return code
      }
    } catch {
      // Invalid package.json
    }
  }

  process.stderr.write(chalk.yellow('No JavaScript test runner found. Install vitest or add a test script to package.json.\n'))
  return 1
}

/**
 * Run fixture tests for prompt/skill/managed_loop agents using LLM calls
 */
async function runPromptFixtureTests(
  agentDir: string,
  fixtures: string[],
  verbose: boolean,
  config?: ResolvedConfig
): Promise<number> {
  process.stderr.write(chalk.blue('\nRunning fixture tests...\n\n'))

  // Read prompt
  let prompt: string
  const promptPath = path.join(agentDir, 'prompt.md')
  const skillPath = path.join(agentDir, 'SKILL.md')

  const skillData = await parseSkillMd(skillPath)
  if (skillData) {
    prompt = skillData.body
  } else {
    try {
      prompt = await fs.readFile(promptPath, 'utf-8')
    } catch {
      throw new CliError('No prompt.md or SKILL.md found for fixture tests')
    }
  }

  // Read output schema if available
  let outputSchema: object | undefined
  const schemaPath = path.join(agentDir, 'schema.json')
  try {
    const raw = await fs.readFile(schemaPath, 'utf-8')
    const schemas = JSON.parse(raw)
    outputSchema = schemas.output
  } catch {
    // Schema is optional
  }

  // Detect LLM key
  const detected = await detectLlmKey(['any'] as LlmProvider[], config)
  if (!detected) {
    throw new CliError(
      'No LLM key found for fixture tests.\n' +
      'Set an environment variable (e.g., OPENAI_API_KEY) or run `orch secrets set <PROVIDER>_API_KEY <key>`'
    )
  }

  const { provider, key, model: serverModel } = detected
  const model = serverModel ?? getDefaultModel(provider)

  let passed = 0
  let failed = 0

  for (const fixturePath of fixtures) {
    const fixtureName = path.basename(fixturePath)
    const description = await getFixtureDescription(fixturePath)
    process.stderr.write(`  ${fixtureName}${description ? ` (${description})` : ''}: `)

    try {
      const raw = await fs.readFile(fixturePath, 'utf-8')
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (e) {
        throw new CliError(`Invalid JSON in ${path.basename(fixturePath)}: ${(e as Error).message}`)
      }
      const fixture = validateFixture(parsed, fixturePath)

      const fullPrompt = buildPrompt(prompt, fixture.input)
      const result = await callLlm(provider, key, model, fullPrompt, outputSchema)

      let testPassed = true
      const failures: string[] = []

      if (fixture.expected_output) {
        if (!deepEqual(result, fixture.expected_output)) {
          testPassed = false
          failures.push(`Expected: ${JSON.stringify(fixture.expected_output, null, 2)}\nGot: ${JSON.stringify(result, null, 2)}`)
        }
      }

      if (fixture.expected_contains) {
        const resultStr = JSON.stringify(result)
        for (const expected of fixture.expected_contains) {
          if (!resultStr.includes(expected)) {
            testPassed = false
            failures.push(`Expected output to contain: "${expected}"`)
          }
        }
      }

      if (testPassed) {
        process.stderr.write(chalk.green('PASS\n'))
        passed++
        if (verbose) {
          process.stderr.write(chalk.gray(`    Input: ${JSON.stringify(fixture.input)}\n`))
          process.stderr.write(chalk.gray(`    Output: ${JSON.stringify(result)}\n`))
        }
      } else {
        process.stderr.write(chalk.red('FAIL\n'))
        failed++
        for (const failure of failures) {
          process.stderr.write(chalk.red(`    ${failure}\n`))
        }
      }
    } catch (err) {
      process.stderr.write(chalk.red('ERROR\n'))
      failed++
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(chalk.red(`    ${message}\n`))
    }
  }

  process.stderr.write('\n')
  process.stderr.write(`Fixtures: ${passed} passed, ${failed} failed\n`)

  return failed > 0 ? 1 : 0
}

async function getFixtureDescription(fixturePath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(fixturePath, 'utf-8')
    const data = JSON.parse(raw)
    return data.description || null
  } catch {
    return null
  }
}

/**
 * Run a code_runtime entrypoint with JSON input on stdin, capture JSON output.
 * Uses spawn with array args (no shell) to avoid injection risks.
 */
function runEntrypointWithInput(
  agentDir: string,
  entrypoint: string,
  stdinData: string,
  verbose: boolean
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const isJs = entrypoint.endsWith('.js') || entrypoint.endsWith('.ts') ||
                 entrypoint.endsWith('.mjs') || entrypoint.endsWith('.cjs')
    const cmd = isJs ? 'node' : 'python3'

    const proc = spawn(cmd, [entrypoint], {
      cwd: agentDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ORCHAGENT_LOCAL_EXECUTION: 'true' },
    })

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      stderr += text
      if (verbose) {
        process.stderr.write(chalk.gray(text))
      }
    })

    // Write input to stdin and close
    proc.stdin?.write(stdinData)
    proc.stdin?.end()

    proc.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr })
    })

    proc.on('error', (err) => {
      resolve({ code: 1, stdout, stderr: err.message })
    })
  })
}

/**
 * Run fixture tests for code_runtime agents by executing the entrypoint
 * with fixture input as stdin and validating the JSON output.
 * Same interface as E2B: python main.py < input.json
 */
async function runCodeRuntimeFixtureTests(
  agentDir: string,
  fixtures: string[],
  entrypoint: string,
  verbose: boolean
): Promise<number> {
  process.stderr.write(chalk.blue('\nRunning fixture tests (code runtime)...\n\n'))

  let passed = 0
  let failed = 0

  for (const fixturePath of fixtures) {
    const fixtureName = path.basename(fixturePath)
    const description = await getFixtureDescription(fixturePath)
    process.stderr.write(`  ${fixtureName}${description ? ` (${description})` : ''}: `)

    try {
      const raw = await fs.readFile(fixturePath, 'utf-8')
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (e) {
        throw new CliError(`Invalid JSON in ${fixtureName}: ${(e as Error).message}`)
      }
      const fixture = validateFixture(parsed, fixturePath)

      // Run entrypoint with fixture input as stdin (same as E2B: python main.py < input.json)
      const inputJson = JSON.stringify(fixture.input)
      const result = await runEntrypointWithInput(agentDir, entrypoint, inputJson, verbose)

      if (result.code !== 0) {
        throw new Error(
          `Entrypoint exited with code ${result.code}` +
          (result.stderr ? `\n    stderr: ${result.stderr.trim().split('\n').join('\n    stderr: ')}` : '')
        )
      }

      // Parse stdout as JSON
      const trimmedOutput = result.stdout.trim()
      let output: unknown
      try {
        output = JSON.parse(trimmedOutput)
      } catch {
        throw new Error(
          `Entrypoint output is not valid JSON.\n` +
          `    stdout: ${trimmedOutput.slice(0, 200)}${trimmedOutput.length > 200 ? '...' : ''}`
        )
      }

      // Validate result
      let testPassed = true
      const failures: string[] = []

      if (fixture.expected_output) {
        if (!deepEqual(output, fixture.expected_output)) {
          testPassed = false
          failures.push(
            `Expected: ${JSON.stringify(fixture.expected_output, null, 2)}\n` +
            `    Got: ${JSON.stringify(output, null, 2)}`
          )
        }
      }

      if (fixture.expected_contains) {
        const outputStr = JSON.stringify(output)
        for (const expected of fixture.expected_contains) {
          if (!outputStr.includes(expected)) {
            testPassed = false
            failures.push(`Expected output to contain: "${expected}"`)
          }
        }
      }

      if (testPassed) {
        process.stderr.write(chalk.green('PASS\n'))
        passed++
        if (verbose) {
          process.stderr.write(chalk.gray(`    Input: ${JSON.stringify(fixture.input)}\n`))
          process.stderr.write(chalk.gray(`    Output: ${JSON.stringify(output)}\n`))
        }
      } else {
        process.stderr.write(chalk.red('FAIL\n'))
        failed++
        for (const f of failures) {
          process.stderr.write(chalk.red(`    ${f}\n`))
        }
      }
    } catch (err) {
      process.stderr.write(chalk.red('ERROR\n'))
      failed++
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(chalk.red(`    ${message}\n`))
    }
  }

  process.stderr.write('\n')
  process.stderr.write(`Fixtures: ${passed} passed, ${failed} failed\n`)

  return failed > 0 ? 1 : 0
}

// ─── Agent type detection ────────────────────────────────────────────────────

async function detectAgentType(agentDir: string): Promise<AgentType> {
  // Check for SKILL.md first
  if (await fileExists(path.join(agentDir, 'SKILL.md'))) {
    return 'skill'
  }

  // Check for orchagent.json
  const manifestPath = path.join(agentDir, 'orchagent.json')
  if (await fileExists(manifestPath)) {
    try {
      const raw = await fs.readFile(manifestPath, 'utf-8')
      const manifest: AgentManifest = JSON.parse(raw)
      if (manifest.type === 'prompt') return 'prompt'
      if (manifest.type === 'skill') return 'skill'
      if (manifest.type === 'tool' || manifest.type === 'code') {
        if (await fileExists(path.join(agentDir, 'package.json'))) return 'code-js'
        return 'code-python'
      }
      if (manifest.type === 'agent' || manifest.type === 'agentic') {
        // Agent with runtime.command is code-based
        if (manifest.runtime?.command) {
          if (await fileExists(path.join(agentDir, 'package.json'))) return 'code-js'
          return 'code-python'
        }
        // Managed loop agent (uses prompt.md like prompt agents)
        return 'prompt'
      }
    } catch {
      // Invalid manifest, continue detection
    }
  }

  // Check for prompt.md (prompt agent)
  if (await fileExists(path.join(agentDir, 'prompt.md'))) {
    return 'prompt'
  }

  // Fallback: detect by file presence
  if (await fileExists(path.join(agentDir, 'requirements.txt'))) return 'code-python'
  if (await fileExists(path.join(agentDir, 'pyproject.toml'))) return 'code-python'
  if (await fileExists(path.join(agentDir, 'package.json'))) return 'code-js'

  return 'unknown'
}

// ─── Main test execution ─────────────────────────────────────────────────────

async function executeTests(
  agentDir: string,
  validation: AgentValidation,
  testFiles: TestFiles,
  verbose: boolean,
  config?: ResolvedConfig
): Promise<number> {
  let exitCode = 0

  const hasTests = testFiles.python.length > 0 ||
                   testFiles.javascript.length > 0 ||
                   testFiles.fixtures.length > 0

  if (!hasTests) {
    // Suggest appropriate test types based on agent
    process.stderr.write(chalk.yellow('No test files found.\n\n'))

    if (validation.executionEngine === 'code_runtime' && validation.entrypoint) {
      process.stderr.write('Create fixture tests to dry-run your code:\n')
      process.stderr.write(chalk.gray('  mkdir tests\n'))
      process.stderr.write(chalk.gray(`  # tests/fixture-basic.json — runs: ${validation.entrypoint} < input\n`))
      process.stderr.write(chalk.gray('  {\n'))
      process.stderr.write(chalk.gray('    "description": "Basic test",\n'))
      process.stderr.write(chalk.gray('    "input": {"key": "value"},\n'))
      process.stderr.write(chalk.gray('    "expected_contains": ["result"]\n'))
      process.stderr.write(chalk.gray('  }\n\n'))
      process.stderr.write('Or test interactively:\n')
      process.stderr.write(chalk.gray(`  orch run . --local --data '{"key": "value"}'\n\n`))
    } else if (validation.isSkill || validation.executionEngine === 'direct_llm' || validation.executionEngine === 'managed_loop') {
      process.stderr.write('Create fixture tests in tests/:\n')
      process.stderr.write(chalk.gray('  mkdir tests\n'))
      process.stderr.write(chalk.gray('  # tests/fixture-basic.json — calls LLM with your prompt + input\n'))
      process.stderr.write(chalk.gray('  {\n'))
      process.stderr.write(chalk.gray('    "description": "Basic test",\n'))
      process.stderr.write(chalk.gray('    "input": {"text": "Hello world"},\n'))
      process.stderr.write(chalk.gray('    "expected_contains": ["response"]\n'))
      process.stderr.write(chalk.gray('  }\n\n'))
      if (validation.executionEngine === 'managed_loop') {
        process.stderr.write('For orchestrators with sub-agents, add mocked fixtures:\n')
        process.stderr.write(chalk.gray('  # tests/fixture-mock-basic.json\n'))
        process.stderr.write(chalk.gray('  {\n'))
        process.stderr.write(chalk.gray('    "input": {"task": "..."},\n'))
        process.stderr.write(chalk.gray('    "mocks": {"tool_name": {"key": "mock response"}},\n'))
        process.stderr.write(chalk.gray('    "expected_contains": ["expected"]\n'))
        process.stderr.write(chalk.gray('  }\n\n'))
        process.stderr.write('Or test the full agent loop:\n')
        process.stderr.write(chalk.gray(`  orch run . --local --data '{"task": "..."}'\n\n`))
      }
    } else {
      process.stderr.write('Supported test file patterns:\n')
      process.stderr.write(chalk.gray('  Python: test_*.py, *_test.py, tests/test_*.py\n'))
      process.stderr.write(chalk.gray('  JS/TS:  *.test.ts, *.spec.ts, tests/*.test.ts\n'))
      process.stderr.write(chalk.gray('  Fixtures: tests/fixture-*.json\n\n'))
    }
    return 0 // Validation passed, no tests is OK
  }

  // Run Python tests if found
  if (testFiles.python.length > 0) {
    if (verbose) {
      process.stderr.write(chalk.gray(`Found ${testFiles.python.length} Python test file(s)\n`))
    }
    const code = await runPythonTests(agentDir, verbose)
    if (code !== 0) exitCode = 1
  }

  // Run JS/TS tests if found
  if (testFiles.javascript.length > 0) {
    if (verbose) {
      process.stderr.write(chalk.gray(`Found ${testFiles.javascript.length} JavaScript/TypeScript test file(s)\n`))
    }
    const code = await runJsTests(agentDir, verbose)
    if (code !== 0) exitCode = 1
  }

  // Run fixture tests — route by execution engine
  if (testFiles.fixtures.length > 0) {
    if (verbose) {
      process.stderr.write(chalk.gray(`Found ${testFiles.fixtures.length} fixture file(s)\n`))
    }

    if (validation.executionEngine === 'code_runtime' && validation.entrypoint) {
      const code = await runCodeRuntimeFixtureTests(agentDir, testFiles.fixtures, validation.entrypoint, verbose)
      if (code !== 0) exitCode = 1
    } else if (validation.executionEngine === 'managed_loop') {
      // For managed_loop agents, split fixtures: mocked vs regular
      const mockedFixtures: string[] = []
      const regularFixtures: string[] = []

      for (const fixturePath of testFiles.fixtures) {
        try {
          const raw = await fs.readFile(fixturePath, 'utf-8')
          const data = JSON.parse(raw)
          if (data.mocks && typeof data.mocks === 'object' && !Array.isArray(data.mocks)) {
            mockedFixtures.push(fixturePath)
          } else {
            regularFixtures.push(fixturePath)
          }
        } catch {
          regularFixtures.push(fixturePath) // Let downstream validation handle errors
        }
      }

      // Run mocked orchestration tests (full agent loop with mock sub-agents)
      if (mockedFixtures.length > 0) {
        try {
          const manifestPath = path.join(agentDir, 'orchagent.json')
          const manifestRaw = await fs.readFile(manifestPath, 'utf-8')
          const manifest: AgentManifest = JSON.parse(manifestRaw)
          const code = await runMockedAgentFixtureTests(agentDir, mockedFixtures, manifest, verbose, config)
          if (code !== 0) exitCode = 1
        } catch (err) {
          if (err instanceof CliError) throw err
          process.stderr.write(chalk.red(`  Error running mocked tests: ${(err as Error).message}\n`))
          exitCode = 1
        }
      }

      // Run regular (non-mocked) fixtures as LLM-based prompt tests
      if (regularFixtures.length > 0) {
        const code = await runPromptFixtureTests(agentDir, regularFixtures, verbose, config)
        if (code !== 0) exitCode = 1
      }
    } else {
      // Prompt, skill agents: LLM-based fixture tests
      const code = await runPromptFixtureTests(agentDir, testFiles.fixtures, verbose, config)
      if (code !== 0) exitCode = 1
    }
  }

  return exitCode
}

/**
 * Run validation + all tests in sequence
 */
async function runAllChecks(
  agentDir: string,
  verbose: boolean,
  config?: ResolvedConfig
): Promise<number> {
  // Load .env from agent directory (existing env vars take precedence)
  const dotEnvVars = await loadDotEnv(agentDir)
  const dotEnvCount = Object.keys(dotEnvVars).length
  if (dotEnvCount > 0) {
    for (const [key, value] of Object.entries(dotEnvVars)) {
      if (!(key in process.env) || process.env[key] === undefined) {
        process.env[key] = value
      }
    }
    process.stderr.write(chalk.gray(`Loaded ${dotEnvCount} variable${dotEnvCount === 1 ? '' : 's'} from .env\n`))
  }

  // Step 1: Validate
  const validation = await validateAgent(agentDir)
  const validationPassed = printValidation(validation)

  if (!validationPassed) {
    process.stderr.write(chalk.red('Fix validation errors above before publishing.\n'))
    return 1
  }

  // Step 2: Discover tests
  const testFiles = await discoverTests(agentDir)
  if (verbose) {
    const totalTests = testFiles.python.length + testFiles.javascript.length + testFiles.fixtures.length
    process.stderr.write(chalk.gray(`Discovered ${totalTests} test file(s)\n`))
  }

  // Step 3: Run tests
  return await executeTests(agentDir, validation, testFiles, verbose, config)
}

// ─── Watch mode ──────────────────────────────────────────────────────────────

async function watchTests(
  agentDir: string,
  verbose: boolean,
  config?: ResolvedConfig
): Promise<void> {
  process.stderr.write(chalk.cyan('\nWatching for file changes... (press Ctrl+C to exit)\n'))

  const runTests = async () => {
    process.stderr.write(chalk.dim(`\n[${new Date().toLocaleTimeString()}] Running checks...\n`))
    await runAllChecks(agentDir, verbose, config)
  }

  // Initial run
  await runTests()

  // Set up chokidar watcher
  let debounceTimer: NodeJS.Timeout | null = null

  const onChange = (filePath: string) => {
    if (debounceTimer) clearTimeout(debounceTimer)
    if (verbose) {
      process.stderr.write(chalk.dim(`  Changed: ${path.relative(agentDir, filePath)}\n`))
    }
    debounceTimer = setTimeout(runTests, 300)
  }

  const watcher = chokidar.watch(agentDir, {
    ignored: /(node_modules|__pycache__|\.git|dist|build|\.venv|venv)/,
    persistent: true,
    ignoreInitial: true,
  })

  watcher
    .on('change', onChange)
    .on('add', onChange)
    .on('unlink', onChange)
    .on('error', (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(chalk.red(`Watcher error: ${message}\n`))
    })

  // Keep process alive
  await new Promise(() => {})
}

// ─── Single run mode ─────────────────────────────────────────────────────────

/**
 * Validate, then run the agent once with the given input.
 * code_runtime: executes entrypoint with data as stdin.
 * direct_llm / managed_loop: calls LLM with prompt + data.
 */
async function runOnce(
  agentDir: string,
  dataJson: string,
  verbose: boolean,
  config?: ResolvedConfig
): Promise<number> {
  // Load .env from agent directory
  const dotEnvVars = await loadDotEnv(agentDir)
  const dotEnvCount = Object.keys(dotEnvVars).length
  if (dotEnvCount > 0) {
    for (const [key, value] of Object.entries(dotEnvVars)) {
      if (!(key in process.env) || process.env[key] === undefined) {
        process.env[key] = value
      }
    }
    process.stderr.write(chalk.gray(`Loaded ${dotEnvCount} variable${dotEnvCount === 1 ? '' : 's'} from .env\n`))
  }

  // Validate first
  const validation = await validateAgent(agentDir)
  const valid = printValidation(validation)
  if (!valid) {
    process.stderr.write(chalk.red('Fix validation errors before running.\n'))
    return 1
  }

  // Parse input
  let inputData: Record<string, unknown>
  try {
    inputData = JSON.parse(dataJson)
  } catch {
    throw new CliError(`Invalid JSON in --data: ${dataJson.slice(0, 100)}`)
  }

  if (validation.executionEngine === 'code_runtime' && validation.entrypoint) {
    // Run the entrypoint with data as stdin (same as E2B sandbox)
    process.stderr.write(`\nRunning: ${validation.entrypoint}\n\n`)

    const result = await runEntrypointWithInput(agentDir, validation.entrypoint, dataJson, verbose)

    // Show stderr if not already shown in verbose mode
    if (!verbose && result.stderr.trim()) {
      process.stderr.write(chalk.gray(result.stderr))
    }

    if (result.code !== 0) {
      process.stderr.write(chalk.red(`\nExited with code ${result.code}\n`))
      return 1
    }

    // Print stdout (the agent's JSON output)
    const trimmed = result.stdout.trim()
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed)
        printJson(parsed)
      } catch {
        // Not JSON — print raw
        process.stdout.write(trimmed + '\n')
      }
    }

    return 0
  }

  // Prompt / managed_loop: call LLM with prompt + input
  const promptPath = path.join(agentDir, 'prompt.md')
  const skillPath = path.join(agentDir, 'SKILL.md')
  let prompt: string

  const skillData = await parseSkillMd(skillPath)
  if (skillData) {
    prompt = skillData.body
  } else {
    try {
      prompt = await fs.readFile(promptPath, 'utf-8')
    } catch {
      throw new CliError('No prompt.md or SKILL.md found')
    }
  }

  // Read output schema if available
  let outputSchema: object | undefined
  try {
    const raw = await fs.readFile(path.join(agentDir, 'schema.json'), 'utf-8')
    const schemas = JSON.parse(raw)
    outputSchema = schemas.output
  } catch {
    // Optional
  }

  const detected = await detectLlmKey(['any'] as LlmProvider[], config)
  if (!detected) {
    throw new CliError(
      'No LLM key found.\n' +
      'Set an environment variable (e.g., OPENAI_API_KEY) or add one to .env'
    )
  }

  const { provider, key, model: serverModel } = detected
  const model = serverModel ?? getDefaultModel(provider)

  process.stderr.write(`\nRunning with ${provider} (${model})...\n\n`)

  const fullPrompt = buildPrompt(prompt, inputData)
  const result = await callLlm(provider, key, model, fullPrompt, outputSchema)

  printJson(result)
  return 0
}

// ─── Command registration ────────────────────────────────────────────────────

export function registerTestCommand(program: Command): void {
  program
    .command('test [path]')
    .description('Validate configuration and run test suite (fixtures + unit tests)')
    .option('-v, --verbose', 'Show detailed test output')
    .option('-w, --watch', 'Watch for file changes and re-run tests')
    .option('-r, --run', 'Run the agent once with --data input (validate first)')
    .option('-d, --data <json>', 'JSON input for --run mode')
    .option('--validate-only', 'Run validation only (skip test suite)')
    .addHelpText('after', `
Examples:
  orch test                    Validate + run tests in current directory
  orch test ./my-agent         Validate + run tests in specified directory
  orch test --verbose          Show detailed test output
  orch test --watch            Watch mode — re-run on file changes
  orch test --validate-only    Validation only (same as: orch validate)
  orch test --run --data '{"task": "hello"}'   Validate, then run once

What it does (default):
  1. Validates orchagent.json (type, engine, required files, secrets, etc.)
  2. Runs Python tests (pytest): test_*.py, *_test.py
  3. Runs JS/TS tests (vitest): *.test.ts, *.spec.ts
  4. Runs fixture tests: tests/fixture-*.json

When to use each command:
  orch validate             Quick validation before publishing (config only)
  orch test                 Full test suite (config + fixtures + unit tests)
  orch test --validate-only Same as validate (config only)

Fixture Format (tests/fixture-basic.json):
  {
    "description": "Test description",
    "input": {"key": "value"},
    "expected_output": {"result": "expected"},
    "expected_contains": ["substring"]
  }

  For code_runtime agents, fixtures run your entrypoint with input as stdin.
  For prompt/agent types, fixtures call the LLM with your prompt + input.

Mocked Orchestration Tests (tests/fixture-mock-*.json):
  For agent-type (managed_loop) orchestrators, add "mocks" to test the full
  agent loop with deterministic sub-agent responses:
  {
    "description": "Orchestrator handles scan results",
    "input": {"code": "import os"},
    "mocks": {
      "scan_secrets": {"findings": [{"type": "code_injection"}]},
      "scan_deps": {"vulnerabilities": []}
    },
    "expected_contains": ["code_injection"]
  }

  The LLM runs the full tool-use loop, but custom tool calls return mock
  responses instead of calling real sub-agents. Great for CI testing.

Run mode (--run):
  Validates the agent, then executes it once with the provided --data.
  Loads .env automatically. Same interface as: orch run . --local --data '...'
`)
    .action(async (
      agentPath: string | undefined,
      options: { verbose?: boolean; watch?: boolean; run?: boolean; data?: string; validateOnly?: boolean }
    ) => {
      const agentDir = agentPath
        ? path.resolve(process.cwd(), agentPath)
        : process.cwd()

      // Verify directory exists
      try {
        const stat = await fs.stat(agentDir)
        if (!stat.isDirectory()) {
          throw new CliError(`Not a directory: ${agentDir}`)
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new CliError(`Directory not found: ${agentDir}`)
        }
        throw err
      }

      // Get config for LLM access (needed for fixture tests and run mode)
      let config: ResolvedConfig | undefined
      try {
        config = await getResolvedConfig()
      } catch {
        // Config not available, fixture tests will use env vars only
      }

      // --validate-only flag: run validation then exit
      if (options.validateOnly) {
        const validation = await validateAgent(agentDir)
        const isValid = printValidation(validation)
        process.exit(isValid ? 0 : 1)
      }

      // Run mode: validate then execute once
      if (options.run) {
        if (!options.data) {
          throw new CliError(
            'Missing --data for run mode.\n\n' +
            `Usage: orch test --run --data '{"key": "value"}'`
          )
        }

        const exitCode = await runOnce(agentDir, options.data, !!options.verbose, config)
        process.exit(exitCode)
      }

      // Watch mode
      if (options.watch) {
        await watchTests(agentDir, !!options.verbose, config)
        return
      }

      // Single run: validate + tests
      const exitCode = await runAllChecks(agentDir, !!options.verbose, config)

      if (exitCode === 0) {
        process.stderr.write(chalk.green('\nAll checks passed.\n'))
      } else {
        process.stderr.write(chalk.red('\nSome checks failed.\n'))
      }

      process.exit(exitCode)
    })
}
