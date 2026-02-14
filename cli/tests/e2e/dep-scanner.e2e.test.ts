/**
 * E2E Tests for dep-scanner Agent
 *
 * Tests the dep-scanner agent which scans project dependencies for known
 * vulnerabilities (CVEs). Runs npm audit, pip-audit, and similar tools.
 * This agent takes directory input similar to leak-finder.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { runOrch, createTestDir, cleanupTestDir, createTestFile, outputContains } from './setup'

const describeLive = process.env.ORCH_E2E_SKIP_LIVE === '1' ? describe.skip : describe

describeLive('dep-scanner agent', () => {
  let testDir: string

  beforeAll(async () => {
    testDir = await createTestDir('orch-dep-scanner-e2e-')

    // Create a test project with dependencies to scan
    // package.json with some dependencies
    await createTestFile(
      testDir,
      'package.json',
      JSON.stringify(
        {
          name: 'test-project',
          version: '1.0.0',
          dependencies: {
            lodash: '^4.17.0',
            express: '^4.17.1',
          },
        },
        null,
        2
      )
    )

    // requirements.txt for Python dependencies
    await createTestFile(
      testDir,
      'requirements.txt',
      'requests==2.25.0\nflask==1.1.2\n'
    )
  })

  afterAll(async () => {
    await cleanupTestDir(testDir)
  })

  describe('search and info', () => {
    it('finds dep-scanner via search', async () => {
      const result = await runOrch(['search', 'dep'])

      const combined = result.stdout + result.stderr
      expect(outputContains(combined, 'dep-scanner')).toBe(true)
    })

    it('shows dep-scanner info', async () => {
      const result = await runOrch(['info', 'orchagent/dep-scanner'])

      const combined = result.stdout + result.stderr
      expect(outputContains(combined, 'dep', 'scanner', 'dependencies', 'vulnerabilities', 'CVE')).toBe(true)
    })

    it('shows version information', async () => {
      const result = await runOrch(['info', 'orchagent/dep-scanner@v1'])

      const combined = result.stdout + result.stderr
      expect(outputContains(combined, 'dep-scanner', 'v1')).toBe(true)
    })
  })

  describe('run with directory input', () => {
    it('scans a directory passed as positional argument', async () => {
      const result = await runOrch(['run', 'orchagent/dep-scanner', testDir], {
        timeout: 120000,
      })

      const combined = result.stdout + result.stderr

      // Should complete and show dependency-related output
      expect(
        outputContains(combined, 'dependencies', 'scan', 'audit', 'vulnerabilities', 'packages', 'complete') ||
        result.code === 0
      ).toBe(true)
    })

    it('accepts --input JSON with directory', async () => {
      const inputJson = JSON.stringify({ directory: testDir })
      const result = await runOrch(['run', 'orchagent/dep-scanner', '--input', inputJson], {
        timeout: 120000,
      })

      const combined = result.stdout + result.stderr

      // Should process the directory from JSON input
      expect(
        outputContains(combined, 'dependencies', 'scan', 'audit', 'complete') ||
        result.code === 0
      ).toBe(true)
    })

    it('resolves relative path correctly', async () => {
      const result = await runOrch(['run', 'orchagent/dep-scanner', '.'], {
        cwd: testDir,
        timeout: 120000,
      })

      const combined = result.stdout + result.stderr

      // Should resolve . to the test directory and process it
      expect(
        outputContains(combined, 'dependencies', 'scan', 'audit', 'complete') ||
        result.code === 0
      ).toBe(true)
    })
  })

  describe('dependency detection', () => {
    it('processes project with package.json', async () => {
      const result = await runOrch(['run', 'orchagent/dep-scanner', testDir], {
        timeout: 120000,
      })

      const combined = result.stdout + result.stderr

      // Should detect and process the package.json
      expect(
        outputContains(combined, 'npm', 'package', 'dependencies', 'lodash', 'express', 'audit') ||
        outputContains(combined, 'scan', 'complete')
      ).toBe(true)
    })
  })

  describe('error handling', () => {
    it('shows error when no directory provided', async () => {
      const result = await runOrch(['run', 'orchagent/dep-scanner'], {
        timeout: 60000,
      })

      const combined = result.stdout + result.stderr

      // Should show a helpful error message about missing directory input
      expect(
        outputContains(combined, 'no directory', 'no input', 'error', 'provide', 'required', 'directory') ||
        result.code !== 0
      ).toBe(true)
    })

    it('shows error for non-existent directory', async () => {
      const result = await runOrch(['run', 'orchagent/dep-scanner', '/nonexistent/path/to/scan'], {
        timeout: 60000,
      })

      const combined = result.stdout + result.stderr

      // Should show directory not found error
      expect(
        outputContains(combined, 'not found', 'not exist', 'no such', 'error', 'cannot') ||
        result.code !== 0
      ).toBe(true)
    })
  })
})
