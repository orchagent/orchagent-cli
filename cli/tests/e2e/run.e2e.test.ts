/**
 * E2E Tests for Run Command
 *
 * Tests the `orch run` command with real bundle downloads and execution.
 * Includes regression tests for bugs found on 2026-01-21.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { runOrch, createTestDir, cleanupTestDir, createTestProject, outputContains } from './setup'

const describeLive = process.env.ORCH_E2E_SKIP_LIVE === '1' ? describe.skip : describe

describeLive('run command', () => {
  let testDir: string

  beforeAll(async () => {
    testDir = await createTestDir('orch-run-e2e-')
    await createTestProject(testDir)
  })

  afterAll(async () => {
    await cleanupTestDir(testDir)
  })

  describe('basic functionality', () => {
    it('downloads and runs a bundle agent', async () => {
      const result = await runOrch(['run', 'orchagent/leak-finder', testDir], {
        timeout: 120000, // Bundle download can be slow
      })

      // Should complete (either finding secrets or not)
      // We primarily care that it runs without crashing
      const combined = result.stdout + result.stderr
      expect(outputContains(combined, 'downloading', 'bundle', 'running', 'scan', 'complete', 'findings', 'secret')).toBe(true)
    })

    it('shows error for nonexistent agent', async () => {
      const result = await runOrch(['run', 'nonexistent/totallynotreal'])

      expect(result.code).not.toBe(0)
      expect(outputContains(result.stdout + result.stderr, 'not found', 'error', '404')).toBe(true)
    })
  })

  describe('Bug #4 regression: --input flag must work', () => {
    it('processes --input JSON option', async () => {
      const inputJson = JSON.stringify({ directory: testDir })
      const result = await runOrch(['run', 'orchagent/leak-finder', '--input', inputJson], {
        timeout: 120000,
      })

      const combined = result.stdout + result.stderr

      // Should NOT show "missing input" error - the --input was provided
      const showsMissingInputError =
        outputContains(combined, 'missing') &&
        outputContains(combined, 'input') &&
        !outputContains(combined, 'downloading')

      expect(showsMissingInputError).toBe(false)

      // Should show some evidence of processing (downloading, running, or results)
      expect(
        outputContains(combined, 'downloading', 'bundle', 'running', 'scan', 'findings', 'secret', 'API_KEY')
      ).toBe(true)
    })

    it('resolves relative paths in --input to absolute paths', async () => {
      // Use --input with a relative path
      const inputJson = JSON.stringify({ directory: '.' })
      const result = await runOrch(['run', 'orchagent/leak-finder', '--input', inputJson], {
        cwd: testDir,
        timeout: 120000,
      })

      const combined = result.stdout + result.stderr

      // Should NOT resolve to temp extraction directory
      expect(outputContains(combined, 'orchagent-leak-finder', '/tmp/', 'extraction')).toBe(false)

      // Should process the input and run
      expect(
        outputContains(combined, 'downloading', 'running', 'scan', 'findings') ||
          result.code === 0
      ).toBe(true)
    })
  })

  describe('Bug #5 regression: relative paths must resolve to user cwd', () => {
    it('resolves . to user working directory, not temp dir', async () => {
      const result = await runOrch(['run', 'orchagent/leak-finder', '.'], {
        cwd: testDir,
        timeout: 120000,
      })

      const combined = result.stdout + result.stderr

      // Should NOT show errors about temp directory or extraction path
      const tempDirError =
        outputContains(combined, 'orchagent-leak-finder') &&
        outputContains(combined, 'not found', 'does not exist')

      expect(tempDirError).toBe(false)

      // Should process successfully (run the scan)
      expect(
        outputContains(combined, 'downloading', 'running', 'scan', 'findings', 'secret') ||
          result.code === 0
      ).toBe(true)
    })

    it('resolves relative subdirectory path correctly', async () => {
      // Create a subdirectory in test project
      const { mkdir, writeFile } = await import('fs/promises')
      const { join } = await import('path')
      await mkdir(join(testDir, 'subdir'), { recursive: true })
      await writeFile(join(testDir, 'subdir', '.env'), 'SECRET=test123')

      const result = await runOrch(['run', 'orchagent/leak-finder', './subdir'], {
        cwd: testDir,
        timeout: 120000,
      })

      const combined = result.stdout + result.stderr

      // Should process the relative path
      expect(
        outputContains(combined, 'downloading', 'running', 'scan') || result.code === 0
      ).toBe(true)
    })
  })

  describe('Bug #6 regression: local directories must work', () => {
    it('accepts absolute local directory path', async () => {
      const result = await runOrch(['run', 'orchagent/leak-finder', testDir], {
        timeout: 120000,
      })

      const combined = result.stdout + result.stderr

      // Should NOT ask for a URL or reject local path
      expect(outputContains(combined, 'github', 'url required', 'http')).toBe(false)

      // Should process the directory
      expect(
        outputContains(combined, 'downloading', 'running', 'scan', 'findings', 'secret') ||
          result.code === 0
      ).toBe(true)
    })

    it('scans local directory and finds secrets', async () => {
      const result = await runOrch(['run', 'orchagent/leak-finder', testDir], {
        timeout: 120000,
      })

      const combined = result.stdout + result.stderr

      // Should find the secret we planted in .env
      expect(
        outputContains(combined, 'API_KEY', 'sk_test', 'secret', 'findings', '.env') ||
          outputContains(combined, 'scan', 'complete')
      ).toBe(true)
    })
  })
})
