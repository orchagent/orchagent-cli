import { defineConfig } from 'vitest/config'

/**
 * Vitest configuration for E2E tests.
 *
 * These tests run real CLI commands against the actual API.
 * They are slower than unit tests and should be run separately.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    // E2E tests need longer timeouts for agent execution
    // security-review orchestrates multiple agents (leak-finder, dep-scanner)
    // and its manifest declares timeout_ms: 180000
    testTimeout: 180000,
    hookTimeout: 30000,
    // Run tests serially to avoid rate limiting
    sequence: {
      concurrent: false,
    },
    // Reduce noise in output
    reporters: ['verbose'],
  },
})
