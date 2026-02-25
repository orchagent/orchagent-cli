import { describe, it, expect } from 'vitest'
import { runOrch } from '../setup'
import { getWorkspaceMatrixFixture, shouldSkipLiveMatrix } from '../fixtures/workspace-fixtures'

describe('error semantics matrix (live)', () => {
  const fixture = getWorkspaceMatrixFixture()

  it('returns deterministic not-found errors for missing refs', async () => {
    if (shouldSkipLiveMatrix() || !fixture.personalApiKey) {
      return
    }

    const original = process.env.ORCHAGENT_API_KEY
    process.env.ORCHAGENT_API_KEY = fixture.personalApiKey

    const result = await runOrch(['info', 'nonexistent-org/nonexistent-agent@latest'], { timeout: 120000 })

    if (original === undefined) delete process.env.ORCHAGENT_API_KEY
    else process.env.ORCHAGENT_API_KEY = original

    expect(result.code).not.toBe(0)
    const text = `${result.stdout}\n${result.stderr}`.toLowerCase()
    expect(text.includes('not found') || text.includes('404') || text.includes('missing')).toBe(true)
  })

  it('returns deterministic validation errors for malformed refs', async () => {
    const result = await runOrch(['info', 'bad/ref/shape/extra'])

    expect(result.code).not.toBe(0)
    const text = `${result.stdout}\n${result.stderr}`.toLowerCase()
    expect(text.includes('invalid') || text.includes('format')).toBe(true)
  })
})
