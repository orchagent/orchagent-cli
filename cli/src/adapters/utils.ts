/**
 * Shared utilities for format adapters
 */

/**
 * Convert agent name to valid format (lowercase + hyphens only).
 * Used for filenames and identifiers across all adapters.
 */
export function normalizeAgentName(name: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return normalized || 'agent' // Fallback if empty
}

/**
 * Map Anthropic model names to Claude Code aliases.
 */
export function mapModelToAlias(model?: string): string {
  if (!model) return 'inherit'
  const lower = model.toLowerCase()
  if (lower.includes('opus')) return 'opus'
  if (lower.includes('haiku')) return 'haiku'
  // Default to sonnet for any Claude model
  if (lower.includes('claude') || lower.includes('sonnet')) return 'sonnet'
  return 'inherit'
}
