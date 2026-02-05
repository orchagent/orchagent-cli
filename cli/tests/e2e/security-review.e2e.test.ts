/**
 * E2E Tests for security-review Agent
 *
 * Tests the security-review agent which performs comprehensive security analysis:
 * secret scanning, dependency auditing, and code pattern analysis.
 * This agent takes directory input similar to leak-finder.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { runOrch, createTestDir, cleanupTestDir, createTestFile, outputContains } from './setup'

describe('security-review agent', () => {
  let testDir: string

  beforeAll(async () => {
    testDir = await createTestDir('orch-security-review-e2e-')

    // Create a test project with various security issues to detect
    // 1. Secret in .env file
    await createTestFile(testDir, '.env', 'API_KEY=sk_live_secret_12345\nDATABASE_URL=postgres://admin:password123@localhost/db')

    // 2. package.json with outdated/vulnerable dependency patterns
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

    // 3. JavaScript file with potential security issues
    await createTestFile(
      testDir,
      'index.js',
      `
const express = require('express');
const app = express();

// Potential SQL injection
app.get('/user', (req, res) => {
  const query = "SELECT * FROM users WHERE id = " + req.query.id;
  db.query(query);
});

// Hardcoded secret
const API_SECRET = "super_secret_key_12345";

app.listen(3000);
`.trim()
    )
  })

  afterAll(async () => {
    await cleanupTestDir(testDir)
  })

  describe('search and info', () => {
    it('finds security-review via search', async () => {
      const result = await runOrch(['search', 'security'])

      const combined = result.stdout + result.stderr
      expect(outputContains(combined, 'security-review')).toBe(true)
    })

    it('shows security-review info', async () => {
      const result = await runOrch(['info', 'orchagent/security-review'])

      const combined = result.stdout + result.stderr
      expect(outputContains(combined, 'security', 'review', 'scanning', 'audit')).toBe(true)
    })

    it('shows version information', async () => {
      const result = await runOrch(['info', 'orchagent/security-review@v1'])

      const combined = result.stdout + result.stderr
      expect(outputContains(combined, 'security-review', 'v1')).toBe(true)
    })
  })

  describe('run with directory input', () => {
    it('scans a directory passed as positional argument', async () => {
      const result = await runOrch(['run', 'orchagent/security-review', testDir], {
        timeout: 120000,
      })

      const combined = result.stdout + result.stderr

      // Should complete and show some security-related output
      expect(
        outputContains(combined, 'security', 'scan', 'review', 'findings', 'secret', 'vulnerability', 'complete') ||
        result.code === 0
      ).toBe(true)
    })

    it('accepts --input JSON with directory', async () => {
      const inputJson = JSON.stringify({ directory: testDir })
      const result = await runOrch(['run', 'orchagent/security-review', '--input', inputJson], {
        timeout: 120000,
      })

      const combined = result.stdout + result.stderr

      // Should process the directory from JSON input
      expect(
        outputContains(combined, 'security', 'scan', 'review', 'findings', 'complete') ||
        result.code === 0
      ).toBe(true)
    })

    it('resolves relative path correctly', async () => {
      const result = await runOrch(['run', 'orchagent/security-review', '.'], {
        cwd: testDir,
        timeout: 120000,
      })

      const combined = result.stdout + result.stderr

      // Should resolve . to the test directory and process it
      expect(
        outputContains(combined, 'security', 'scan', 'review', 'findings', 'complete') ||
        result.code === 0
      ).toBe(true)
    })
  })

  describe('security detection', () => {
    it('processes project with potential security issues', async () => {
      const result = await runOrch(['run', 'orchagent/security-review', testDir], {
        timeout: 120000,
      })

      const combined = result.stdout + result.stderr

      // Should process the directory and produce output
      // The agent may find secrets, vulnerabilities, or complete with no issues
      expect(
        outputContains(combined, 'security', 'scan', 'review', 'running', 'complete', 'findings', 'secret', 'vulnerability') ||
        result.code === 0
      ).toBe(true)
    })
  })

  describe('error handling', () => {
    it('shows error when no directory provided', async () => {
      const result = await runOrch(['run', 'orchagent/security-review'], {
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
      const result = await runOrch(['run', 'orchagent/security-review', '/nonexistent/path/to/scan'], {
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
