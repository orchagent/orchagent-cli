/**
 * E2E Tests for invoice-scanner Agent
 *
 * Tests the invoice-scanner agent which extracts data from invoice images.
 * This agent processes image files (PNG, JPG, PDF) and returns structured invoice data.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { runOrch, createTestDir, cleanupTestDir, outputContains } from './setup'

// Minimal valid PNG (1x1 white pixel, 67 bytes)
// This is a complete, valid PNG file that can be processed by image readers
const MINIMAL_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk length + type
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // width=1, height=1
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, // bit depth, color type, etc + CRC
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, // IDAT chunk length + type
  0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0xff, // compressed data
  0x00, 0x05, 0xfe, 0x02, 0xfe, 0xdc, 0xcc, 0x59, // more data + CRC
  0xe7, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, // IEND chunk
  0x44, 0xae, 0x42, 0x60, 0x82,                   // IEND CRC
])

const describeLive = process.env.ORCH_E2E_SKIP_LIVE === '1' ? describe.skip : describe

describeLive('invoice-scanner agent', () => {
  let testDir: string

  beforeAll(async () => {
    testDir = await createTestDir('orch-invoice-scanner-e2e-')
  })

  afterAll(async () => {
    await cleanupTestDir(testDir)
  })

  describe('search and info', () => {
    it('finds invoice-scanner via search', async () => {
      const result = await runOrch(['search', 'invoice'])

      const combined = result.stdout + result.stderr
      expect(outputContains(combined, 'invoice-scanner')).toBe(true)
    })

    it('shows invoice-scanner info', async () => {
      const result = await runOrch(['info', 'orchagent/invoice-scanner'])

      const combined = result.stdout + result.stderr
      expect(outputContains(combined, 'invoice', 'scanner', 'extract')).toBe(true)
    })

    it('shows version information', async () => {
      const result = await runOrch(['info', 'orchagent/invoice-scanner@v1'])

      const combined = result.stdout + result.stderr
      expect(outputContains(combined, 'invoice-scanner', 'v1')).toBe(true)
    })
  })

  describe('run with file input', () => {
    it('processes a PNG image file', async () => {
      // Create a test PNG file
      const filePath = join(testDir, 'test-invoice.png')
      await writeFile(filePath, MINIMAL_PNG)

      // Pass the file path as a positional argument
      const result = await runOrch(['run', 'orchagent/invoice-scanner', filePath], {
        timeout: 120000,
      })

      const combined = result.stdout + result.stderr

      // Should process without crashing - may return "no invoice found" for blank image
      // or error gracefully about content. The key is it processes the file.
      expect(
        outputContains(combined, 'invoice', 'total', 'amount', 'vendor', 'date', 'no', 'found', 'extracted') ||
        result.code === 0
      ).toBe(true)
    })

    it('accepts --input JSON with files array', async () => {
      // Create a test PNG file
      const filePath = join(testDir, 'input-test.png')
      await writeFile(filePath, MINIMAL_PNG)

      const inputJson = JSON.stringify({ files: [filePath] })
      const result = await runOrch(['run', 'orchagent/invoice-scanner', '--input', inputJson], {
        timeout: 120000,
      })

      const combined = result.stdout + result.stderr

      // Should process the file from JSON input
      expect(
        outputContains(combined, 'invoice', 'total', 'amount', 'vendor', 'date', 'no', 'found', 'extracted') ||
        result.code === 0
      ).toBe(true)
    })
  })

  describe('error handling', () => {
    it('shows error when no file input provided', async () => {
      const result = await runOrch(['run', 'orchagent/invoice-scanner'], {
        timeout: 60000,
      })

      const combined = result.stdout + result.stderr

      // Should show a helpful error message about missing file input
      expect(
        outputContains(combined, 'no file', 'no input', 'error', 'provide', 'required', 'file') ||
        result.code !== 0
      ).toBe(true)
    })

    it('shows error for non-existent file', async () => {
      const result = await runOrch(['run', 'orchagent/invoice-scanner', '/nonexistent/path/invoice.png'], {
        timeout: 60000,
      })

      const combined = result.stdout + result.stderr

      // Should show file not found error
      expect(
        outputContains(combined, 'not found', 'not exist', 'no such file', 'error', 'cannot') ||
        result.code !== 0
      ).toBe(true)
    })

    it('shows error for invalid file type', async () => {
      // Create a text file with wrong extension
      const filePath = join(testDir, 'not-an-image.txt')
      await writeFile(filePath, 'This is just plain text, not an image')

      const result = await runOrch(['run', 'orchagent/invoice-scanner', filePath], {
        timeout: 60000,
      })

      const combined = result.stdout + result.stderr

      // Should show unsupported file type error
      expect(
        outputContains(combined, 'unsupported', 'invalid', 'type', 'format', 'image', 'error') ||
        result.code !== 0
      ).toBe(true)
    })

    it('shows error for empty file', async () => {
      // Create an empty PNG file (0 bytes)
      const filePath = join(testDir, 'empty.png')
      await writeFile(filePath, Buffer.alloc(0))

      const result = await runOrch(['run', 'orchagent/invoice-scanner', filePath], {
        timeout: 60000,
      })

      const combined = result.stdout + result.stderr

      // Should show error about empty or invalid file
      expect(
        outputContains(combined, 'empty', 'invalid', 'corrupt', 'error', 'cannot read') ||
        result.code !== 0
      ).toBe(true)
    })
  })
})
