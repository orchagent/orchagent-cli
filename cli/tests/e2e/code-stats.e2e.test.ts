/**
 * E2E Tests for code-stats Agent
 *
 * Tests the code-stats agent which analyzes code for quality metrics.
 * This agent uses a different input pattern (code/files) compared to leak-finder (directory).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { runOrch, createTestDir, cleanupTestDir, createTestFile, outputContains } from './setup'

const describeLive = process.env.ORCH_E2E_SKIP_LIVE === '1' ? describe.skip : describe

describeLive('code-stats agent', () => {
  let testDir: string

  beforeAll(async () => {
    testDir = await createTestDir('orch-code-stats-e2e-')
  })

  afterAll(async () => {
    await cleanupTestDir(testDir)
  })

  describe('search and info', () => {
    it('finds code-stats via search', async () => {
      const result = await runOrch(['search', 'code-stats'])

      const combined = result.stdout + result.stderr
      expect(outputContains(combined, 'code-stats')).toBe(true)
    })

    it('shows code-stats info', async () => {
      const result = await runOrch(['info', 'orchagent/code-stats'])

      const combined = result.stdout + result.stderr
      expect(outputContains(combined, 'code', 'quality', 'metrics', 'lines', 'functions')).toBe(true)
    })
  })

  describe('run with legacy code input', () => {
    it('analyzes Python code passed via --input', async () => {
      const pythonCode = `
def hello():
    print("Hello world")

def calculate_sum(a, b):
    return a + b

class Calculator:
    def add(self, x, y):
        return x + y
`.trim()

      const inputJson = JSON.stringify({ code: pythonCode, language: 'python' })
      const result = await runOrch(['run', 'orchagent/code-stats', '--input', inputJson], {
        timeout: 120000,
      })

      const combined = result.stdout + result.stderr

      // Should show metrics
      expect(outputContains(combined, 'metrics', 'functions', 'lines')).toBe(true)

      // Should detect functions
      expect(outputContains(combined, 'hello', 'calculate_sum') || outputContains(combined, 'function')).toBe(true)
    })

    it('analyzes JavaScript code', async () => {
      const jsCode = `
function greet(name) {
  console.log("Hello " + name);
}

const add = (a, b) => a + b;

class Greeter {
  sayHi() {
    console.log("Hi!");
  }
}
`.trim()

      const inputJson = JSON.stringify({ code: jsCode, language: 'javascript' })
      const result = await runOrch(['run', 'orchagent/code-stats', '--input', inputJson], {
        timeout: 120000,
      })

      const combined = result.stdout + result.stderr
      expect(outputContains(combined, 'metrics', 'lines')).toBe(true)
    })

    it('auto-detects language when not specified', async () => {
      const pythonCode = `
def main():
    x = 10
    print(x)

if __name__ == "__main__":
    main()
`.trim()

      const inputJson = JSON.stringify({ code: pythonCode })
      const result = await runOrch(['run', 'orchagent/code-stats', '--input', inputJson], {
        timeout: 120000,
      })

      const combined = result.stdout + result.stderr

      // Should detect Python and show metrics
      expect(outputContains(combined, 'python', 'metrics') || outputContains(combined, 'function', 'lines')).toBe(true)
    })
  })

  describe('run with file input', () => {
    it('analyzes a Python file passed as argument', async () => {
      // Create a test Python file
      const pythonContent = `
def process_data(items):
    """Process a list of items."""
    results = []
    for item in items:
        results.append(item * 2)
    return results

class DataProcessor:
    def __init__(self):
        self.data = []

    def load(self, path):
        pass

    def save(self, path):
        pass
`.trim()

      const filePath = await createTestFile(testDir, 'processor.py', pythonContent)

      // Pass the file path as a positional argument
      const result = await runOrch(['run', 'orchagent/code-stats', filePath], {
        timeout: 120000,
      })

      const combined = result.stdout + result.stderr

      // Should complete without error and show some output
      // The CLI reads the file and passes it to the agent
      expect(
        outputContains(combined, 'metrics', 'functions', 'lines', 'summary') ||
        result.code === 0
      ).toBe(true)
    })
  })

  describe('error handling', () => {
    it('shows error when no input provided', async () => {
      const result = await runOrch(['run', 'orchagent/code-stats'], {
        timeout: 60000,
      })

      const combined = result.stdout + result.stderr

      // Should show a helpful error message, not crash
      expect(
        outputContains(combined, 'no code', 'no input', 'error', 'provide', 'files') ||
        result.code !== 0
      ).toBe(true)
    })

    it('handles invalid JSON input gracefully', async () => {
      const result = await runOrch(['run', 'orchagent/code-stats', '--input', 'not-valid-json'], {
        timeout: 60000,
      })

      expect(result.code).not.toBe(0)
      expect(outputContains(result.stdout + result.stderr, 'invalid', 'json', 'error')).toBe(true)
    })
  })

  describe('warnings generation', () => {
    it('generates warnings for long functions', async () => {
      // Create code with a long function (>50 lines)
      const lines = ['def very_long_function():']
      for (let i = 0; i < 60; i++) {
        lines.push(`    x${i} = ${i}`)
      }
      lines.push('    return x59')

      const longCode = lines.join('\n')
      const inputJson = JSON.stringify({
        code: longCode,
        language: 'python',
        max_function_lines: 50,
      })

      const result = await runOrch(['run', 'orchagent/code-stats', '--input', inputJson], {
        timeout: 120000,
      })

      const combined = result.stdout + result.stderr

      // Should generate a warning about function length
      expect(
        outputContains(combined, 'warning', 'exceeds', 'lines', 'very_long_function') ||
        outputContains(combined, 'warnings')
      ).toBe(true)
    })
  })
})
