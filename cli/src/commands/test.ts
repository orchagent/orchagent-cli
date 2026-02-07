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
import { getResolvedConfig } from '../lib/config'
import {
  detectLlmKey,
  getDefaultModel,
  buildPrompt,
  callLlm,
  type LlmProvider,
} from '../lib/llm'
import type { AgentManifest, ResolvedConfig } from '../types'

/**
 * Agent type detected from file structure
 */
type AgentType = 'prompt' | 'code-python' | 'code-js' | 'skill' | 'unknown'

/**
 * Test file discovery result
 */
type TestFiles = {
  python: string[]
  javascript: string[]
  fixtures: string[]
}

/**
 * Fixture format for prompt agent testing
 */
type TestFixture = {
  input: Record<string, unknown>
  expected_output?: Record<string, unknown>
  expected_contains?: string[]
  description?: string
}

/**
 * Validate a fixture and return helpful errors
 */
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

/**
 * Skill frontmatter format
 */
interface SkillFrontmatter {
  name: string
  description: string
}

/**
 * Parse SKILL.md frontmatter
 */
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
 * Run a command and return the result
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

/**
 * Check if a command exists
 */
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

/**
 * Check if a file exists
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Detect the agent type from the directory structure
 */
async function detectAgentType(agentDir: string): Promise<AgentType> {
  // Check for SKILL.md first
  if (await fileExists(path.join(agentDir, 'SKILL.md'))) {
    return 'skill'
  }

  // Check for prompt.md (prompt agent)
  if (await fileExists(path.join(agentDir, 'prompt.md'))) {
    return 'prompt'
  }

  // Check for orchagent.json
  const manifestPath = path.join(agentDir, 'orchagent.json')
  if (await fileExists(manifestPath)) {
    try {
      const raw = await fs.readFile(manifestPath, 'utf-8')
      const manifest: AgentManifest = JSON.parse(raw)
      if (manifest.type === 'prompt') return 'prompt'
      if (manifest.type === 'skill') return 'skill'
      if (manifest.type === 'tool') {
        // Detect language
        if (await fileExists(path.join(agentDir, 'requirements.txt'))) return 'code-python'
        if (await fileExists(path.join(agentDir, 'pyproject.toml'))) return 'code-python'
        if (await fileExists(path.join(agentDir, 'package.json'))) return 'code-js'
        // Default to Python for tool agents
        return 'code-python'
      }
    } catch {
      // Invalid manifest, continue detection
    }
  }

  // Fallback: detect by file presence
  if (await fileExists(path.join(agentDir, 'requirements.txt'))) return 'code-python'
  if (await fileExists(path.join(agentDir, 'pyproject.toml'))) return 'code-python'
  if (await fileExists(path.join(agentDir, 'package.json'))) return 'code-js'

  return 'unknown'
}

/**
 * Recursively walk a directory and return all files
 */
async function walkDir(dir: string, files: string[] = []): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      // Skip common non-source directories
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

/**
 * Discover test files in the agent directory
 */
async function discoverTests(agentDir: string): Promise<TestFiles> {
  const result: TestFiles = {
    python: [],
    javascript: [],
    fixtures: [],
  }

  // Get all files recursively
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

    // Fixture patterns: tests/fixture*.json or fixture*.json in tests/ subdirs
    if (basename.endsWith('.json') && basename.startsWith('fixture')) {
      if (relPath.includes('tests' + path.sep) || relPath.startsWith('tests' + path.sep)) {
        result.fixtures.push(file)
      }
    }
  }

  return result
}

/**
 * Run Python tests using pytest
 */
async function runPythonTests(agentDir: string, verbose: boolean): Promise<number> {
  process.stderr.write(chalk.blue('\nRunning Python tests...\n\n'))

  // Check if pytest is available directly
  const hasPytest = await commandExists('pytest')

  if (hasPytest) {
    const args = verbose ? ['-v'] : []
    const { code } = await runCommand('pytest', args, agentDir, verbose)
    return code
  }

  // Try Python commands in order of preference
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

/**
 * Run JavaScript/TypeScript tests
 */
async function runJsTests(agentDir: string, verbose: boolean): Promise<number> {
  process.stderr.write(chalk.blue('\nRunning JavaScript/TypeScript tests...\n\n'))

  // Check for vitest first
  const hasVitest = await fileExists(path.join(agentDir, 'node_modules', '.bin', 'vitest'))

  if (hasVitest) {
    const args = ['run']
    if (verbose) args.push('--reporter=verbose')
    const { code } = await runCommand('npx', ['vitest', ...args], agentDir, verbose)
    return code
  }

  // Fall back to npm test
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
 * Run fixture-based tests for prompt agents
 */
async function runFixtureTests(
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

  // Check if this is a skill
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
      'Set an environment variable (e.g., OPENAI_API_KEY) or run `orchagent keys add <provider>`'
    )
  }

  const { provider, key, model: serverModel } = detected
  const model = serverModel ?? getDefaultModel(provider)

  let passed = 0
  let failed = 0

  for (const fixturePath of fixtures) {
    const fixtureName = path.basename(fixturePath)
    process.stderr.write(`  ${fixtureName}: `)

    try {
      const raw = await fs.readFile(fixturePath, 'utf-8')
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (e) {
        throw new CliError(`Invalid JSON in ${path.basename(fixturePath)}: ${(e as Error).message}`)
      }
      const fixture = validateFixture(parsed, fixturePath)

      // Build and call LLM
      const fullPrompt = buildPrompt(prompt, fixture.input)
      const result = await callLlm(provider, key, model, fullPrompt, outputSchema)

      // Validate result
      let testPassed = true
      const failures: string[] = []

      if (fixture.expected_output) {
        if (!deepEqual(result, fixture.expected_output)) {
          testPassed = false
          failures.push(`Expected: ${JSON.stringify(fixture.expected_output, null, 2)}\nGot: ${JSON.stringify(result, null, 2)}`)
        }
      }

      if (fixture.expected_contains) {
        // Check if output contains expected strings
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

/**
 * Watch mode: re-run tests on file changes
 */
async function watchTests(
  agentDir: string,
  agentType: AgentType,
  verbose: boolean,
  config?: ResolvedConfig
): Promise<void> {
  process.stderr.write(chalk.cyan('\nWatching for file changes... (press Ctrl+C to exit)\n\n'))

  const runTests = async () => {
    process.stderr.write(chalk.dim(`\n[${new Date().toLocaleTimeString()}] Running tests...\n`))
    // Re-discover tests each time to pick up new files
    const testFiles = await discoverTests(agentDir)
    await executeTests(agentDir, agentType, testFiles, verbose, config)
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

/**
 * Execute tests based on agent type and discovered test files
 */
async function executeTests(
  agentDir: string,
  agentType: AgentType,
  testFiles: TestFiles,
  verbose: boolean,
  config?: ResolvedConfig
): Promise<number> {
  let exitCode = 0

  // Run tests based on what's available
  const hasTests = testFiles.python.length > 0 ||
                   testFiles.javascript.length > 0 ||
                   testFiles.fixtures.length > 0

  if (!hasTests) {
    // For prompt agents/skills, suggest creating fixtures
    if (agentType === 'prompt' || agentType === 'skill') {
      process.stderr.write(chalk.yellow('No test files found.\n\n'))
      process.stderr.write('For prompt agents, create fixture files in tests/:\n')
      process.stderr.write(chalk.gray('  tests/fixture-1.json:\n'))
      process.stderr.write(chalk.gray('  {\n'))
      process.stderr.write(chalk.gray('    "input": {"text": "Hello world"},\n'))
      process.stderr.write(chalk.gray('    "expected_contains": ["response"]\n'))
      process.stderr.write(chalk.gray('  }\n\n'))
    } else {
      process.stderr.write(chalk.yellow('No test files found.\n\n'))
      process.stderr.write('Supported test file patterns:\n')
      process.stderr.write(chalk.gray('  Python: test_*.py, *_test.py, tests/test_*.py\n'))
      process.stderr.write(chalk.gray('  JS/TS:  *.test.ts, *.spec.ts, tests/*.test.ts\n'))
      process.stderr.write(chalk.gray('  Fixtures: tests/fixture-*.json\n\n'))
    }
    return 1
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

  // Run fixture tests if found (for prompt agents)
  if (testFiles.fixtures.length > 0) {
    if (verbose) {
      process.stderr.write(chalk.gray(`Found ${testFiles.fixtures.length} fixture file(s)\n`))
    }
    const code = await runFixtureTests(agentDir, testFiles.fixtures, verbose, config)
    if (code !== 0) exitCode = 1
  }

  return exitCode
}

export function registerTestCommand(program: Command): void {
  program
    .command('test [path]')
    .description('Run agent test suite locally')
    .option('-v, --verbose', 'Show detailed test output')
    .option('-w, --watch', 'Watch for file changes and re-run tests')
    .addHelpText('after', `
Examples:
  orch test                    Run tests in current directory
  orch test ./my-agent         Run tests in specified directory
  orch test --verbose          Show detailed test output
  orch test --watch            Watch mode - re-run on file changes

Test Discovery:
  Python:   test_*.py, *_test.py, tests/test_*.py, tests/*_test.py
  JS/TS:    *.test.ts, *.test.js, *.spec.ts, *.spec.js, tests/*.test.*
  Fixtures: tests/fixture-*.json (for prompt agents)

Fixture Format (tests/fixture-1.json):
  {
    "input": {"key": "value"},
    "expected_output": {"result": "expected"},
    "expected_contains": ["substring"],
    "description": "Test description"
  }
`)
    .action(async (
      agentPath: string | undefined,
      options: { verbose?: boolean; watch?: boolean }
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

      // Detect agent type
      const agentType = await detectAgentType(agentDir)
      if (options.verbose) {
        process.stderr.write(chalk.gray(`Detected agent type: ${agentType}\n`))
      }

      // Discover test files
      const testFiles = await discoverTests(agentDir)
      if (options.verbose) {
        const totalTests = testFiles.python.length + testFiles.javascript.length + testFiles.fixtures.length
        process.stderr.write(chalk.gray(`Discovered ${totalTests} test file(s)\n`))
      }

      // Get config for LLM access (needed for fixture tests)
      let config: ResolvedConfig | undefined
      try {
        config = await getResolvedConfig()
      } catch {
        // Config not available, fixture tests will use env vars only
      }

      // Watch mode
      if (options.watch) {
        await watchTests(agentDir, agentType, !!options.verbose, config)
        return
      }

      // Run tests
      const exitCode = await executeTests(agentDir, agentType, testFiles, !!options.verbose, config)

      if (exitCode === 0) {
        process.stderr.write(chalk.green('\nAll tests passed.\n'))
      } else {
        process.stderr.write(chalk.red('\nSome tests failed.\n'))
      }

      process.exit(exitCode)
    })
}
