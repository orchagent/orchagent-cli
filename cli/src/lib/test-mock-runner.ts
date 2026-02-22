/**
 * Mock Agent Runner — executes managed_loop agents with mocked sub-agent responses.
 *
 * Used by `orch test` to test orchestration chains in CI without live sub-agents.
 * The LLM still runs the full tool-use loop, but custom tool calls return
 * deterministic mock responses instead of calling real sub-agents.
 */

import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { spawn } from 'child_process'
import chalk from 'chalk'
import deepEqual from 'fast-deep-equal'

import { CliError } from './errors'
import {
  detectLlmKey,
  getDefaultModel,
  PROVIDER_ENV_VARS,
  type LlmProvider,
} from './llm'
import type { ResolvedConfig, AgentManifest } from '../types'

// ─── Types ───────────────────────────────────────────────────────────────────

export type MockMap = Record<string, unknown>

export type MockedFixture = {
  input: Record<string, unknown>
  mocks: MockMap
  expected_output?: Record<string, unknown>
  expected_contains?: string[]
  description?: string
}

type MockRunResult = {
  exitCode: number
  stdout: string
  stderr: string
}

// SDK packages needed by agent_runner.py per provider
const SDK_PACKAGES: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  gemini: 'google-genai',
}

// ─── Validation ──────────────────────────────────────────────────────────────

export function validateMockedFixture(
  data: unknown,
  fixturePath: string,
  customToolNames: string[]
): MockedFixture {
  const fileName = path.basename(fixturePath)

  if (typeof data !== 'object' || data === null) {
    throw new CliError(`Invalid fixture ${fileName}: must be a JSON object`)
  }

  const obj = data as Record<string, unknown>

  if (!obj.input || typeof obj.input !== 'object') {
    throw new CliError(
      `Invalid fixture ${fileName}: missing required "input" field`
    )
  }

  if (!obj.mocks || typeof obj.mocks !== 'object' || Array.isArray(obj.mocks)) {
    throw new CliError(
      `Invalid fixture ${fileName}: "mocks" must be an object mapping tool names to responses`
    )
  }

  if (!obj.expected_output && !obj.expected_contains) {
    throw new CliError(
      `Invalid fixture ${fileName}: must have "expected_output" or "expected_contains"`
    )
  }

  // Warn about mock keys that don't match any custom tool
  const mockKeys = Object.keys(obj.mocks as Record<string, unknown>)
  const unknownMocks = mockKeys.filter(k => !customToolNames.includes(k))
  if (unknownMocks.length > 0) {
    process.stderr.write(
      chalk.yellow(`  Warning: ${fileName} mocks unknown tool(s): ${unknownMocks.join(', ')}\n`)
    )
  }

  return data as MockedFixture
}

// ─── Runner ──────────────────────────────────────────────────────────────────

function runCommand(
  command: string,
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    })
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    proc.on('error', (err) => resolve({ code: 1, stdout, stderr: err.message }))
  })
}

async function runAgentWithMocks(
  tempDir: string,
  env: Record<string, string | undefined>,
  maxTurns: number,
  verbose: boolean
): Promise<MockRunResult> {
  return new Promise((resolve) => {
    const args = [
      'agent_runner.py',
      '--max-turns', String(maxTurns),
      '--mock-tools', 'mock_tools.json',
    ]
    if (verbose) args.push('--verbose')

    const proc = spawn('python3', args, {
      cwd: tempDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    })

    proc.stdin.end()

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      stderr += text
      if (verbose) {
        // Filter out heartbeat dots and orchagent events
        for (const line of text.split('\n')) {
          if (line.startsWith('@@ORCHAGENT_EVENT:')) continue
          if (line.trim() === '.' || line.trim() === '') continue
          process.stderr.write(chalk.gray(`    ${line}\n`))
        }
      }
    })

    proc.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr })
    })

    proc.on('error', (err) => {
      resolve({ exitCode: 1, stdout, stderr: err.message })
    })
  })
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function runMockedAgentFixtureTests(
  agentDir: string,
  fixtures: string[],
  manifest: AgentManifest,
  verbose: boolean,
  config?: ResolvedConfig
): Promise<number> {
  process.stderr.write(chalk.blue('\nRunning mocked orchestration tests...\n\n'))

  // Read prompt.md
  let prompt: string
  try {
    prompt = await fs.readFile(path.join(agentDir, 'prompt.md'), 'utf-8')
  } catch {
    throw new CliError('prompt.md not found (required for mocked orchestration tests)')
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

  // Get custom tools from manifest
  const customTools: object[] =
    (manifest.loop as Record<string, unknown>)?.custom_tools as object[] ||
    manifest.custom_tools as object[] ||
    []

  const customToolNames = customTools.map(
    (t) => (t as Record<string, unknown>).name as string
  )

  if (customTools.length === 0) {
    process.stderr.write(
      chalk.yellow('  Warning: No custom_tools defined — mocks will have no effect\n\n')
    )
  }

  // Detect LLM key
  const supportedProviders = (manifest.supported_providers || ['any']) as LlmProvider[]
  const detected = await detectLlmKey(supportedProviders, config)
  if (!detected) {
    throw new CliError(
      'No LLM key found for mocked orchestration tests.\n' +
      'Set an environment variable (e.g., ANTHROPIC_API_KEY) or run `orch secrets set <PROVIDER>_API_KEY <key>`'
    )
  }

  const { provider, key, model: serverModel } = detected
  const model = serverModel ?? getDefaultModel(provider)
  const apiKeyEnvVar = PROVIDER_ENV_VARS[provider]

  // Check Python 3 available
  try {
    const { code } = await runCommand('python3', ['--version'])
    if (code !== 0) throw new Error()
  } catch {
    throw new CliError(
      'Python 3 is required for mocked orchestration tests.\n' +
      'Install Python 3: https://python.org/downloads'
    )
  }

  // Check LLM SDK installed
  const sdkPackage = SDK_PACKAGES[provider] || 'anthropic'
  const sdkImportName = provider === 'gemini' ? 'google.genai' : sdkPackage
  try {
    const { code } = await runCommand('python3', ['-c', `import ${sdkImportName}`])
    if (code !== 0) {
      process.stderr.write(`  Installing ${sdkPackage} Python SDK...\n`)
      const install = await runCommand('python3', ['-m', 'pip', 'install', '-q', sdkPackage])
      if (install.code !== 0) {
        throw new CliError(`Failed to install ${sdkPackage} SDK. Install manually: pip install ${sdkPackage}`)
      }
    }
  } catch (err) {
    if (err instanceof CliError) throw err
    throw new CliError(`Failed to check Python SDK: ${err}`)
  }

  // Find agent_runner.py
  const runnerPaths = [
    path.join(__dirname, '..', 'resources', 'agent_runner.py'),
    path.join(__dirname, '..', '..', 'src', 'resources', 'agent_runner.py'),
  ]
  let runnerContent: string | undefined
  for (const p of runnerPaths) {
    try {
      runnerContent = await fs.readFile(p, 'utf-8')
      break
    } catch {
      continue
    }
  }
  if (!runnerContent) {
    throw new CliError(
      'Agent runner script not found. Reinstall the CLI: npm install -g @orchagent/cli'
    )
  }

  const maxTurns = manifest.max_turns ??
    (manifest.loop as Record<string, unknown>)?.max_turns as number ?? 25

  process.stderr.write(`  Provider: ${provider} (${model})\n`)
  process.stderr.write(`  Custom tools: ${customToolNames.join(', ') || '(none)'}\n`)
  process.stderr.write(`  Max turns: ${maxTurns}\n\n`)

  let passed = 0
  let failed = 0

  for (const fixturePath of fixtures) {
    const fixtureName = path.basename(fixturePath)
    const raw = await fs.readFile(fixturePath, 'utf-8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      process.stderr.write(chalk.red(`  ${fixtureName}: ERROR\n`))
      process.stderr.write(chalk.red(`    Invalid JSON: ${(e as Error).message}\n`))
      failed++
      continue
    }

    const desc = (parsed as Record<string, unknown>).description as string | undefined
    process.stderr.write(`  ${fixtureName}${desc ? ` (${desc})` : ''}: `)

    let fixture: MockedFixture
    try {
      fixture = validateMockedFixture(parsed, fixturePath, customToolNames)
    } catch (err) {
      process.stderr.write(chalk.red('ERROR\n'))
      process.stderr.write(chalk.red(`    ${(err as Error).message}\n`))
      failed++
      continue
    }

    // Create temp dir for this fixture
    const tempDir = path.join(os.tmpdir(), `orchagent-mock-test-${Date.now()}`)
    await fs.mkdir(tempDir, { recursive: true })

    try {
      // Write all files the agent runner needs
      await Promise.all([
        fs.writeFile(path.join(tempDir, 'agent_runner.py'), runnerContent),
        fs.writeFile(path.join(tempDir, 'prompt.md'), prompt),
        fs.writeFile(path.join(tempDir, 'input.json'), JSON.stringify(fixture.input, null, 2)),
        fs.writeFile(path.join(tempDir, 'mock_tools.json'), JSON.stringify(fixture.mocks)),
        customTools.length > 0
          ? fs.writeFile(path.join(tempDir, 'custom_tools.json'), JSON.stringify(customTools))
          : Promise.resolve(),
        outputSchema
          ? fs.writeFile(path.join(tempDir, 'output_schema.json'), JSON.stringify(outputSchema))
          : Promise.resolve(),
      ])

      // Build env
      const subprocessEnv: Record<string, string | undefined> = { ...process.env }
      subprocessEnv.LOCAL_MODE = '1'
      subprocessEnv.LLM_PROVIDER = provider
      subprocessEnv.LLM_MODEL = model
      if (apiKeyEnvVar && key) {
        subprocessEnv[apiKeyEnvVar] = key
      }

      // Run the agent loop with mocked tools
      const result = await runAgentWithMocks(tempDir, subprocessEnv, maxTurns, verbose)

      if (result.exitCode !== 0 || !result.stdout.trim()) {
        process.stderr.write(chalk.red('ERROR\n'))
        if (result.stdout.trim()) {
          try {
            const errJson = JSON.parse(result.stdout.trim())
            if (errJson.error) {
              process.stderr.write(chalk.red(`    ${errJson.error}\n`))
            }
          } catch {
            process.stderr.write(chalk.red(`    Agent exited with code ${result.exitCode}\n`))
          }
        } else {
          process.stderr.write(chalk.red(`    Agent exited with code ${result.exitCode} (no output)\n`))
        }
        failed++
        continue
      }

      // Parse output
      let output: unknown
      try {
        output = JSON.parse(result.stdout.trim())
      } catch {
        process.stderr.write(chalk.red('ERROR\n'))
        process.stderr.write(chalk.red(`    Agent output is not valid JSON\n`))
        if (verbose) {
          process.stderr.write(chalk.gray(`    stdout: ${result.stdout.trim().slice(0, 200)}\n`))
        }
        failed++
        continue
      }

      // Validate against expectations
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
    } finally {
      try {
        await fs.rm(tempDir, { recursive: true, force: true })
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  process.stderr.write('\n')
  process.stderr.write(`Mocked orchestration tests: ${passed} passed, ${failed} failed\n`)

  return failed > 0 ? 1 : 0
}
