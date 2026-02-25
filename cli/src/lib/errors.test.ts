import { describe, expect, it } from 'vitest'

import { ApiError } from './api'
import { formatError } from './errors'

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
})
