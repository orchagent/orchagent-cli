/**
 * Tests for config command validation.
 * Covers UX-14: empty value rejection with hint to use `config unset`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock fs/promises before importing config
vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    chmod: vi.fn(),
  },
}))

// Mock the adapters module
vi.mock('../adapters', () => ({
  adapterRegistry: {
    getIds: () => ['claude-code', 'cursor'],
  },
}))

import { setConfigValue } from './config'

describe('setConfigValue — empty value hint (UX-14)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('rejects empty string for default-provider with unset hint', async () => {
    await expect(setConfigValue('default-provider', '')).rejects.toThrow(
      'orch config unset default-provider'
    )
  })

  it('rejects whitespace-only string for default-provider with unset hint', async () => {
    await expect(setConfigValue('default-provider', '  ')).rejects.toThrow(
      'orch config unset default-provider'
    )
  })

  it('rejects empty string for default-scope with unset hint', async () => {
    await expect(setConfigValue('default-scope', '')).rejects.toThrow(
      'orch config unset default-scope'
    )
  })

  it('rejects empty string for default-format with unset hint', async () => {
    await expect(setConfigValue('default-format', '')).rejects.toThrow(
      'orch config unset default-format'
    )
  })

  it('still rejects invalid (non-empty) provider values normally', async () => {
    await expect(setConfigValue('default-provider', 'badprovider')).rejects.toThrow(
      'Invalid provider'
    )
  })

  it('still rejects unknown config keys', async () => {
    await expect(setConfigValue('nonexistent', 'value')).rejects.toThrow(
      'Unknown config key'
    )
  })
})
