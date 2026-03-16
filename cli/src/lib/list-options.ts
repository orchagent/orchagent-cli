/**
 * Shared utilities for --fields, --limit, and --offset on list commands.
 *
 * --fields: client-side JSON key filtering (implies --json output)
 * --limit / --offset: pagination (passed to API where supported, applied client-side as fallback)
 */

/**
 * Parse a comma-separated fields string into an array of field names.
 * Trims whitespace and removes empty entries.
 */
export function parseFields(fieldsStr: string): string[] {
  return fieldsStr.split(',').map(f => f.trim()).filter(Boolean)
}

/**
 * Filter an object or array of objects to include only specified fields.
 *
 * - Array of objects: filter each object's keys
 * - Single object: filter top-level keys
 * - Primitives: return as-is
 */
export function filterFields(data: unknown, fields: string[]): unknown {
  if (Array.isArray(data)) {
    return data.map(item =>
      item !== null && typeof item === 'object'
        ? pickKeys(item as Record<string, unknown>, fields)
        : item
    )
  }
  if (data !== null && typeof data === 'object') {
    return pickKeys(data as Record<string, unknown>, fields)
  }
  return data
}

function pickKeys(obj: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const field of fields) {
    if (field in obj) {
      result[field] = obj[field]
    }
  }
  return result
}

/**
 * Apply client-side limit and offset to an array.
 * Returns a new array (never mutates the input).
 */
export function applyLimitOffset<T>(items: T[], limit?: number, offset?: number): T[] {
  const start = offset ?? 0
  if (limit != null) {
    return items.slice(start, start + limit)
  }
  if (start > 0) {
    return items.slice(start)
  }
  return items
}

/**
 * Parse a string number option, returning undefined if invalid or absent.
 */
export function parseIntOption(value: string | undefined): number | undefined {
  if (value == null) return undefined
  const n = parseInt(value, 10)
  return isNaN(n) ? undefined : n
}
