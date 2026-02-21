import * as Sentry from '@sentry/node'
import { shutdownPostHog } from './analytics'
import { ApiError } from './api'

export class CliError extends Error {
  exitCode: number
  cause?: Error
  responseBody?: unknown
  /** When true, exitWithError skips printing — the message was already shown (e.g. via spinner.fail). */
  displayed?: boolean

  constructor(message: string, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

export function formatError(err: unknown): string {
  if (err instanceof CliError) {
    return err.message
  }

  if (err instanceof Error) {
    const anyErr = err as Error & { status?: number; payload?: unknown }
    if (anyErr.status && anyErr.payload) {
      const p = anyErr.payload as { error?: { code?: string; detail?: string }; detail?: string }
      const code = p.error?.code
      const detail = p.error?.detail || p.detail
      let msg = `${anyErr.message} (status ${anyErr.status}${code ? `, ${code}` : ''})`
      if (detail) msg += `\n${detail}`
      return msg
    }
    return anyErr.message
  }

  return String(err)
}

export async function exitWithError(err: unknown): Promise<never> {
  const message = formatError(err)

  // Report to Sentry if it's a real error (not a CliError which is expected)
  if (!(err instanceof CliError) && process.env.SENTRY_DSN) {
    Sentry.captureException(err)
  }

  // Flush PostHog before exiting
  await shutdownPostHog()

  // Skip printing if the error was already shown (e.g. by spinner.fail)
  const alreadyDisplayed =
    (err instanceof CliError && err.displayed) ||
    (err instanceof Error && (err as Error & { _displayed?: boolean })._displayed)
  if (!alreadyDisplayed) {
    process.stderr.write(`${message}\n`)
  }
  if (err instanceof CliError) {
    process.exit(err.exitCode)
  }

  // Handle API errors with proper exit codes
  if (err instanceof ApiError) {
    process.exit(mapHttpStatusToExitCode(err.status))
  }

  process.exit(1)
}

export const ExitCodes = {
  SUCCESS: 0,
  GENERAL_ERROR: 1,
  AUTH_ERROR: 2,
  PERMISSION_DENIED: 3,
  NOT_FOUND: 4,
  INVALID_INPUT: 5,
  RATE_LIMITED: 6,
  TIMEOUT: 7,
  SERVER_ERROR: 8,
  NETWORK_ERROR: 9,
} as const

/**
 * Map HTTP status codes to CLI exit codes.
 */
export function mapHttpStatusToExitCode(status: number): number {
  if (status === 401) return ExitCodes.AUTH_ERROR
  if (status === 402) return ExitCodes.PERMISSION_DENIED  // Payment required
  if (status === 403) return ExitCodes.PERMISSION_DENIED
  if (status === 404) return ExitCodes.NOT_FOUND
  if (status === 429) return ExitCodes.RATE_LIMITED
  if (status >= 500 && status <= 599) return ExitCodes.SERVER_ERROR
  return ExitCodes.GENERAL_ERROR
}

export class NetworkError extends CliError {
  constructor(url: string, cause?: Error) {
    const host = new URL(url).host
    super(
      `Unable to connect to ${host}\n\n` +
      'Possible causes:\n' +
      '  - Network connectivity issues\n' +
      '  - Service temporarily unavailable\n' +
      '  - Firewall or proxy blocking the request\n\n' +
      'Check status at: https://status.orchagent.io',
      ExitCodes.NETWORK_ERROR
    )
    this.cause = cause
  }
}

export function jsonInputError(flag: 'data' | 'input'): CliError {
  return new CliError(
    `Invalid JSON in --${flag} option.\n\n` +
    'Common causes:\n' +
    '  - Shell special characters (!, $, `) need escaping\n' +
    '  - Missing or mismatched quotes\n\n' +
    'Shell-specific tips:\n' +
    '  - Bash/Zsh: Use single quotes: --data \'{"key": "value"}\'\n' +
    '  - PowerShell: Use double quotes and escape: --data "{\\"key\\": \\"value\\"}"\n' +
    '  - Any shell: Use a file: --data @input.json\n\n' +
    'Alternatives:\n' +
    `  - Use a file:  --${flag} @input.json\n` +
    `  - Use stdin:   echo '{"key":"value"}' | orch run agent --${flag} @-`,
    ExitCodes.INVALID_INPUT
  )
}
