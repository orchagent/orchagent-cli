import { describe, expect, it, afterEach } from 'vitest'

import { ApiError } from './api'
import {
  formatError,
  formatJsonError,
  CliError,
  NetworkError,
  ExitCodes,
  ErrorCodes,
  mapHttpStatusToExitCode,
  jsonInputError,
} from './errors'

describe('formatError', () => {
  it('does not duplicate detail when it matches the message', () => {
    const err = new ApiError('Agent execution failed', 500, {
      message: 'Agent execution failed',
      detail: 'Agent execution failed',
    })

    expect(formatError(err)).toBe('Agent execution failed (status 500)')
  })

  it('keeps only additional detail lines when first line matches message', () => {
    const err = new ApiError('Agent execution failed', 500, {
      message: 'Agent execution failed',
      detail: 'Agent execution failed\nref: req_123',
    })

    expect(formatError(err)).toBe('Agent execution failed (status 500)\nref: req_123')
  })

  it('keeps distinct detail text', () => {
    const err = new ApiError('Internal Server Error', 500, {
      error: {
        code: 'INTERNAL_ERROR',
        detail: 'Dependency install failed',
      },
    })

    expect(formatError(err)).toBe(
      'Internal Server Error (status 500, INTERNAL_ERROR)\nDependency install failed'
    )
  })

  it('formats CliError with just the message', () => {
    const err = new CliError('Something went wrong')
    expect(formatError(err)).toBe('Something went wrong')
  })

  it('formats plain Error with just the message', () => {
    expect(formatError(new Error('oops'))).toBe('oops')
  })

  it('formats non-Error values as strings', () => {
    expect(formatError('string error')).toBe('string error')
    expect(formatError(42)).toBe('42')
  })
})

describe('formatJsonError', () => {
  it('formats CliError with default code from exit code', () => {
    const err = new CliError('Not logged in', ExitCodes.AUTH_ERROR)
    const result = formatJsonError(err)
    expect(result).toEqual({
      error: true,
      code: 'AUTH_REQUIRED',
      message: 'Not logged in',
      exit_code: 2,
    })
  })

  it('uses explicit code when set on CliError', () => {
    const err = new CliError('Agent not found', ExitCodes.NOT_FOUND)
    err.code = 'AGENT_NOT_FOUND'
    const result = formatJsonError(err)
    expect(result.code).toBe('AGENT_NOT_FOUND')
    expect(result.exit_code).toBe(4)
  })

  it('includes hint when set on CliError', () => {
    const err = new CliError('Missing org', ExitCodes.INVALID_INPUT)
    err.hint = 'Use org/agent format or set default org'
    const result = formatJsonError(err)
    expect(result.hint).toBe('Use org/agent format or set default org')
  })

  it('omits hint when not set', () => {
    const err = new CliError('Generic error')
    const result = formatJsonError(err)
    expect(result).not.toHaveProperty('hint')
  })

  it('formats ApiError with gateway error code', () => {
    const err = new ApiError('Not Found', 404, {
      error: { code: 'AGENT_NOT_FOUND', detail: "Agent 'foo/bar' does not exist" },
    })
    const result = formatJsonError(err)
    expect(result).toEqual({
      error: true,
      code: 'AGENT_NOT_FOUND',
      message: 'Not Found',
      hint: "Agent 'foo/bar' does not exist",
      exit_code: 4,
    })
  })

  it('falls back to HTTP status code when no gateway code', () => {
    const err = new ApiError('Forbidden', 403)
    const result = formatJsonError(err)
    expect(result.code).toBe('PERMISSION_DENIED')
    expect(result.exit_code).toBe(3)
  })

  it('handles 401 as AUTH_REQUIRED', () => {
    const err = new ApiError('Unauthorized', 401)
    const result = formatJsonError(err)
    expect(result.code).toBe('AUTH_REQUIRED')
    expect(result.exit_code).toBe(2)
  })

  it('handles 429 as RATE_LIMITED', () => {
    const err = new ApiError('Too Many Requests', 429)
    const result = formatJsonError(err)
    expect(result.code).toBe('RATE_LIMITED')
    expect(result.exit_code).toBe(6)
  })

  it('handles 500 as SERVER_ERROR', () => {
    const err = new ApiError('Internal Server Error', 500)
    const result = formatJsonError(err)
    expect(result.code).toBe('SERVER_ERROR')
    expect(result.exit_code).toBe(8)
  })

  it('handles 422 as INVALID_INPUT', () => {
    const err = new ApiError('Unprocessable Entity', 422, {
      error: { detail: 'version must be a string' },
    })
    const result = formatJsonError(err)
    expect(result.code).toBe('INVALID_INPUT')
    expect(result.hint).toBe('version must be a string')
  })

  it('does not include hint when detail matches message', () => {
    const err = new ApiError('Bad Request', 400, {
      detail: 'Bad Request',
    })
    const result = formatJsonError(err)
    expect(result).not.toHaveProperty('hint')
  })

  it('formats plain Error', () => {
    const err = new Error('unexpected failure')
    const result = formatJsonError(err)
    expect(result).toEqual({
      error: true,
      code: 'GENERAL_ERROR',
      message: 'unexpected failure',
      exit_code: 1,
    })
  })

  it('formats Error with status property', () => {
    const err = new Error('Payment Required') as Error & { status: number }
    err.status = 402
    const result = formatJsonError(err)
    expect(result.code).toBe('PERMISSION_DENIED')
    expect(result.exit_code).toBe(3)
  })

  it('formats non-Error values', () => {
    expect(formatJsonError('string error')).toEqual({
      error: true,
      code: 'GENERAL_ERROR',
      message: 'string error',
      exit_code: 1,
    })
  })

  it('formats NetworkError with code and hint', () => {
    const err = new NetworkError('https://api.orchagent.io/agents')
    const result = formatJsonError(err)
    expect(result.code).toBe('NETWORK_ERROR')
    expect(result.hint).toBe('Check network connectivity or status at https://status.orchagent.io')
    expect(result.exit_code).toBe(9)
  })

  it('formats jsonInputError with code and hint', () => {
    const err = jsonInputError('data')
    const result = formatJsonError(err)
    expect(result.code).toBe('INVALID_INPUT')
    expect(result.hint).toBe('Use a file: --data @input.json')
    expect(result.exit_code).toBe(5)
  })

  it('maps all exit codes to correct error codes', () => {
    const mappings: Array<[number, string]> = [
      [ExitCodes.GENERAL_ERROR, 'GENERAL_ERROR'],
      [ExitCodes.AUTH_ERROR, 'AUTH_REQUIRED'],
      [ExitCodes.PERMISSION_DENIED, 'PERMISSION_DENIED'],
      [ExitCodes.NOT_FOUND, 'NOT_FOUND'],
      [ExitCodes.INVALID_INPUT, 'INVALID_INPUT'],
      [ExitCodes.RATE_LIMITED, 'RATE_LIMITED'],
      [ExitCodes.TIMEOUT, 'TIMEOUT'],
      [ExitCodes.SERVER_ERROR, 'SERVER_ERROR'],
      [ExitCodes.NETWORK_ERROR, 'NETWORK_ERROR'],
    ]
    for (const [exitCode, expectedCode] of mappings) {
      const err = new CliError('test', exitCode)
      expect(formatJsonError(err).code).toBe(expectedCode)
    }
  })
})

describe('mapHttpStatusToExitCode', () => {
  it('maps 401 to AUTH_ERROR', () => {
    expect(mapHttpStatusToExitCode(401)).toBe(ExitCodes.AUTH_ERROR)
  })

  it('maps 403 to PERMISSION_DENIED', () => {
    expect(mapHttpStatusToExitCode(403)).toBe(ExitCodes.PERMISSION_DENIED)
  })

  it('maps 404 to NOT_FOUND', () => {
    expect(mapHttpStatusToExitCode(404)).toBe(ExitCodes.NOT_FOUND)
  })

  it('maps 429 to RATE_LIMITED', () => {
    expect(mapHttpStatusToExitCode(429)).toBe(ExitCodes.RATE_LIMITED)
  })

  it('maps 500 to SERVER_ERROR', () => {
    expect(mapHttpStatusToExitCode(500)).toBe(ExitCodes.SERVER_ERROR)
  })

  it('maps unknown status to GENERAL_ERROR', () => {
    expect(mapHttpStatusToExitCode(418)).toBe(ExitCodes.GENERAL_ERROR)
  })
})
