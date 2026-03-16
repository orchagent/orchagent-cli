export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

/** Global JSON-mode flag — set by the preAction hook when --json is active. */
let _jsonMode = false

export function setJsonMode(enabled: boolean): void {
  _jsonMode = enabled
}

export function isJsonMode(): boolean {
  return _jsonMode
}

/**
 * Determine if the CLI should auto-switch to JSON output.
 *
 * Priority (highest wins):
 * 1. Explicit --json flag on the command → true (handled by Commander, not here)
 * 2. ORCHAGENT_OUTPUT=json env var → true
 * 3. ORCHAGENT_OUTPUT=text env var → false (override non-TTY auto-detection)
 * 4. stdout is not a TTY (piped, redirected, or run by an agent) → true
 * 5. stdout is a TTY (human terminal) → false
 */
export function shouldAutoJson(): boolean {
  const outputEnv = process.env.ORCHAGENT_OUTPUT?.toLowerCase()
  if (outputEnv === 'json') return true
  if (outputEnv === 'text') return false
  return !process.stdout.isTTY
}
