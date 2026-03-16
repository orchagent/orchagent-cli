import * as Sentry from '@sentry/node'
import { shutdownPostHog } from './analytics'
import { ApiError } from './api'
import { isJsonMode } from './output'

export const ErrorCodes = {
  GENERAL_ERROR: 'GENERAL_ERROR',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  NOT_FOUND: 'NOT_FOUND',
  INVALID_INPUT: 'INVALID_INPUT',
  RATE_LIMITED: 'RATE_LIMITED',
  TIMEOUT: 'TIMEOUT',
  SERVER_ERROR: 'SERVER_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR',
  MISSING_SECRETS: 'MISSING_SECRETS',
} as const

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

export class CliError extends Error {
  exitCode: number
  code?: string
  hint?: string
  cause?: Error
  responseBody?: unknown
  /** When true, exitWithError skips printing — the message was already shown (e.g. via spinner.fail). */
  displayed?: boolean

  constructor(message: string, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

function dedupeErrorDetail(message: string, detail: string): string | null {
  const normalizedMessage = message.replace(/\r\n/g, '\n').trim()
  const normalizedDetail = detail.replace(/\r\n/g, '\n').trim()

  if (!normalizedDetail) return null
  if (!normalizedMessage) return normalizedDetail

  // Some responses repeat the same text in both `message` and `detail`.
  if (normalizedDetail === normalizedMessage) return null

  // If detail starts with the same first line, keep only the additional context.
  const detailLines = normalizedDetail.split('\n')
  if (detailLines[0] === normalizedMessage) {
    const remainder = detailLines.slice(1).join('\n').trim()
    return remainder || null
  }

  // No useful extra information.
  if (normalizedMessage.includes(normalizedDetail)) return null

  return normalizedDetail
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
      if (typeof detail === 'string') {
        const dedupedDetail = dedupeErrorDetail(anyErr.message, detail)
        if (dedupedDetail) msg += `\n${dedupedDetail}`
      }
      return msg
    }
    return anyErr.message
  }

  return String(err)
}

/** Map an exit code to a default error code string. */
function exitCodeToErrorCode(exitCode: number): string {
  switch (exitCode) {
    case ExitCodes.AUTH_ERROR: return ErrorCodes.AUTH_REQUIRED
    case ExitCodes.PERMISSION_DENIED: return ErrorCodes.PERMISSION_DENIED
    case ExitCodes.NOT_FOUND: return ErrorCodes.NOT_FOUND
    case ExitCodes.INVALID_INPUT: return ErrorCodes.INVALID_INPUT
    case ExitCodes.RATE_LIMITED: return ErrorCodes.RATE_LIMITED
    case ExitCodes.TIMEOUT: return ErrorCodes.TIMEOUT
    case ExitCodes.SERVER_ERROR: return ErrorCodes.SERVER_ERROR
    case ExitCodes.NETWORK_ERROR: return ErrorCodes.NETWORK_ERROR
    default: return ErrorCodes.GENERAL_ERROR
  }
}

/** Map an HTTP status code to an error code string. */
function httpStatusToErrorCode(status: number): string {
  if (status === 401) return ErrorCodes.AUTH_REQUIRED
  if (status === 402 || status === 403) return ErrorCodes.PERMISSION_DENIED
  if (status === 404) return ErrorCodes.NOT_FOUND
  if (status === 422) return ErrorCodes.INVALID_INPUT
  if (status === 429) return ErrorCodes.RATE_LIMITED
  if (status >= 500 && status <= 599) return ErrorCodes.SERVER_ERROR
  return ErrorCodes.GENERAL_ERROR
}

/**
 * Build a structured JSON error object from any error.
 * Output format: { error: true, code: string, message: string, hint?: string, exit_code: number }
 */
export function formatJsonError(err: unknown): { error: true; code: string; message: string; hint?: string; exit_code: number } {
  if (err instanceof CliError) {
    const code = err.code || exitCodeToErrorCode(err.exitCode)
    return {
      error: true,
      code,
      message: err.message,
      ...(err.hint ? { hint: err.hint } : {}),
      exit_code: err.exitCode,
    }
  }

  if (err instanceof ApiError) {
    const p = err.payload as { error?: { code?: string; detail?: string }; detail?: string } | undefined
    const gatewayCode = p?.error?.code
    const detail = p?.error?.detail || p?.detail
    const code = gatewayCode || httpStatusToErrorCode(err.status)
    const exitCode = mapHttpStatusToExitCode(err.status)
    return {
      error: true,
      code,
      message: err.message,
      ...(typeof detail === 'string' && detail !== err.message ? { hint: detail } : {}),
      exit_code: exitCode,
    }
  }

  if (err instanceof Error) {
    const anyErr = err as Error & { status?: number; payload?: unknown }
    if (anyErr.status) {
      const exitCode = mapHttpStatusToExitCode(anyErr.status)
      return {
        error: true,
        code: httpStatusToErrorCode(anyErr.status),
        message: anyErr.message,
        exit_code: exitCode,
      }
    }
    return {
      error: true,
      code: ErrorCodes.GENERAL_ERROR,
      message: anyErr.message,
      exit_code: 1,
    }
  }

  return {
    error: true,
    code: ErrorCodes.GENERAL_ERROR,
    message: String(err),
    exit_code: 1,
  }
}

export async function exitWithError(err: unknown): Promise<never> {
  // Report to Sentry if it's a real error (not a CliError which is expected)
  if (!(err instanceof CliError) && process.env.SENTRY_DSN) {
    Sentry.captureException(err)
  }

  // Flush PostHog before exiting
  await shutdownPostHog()

  // Determine exit code
  let exitCode = 1
  if (err instanceof CliError) {
    exitCode = err.exitCode
  } else if (err instanceof ApiError) {
    exitCode = mapHttpStatusToExitCode(err.status)
  }

  // Skip printing if the error was already shown (e.g. by spinner.fail)
  const alreadyDisplayed =
    (err instanceof CliError && err.displayed) ||
    (err instanceof Error && (err as Error & { _displayed?: boolean })._displayed)

  if (!alreadyDisplayed) {
    if (isJsonMode()) {
      const jsonErr = formatJsonError(err)
      process.stdout.write(`${JSON.stringify(jsonErr, null, 2)}\n`)
    } else {
      const message = formatError(err)
      process.stderr.write(`${message}\n`)
    }
  }

  process.exit(exitCode)
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
      `Unable to connect to ${host}`,
      ExitCodes.NETWORK_ERROR
    )
    this.code = ErrorCodes.NETWORK_ERROR
    this.hint = 'Check network connectivity or status at https://status.orchagent.io'
    this.cause = cause
  }
}

export function jsonInputError(flag: 'data' | 'input'): CliError {
  const err = new CliError(
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
  err.code = ErrorCodes.INVALID_INPUT
  err.hint = `Use a file: --${flag} @input.json`
  return err
}
