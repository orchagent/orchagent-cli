/**
 * Tests for security scan report formatting.
 *
 * Covers BUG-3: the gateway returns nested objects for by_severity/by_category
 * ({total, leaked}) but the CLI originally expected flat numbers, causing
 * empty report sections.
 */

import { describe, it, expect } from 'vitest'
import { extractCount } from './security'

describe('extractCount', () => {
  it('handles a flat number', () => {
    expect(extractCount(5)).toBe(5)
  })

  it('handles zero', () => {
    expect(extractCount(0)).toBe(0)
  })

  it('extracts leaked from nested object', () => {
    expect(extractCount({ total: 3, leaked: 2 })).toBe(2)
  })

  it('returns 0 for nested object with no leaks', () => {
    expect(extractCount({ total: 5, leaked: 0 })).toBe(0)
  })

  it('handles nested object where all attacks leaked', () => {
    expect(extractCount({ total: 10, leaked: 10 })).toBe(10)
  })
})
