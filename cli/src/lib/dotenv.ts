import fs from 'fs/promises'
import path from 'path'

/**
 * Parse a .env file into key-value pairs.
 * Handles: comments (#), blank lines, KEY=VALUE, single/double quoted values.
 * Does NOT support multiline values or variable expansion.
 */
export function parseDotEnv(content: string): Record<string, string> {
  const vars: Record<string, string> = {}

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const eqIndex = line.indexOf('=')
    if (eqIndex === -1) continue

    const key = line.slice(0, eqIndex).trim()
    if (!key) continue

    let value = line.slice(eqIndex + 1).trim()

    // Strip matching quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    vars[key] = value
  }

  return vars
}

/**
 * Load .env file from a directory. Returns the parsed vars (empty object if no file).
 * Does NOT modify process.env — caller decides how to merge.
 */
export async function loadDotEnv(dir: string): Promise<Record<string, string>> {
  const envPath = path.join(dir, '.env')
  try {
    const content = await fs.readFile(envPath, 'utf-8')
    return parseDotEnv(content)
  } catch {
    return {}
  }
}

/**
 * Merge .env vars into an env object. Existing keys take precedence
 * (process.env wins over .env file, matching standard dotenv behaviour).
 */
export function mergeEnv(
  base: Record<string, string | undefined>,
  dotEnvVars: Record<string, string>
): Record<string, string | undefined> {
  const merged = { ...base }
  for (const [key, value] of Object.entries(dotEnvVars)) {
    if (!(key in merged) || merged[key] === undefined) {
      merged[key] = value
    }
  }
  return merged
}
