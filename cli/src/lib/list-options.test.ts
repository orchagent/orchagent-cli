import { describe, it, expect } from 'vitest'
import { parseFields, filterFields, applyLimitOffset, parseIntOption } from './list-options'

// ============================================
// parseFields
// ============================================

describe('parseFields', () => {
  it('parses comma-separated field names', () => {
    expect(parseFields('name,version,type')).toEqual(['name', 'version', 'type'])
  })

  it('trims whitespace around field names', () => {
    expect(parseFields(' name , version , type ')).toEqual(['name', 'version', 'type'])
  })

  it('removes empty entries from trailing commas', () => {
    expect(parseFields('name,version,')).toEqual(['name', 'version'])
  })

  it('removes empty entries from leading commas', () => {
    expect(parseFields(',name,version')).toEqual(['name', 'version'])
  })

  it('handles single field', () => {
    expect(parseFields('name')).toEqual(['name'])
  })

  it('handles empty string', () => {
    expect(parseFields('')).toEqual([])
  })

  it('handles only commas', () => {
    expect(parseFields(',,,')).toEqual([])
  })

  it('preserves field names with underscores', () => {
    expect(parseFields('agent_name,cost_cents,duration_ms')).toEqual([
      'agent_name', 'cost_cents', 'duration_ms',
    ])
  })
})

// ============================================
// filterFields
// ============================================

describe('filterFields', () => {
  describe('with arrays', () => {
    it('filters each object in the array to specified keys', () => {
      const data = [
        { name: 'scanner', version: 'v1', type: 'tool', description: 'Scans code' },
        { name: 'reviewer', version: 'v2', type: 'agent', description: 'Reviews code' },
      ]
      const result = filterFields(data, ['name', 'version'])
      expect(result).toEqual([
        { name: 'scanner', version: 'v1' },
        { name: 'reviewer', version: 'v2' },
      ])
    })

    it('ignores fields that do not exist on objects', () => {
      const data = [{ name: 'scanner', version: 'v1' }]
      const result = filterFields(data, ['name', 'nonexistent'])
      expect(result).toEqual([{ name: 'scanner' }])
    })

    it('returns empty objects when no fields match', () => {
      const data = [{ name: 'scanner' }]
      const result = filterFields(data, ['missing'])
      expect(result).toEqual([{}])
    })

    it('handles empty array', () => {
      expect(filterFields([], ['name'])).toEqual([])
    })

    it('passes through non-object array items unchanged', () => {
      const data = ['a', 'b', 'c']
      expect(filterFields(data, ['name'])).toEqual(['a', 'b', 'c'])
    })

    it('handles mixed array (objects and primitives)', () => {
      const data = [{ name: 'a', extra: 1 }, 42, { name: 'b', extra: 2 }]
      const result = filterFields(data, ['name'])
      expect(result).toEqual([{ name: 'a' }, 42, { name: 'b' }])
    })

    it('preserves null values in selected fields', () => {
      const data = [{ name: 'x', error: null, status: 'ok' }]
      const result = filterFields(data, ['name', 'error'])
      expect(result).toEqual([{ name: 'x', error: null }])
    })

    it('preserves nested objects in selected fields', () => {
      const data = [{ name: 'x', config: { timeout: 30 } }]
      const result = filterFields(data, ['name', 'config'])
      expect(result).toEqual([{ name: 'x', config: { timeout: 30 } }])
    })
  })

  describe('with single objects', () => {
    it('filters keys of a single object', () => {
      const data = { name: 'scanner', version: 'v1', type: 'tool' }
      const result = filterFields(data, ['name', 'type'])
      expect(result).toEqual({ name: 'scanner', type: 'tool' })
    })

    it('ignores non-existent fields on objects', () => {
      const data = { name: 'scanner' }
      const result = filterFields(data, ['name', 'bogus'])
      expect(result).toEqual({ name: 'scanner' })
    })

    it('returns empty object when no fields match', () => {
      const data = { name: 'scanner' }
      const result = filterFields(data, ['bogus'])
      expect(result).toEqual({})
    })
  })

  describe('with primitives', () => {
    it('returns strings unchanged', () => {
      expect(filterFields('hello', ['name'])).toBe('hello')
    })

    it('returns numbers unchanged', () => {
      expect(filterFields(42, ['name'])).toBe(42)
    })

    it('returns null unchanged', () => {
      expect(filterFields(null, ['name'])).toBe(null)
    })

    it('returns undefined unchanged', () => {
      expect(filterFields(undefined, ['name'])).toBe(undefined)
    })

    it('returns booleans unchanged', () => {
      expect(filterFields(true, ['name'])).toBe(true)
    })
  })

  describe('does not mutate input', () => {
    it('does not modify the original array', () => {
      const original = [{ name: 'a', extra: 1 }]
      const copy = JSON.parse(JSON.stringify(original))
      filterFields(original, ['name'])
      expect(original).toEqual(copy)
    })

    it('does not modify the original object', () => {
      const original = { name: 'a', extra: 1 }
      const copy = { ...original }
      filterFields(original, ['name'])
      expect(original).toEqual(copy)
    })
  })
})

// ============================================
// applyLimitOffset
// ============================================

describe('applyLimitOffset', () => {
  const items = ['a', 'b', 'c', 'd', 'e']

  it('returns all items when no limit or offset', () => {
    expect(applyLimitOffset(items)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('limits items from the start', () => {
    expect(applyLimitOffset(items, 3)).toEqual(['a', 'b', 'c'])
  })

  it('limits to zero returns empty array', () => {
    expect(applyLimitOffset(items, 0)).toEqual([])
  })

  it('limit greater than array length returns all items', () => {
    expect(applyLimitOffset(items, 100)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('offset skips items from the start', () => {
    expect(applyLimitOffset(items, undefined, 2)).toEqual(['c', 'd', 'e'])
  })

  it('offset greater than array length returns empty', () => {
    expect(applyLimitOffset(items, undefined, 100)).toEqual([])
  })

  it('combines limit and offset', () => {
    expect(applyLimitOffset(items, 2, 1)).toEqual(['b', 'c'])
  })

  it('offset + limit beyond array end returns remaining items', () => {
    expect(applyLimitOffset(items, 10, 3)).toEqual(['d', 'e'])
  })

  it('does not mutate the input array', () => {
    const original = [1, 2, 3]
    const copy = [...original]
    applyLimitOffset(original, 2, 1)
    expect(original).toEqual(copy)
  })

  it('handles empty array', () => {
    expect(applyLimitOffset([], 5, 0)).toEqual([])
  })
})

// ============================================
// parseIntOption
// ============================================

describe('parseIntOption', () => {
  it('parses valid integer string', () => {
    expect(parseIntOption('42')).toBe(42)
  })

  it('parses zero', () => {
    expect(parseIntOption('0')).toBe(0)
  })

  it('returns undefined for undefined input', () => {
    expect(parseIntOption(undefined)).toBeUndefined()
  })

  it('returns undefined for NaN input', () => {
    expect(parseIntOption('abc')).toBeUndefined()
  })

  it('parses negative numbers', () => {
    expect(parseIntOption('-5')).toBe(-5)
  })

  it('truncates floats to integer', () => {
    expect(parseIntOption('3.7')).toBe(3)
  })
})
