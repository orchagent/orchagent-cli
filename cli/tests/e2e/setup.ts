/**
 * E2E Test Setup and Utilities
 *
 * Provides helper functions for running real CLI commands in tests.
 * These tests execute the actual orch CLI binary, simulating real user behavior.
 */

import { spawn } from 'child_process'
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Run the orch CLI command with given arguments.
 * Uses the built dist/index.js directly for faster execution during development.
 */
export async function runOrch(
  args: string[],
  options: {
    cwd?: string
    timeout?: number
    stdin?: string
  } = {}
): Promise<CommandResult> {
  const { cwd = process.cwd(), timeout = 60000, stdin } = options

  return new Promise((resolve) => {
    // Use node to run the built CLI directly
    const cliPath = join(__dirname, '../../dist/index.js')
    const proc = spawn('node', [cliPath, ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    let stdout = ''
    let stderr = ''
    let resolved = false

    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true
        proc.kill('SIGKILL')
        resolve({
          code: -1,
          stdout,
          stderr: stderr + '\n[TIMEOUT]',
        })
      }
    }, timeout)

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    if (stdin) {
      proc.stdin.write(stdin)
      proc.stdin.end()
    }

    proc.on('close', (code) => {
      if (!resolved) {
        resolved = true
        clearTimeout(timeoutId)
        resolve({
          code: code ?? 1,
          stdout,
          stderr,
        })
      }
    })

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true
        clearTimeout(timeoutId)
        resolve({
          code: -1,
          stdout,
          stderr: err.message,
        })
      }
    })
  })
}

/**
 * Create a temporary test directory.
 * Returns the path to the directory.
 */
export async function createTestDir(prefix = 'orch-e2e-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

/**
 * Clean up a test directory.
 */
export async function cleanupTestDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true })
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Create a test file in a directory.
 */
export async function createTestFile(
  dir: string,
  filename: string,
  content: string
): Promise<string> {
  const filePath = join(dir, filename)
  const fileDir = join(dir, filename.split('/').slice(0, -1).join('/'))
  if (fileDir !== dir) {
    await mkdir(fileDir, { recursive: true })
  }
  await writeFile(filePath, content)
  return filePath
}

/**
 * Create a test project with common files for leak-finder testing.
 */
export async function createTestProject(dir: string): Promise<void> {
  // Create a .env file with a fake secret
  await createTestFile(dir, '.env', 'API_KEY=sk_test_secret_12345\nDATABASE_URL=postgres://user:pass@localhost/db')

  // Create a simple JS file
  await createTestFile(dir, 'index.js', 'console.log("Hello world")')

  // Create a package.json
  await createTestFile(
    dir,
    'package.json',
    JSON.stringify({ name: 'test-project', version: '1.0.0' }, null, 2)
  )
}

/**
 * Check if output contains any of the given patterns (case insensitive).
 */
export function outputContains(output: string, ...patterns: string[]): boolean {
  const lowerOutput = output.toLowerCase()
  return patterns.some((pattern) => lowerOutput.includes(pattern.toLowerCase()))
}

/**
 * Check if output matches a regex pattern.
 */
export function outputMatches(output: string, pattern: RegExp): boolean {
  return pattern.test(output)
}
