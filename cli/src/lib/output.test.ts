import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { shouldAutoJson, setJsonMode, isJsonMode } from './output'

describe('shouldAutoJson', () => {
  const originalIsTTY = process.stdout.isTTY
  const originalEnv = process.env.ORCHAGENT_OUTPUT

  beforeEach(() => {
    delete process.env.ORCHAGENT_OUTPUT
  })

  afterEach(() => {
    process.stdout.isTTY = originalIsTTY
    if (originalEnv === undefined) {
      delete process.env.ORCHAGENT_OUTPUT
    } else {
      process.env.ORCHAGENT_OUTPUT = originalEnv
    }
  })

  it('returns false when stdout is a TTY (human terminal)', () => {
    process.stdout.isTTY = true
    expect(shouldAutoJson()).toBe(false)
  })

  it('returns true when stdout is not a TTY (piped/redirected)', () => {
    process.stdout.isTTY = undefined as unknown as boolean
    expect(shouldAutoJson()).toBe(true)
  })

  it('returns true when ORCHAGENT_OUTPUT=json regardless of TTY', () => {
    process.stdout.isTTY = true
    process.env.ORCHAGENT_OUTPUT = 'json'
    expect(shouldAutoJson()).toBe(true)
  })

  it('returns true when ORCHAGENT_OUTPUT=JSON (case-insensitive)', () => {
    process.stdout.isTTY = true
    process.env.ORCHAGENT_OUTPUT = 'JSON'
    expect(shouldAutoJson()).toBe(true)
  })

  it('returns false when ORCHAGENT_OUTPUT=text even in non-TTY', () => {
    process.stdout.isTTY = undefined as unknown as boolean
    process.env.ORCHAGENT_OUTPUT = 'text'
    expect(shouldAutoJson()).toBe(false)
  })

  it('returns false when ORCHAGENT_OUTPUT=text in TTY', () => {
    process.stdout.isTTY = true
    process.env.ORCHAGENT_OUTPUT = 'text'
    expect(shouldAutoJson()).toBe(false)
  })
})

describe('setJsonMode / isJsonMode', () => {
  afterEach(() => {
    setJsonMode(false)
  })

  it('defaults to false', () => {
    expect(isJsonMode()).toBe(false)
  })

  it('returns true after setJsonMode(true)', () => {
    setJsonMode(true)
    expect(isJsonMode()).toBe(true)
  })

  it('returns false after setJsonMode(false)', () => {
    setJsonMode(true)
    setJsonMode(false)
    expect(isJsonMode()).toBe(false)
  })
})
