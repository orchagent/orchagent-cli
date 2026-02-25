import { describe, it, expect } from 'vitest'
import { runOrch } from '../setup'
import { getWorkspaceMatrixFixture, shouldSkipLiveMatrix } from '../fixtures/workspace-fixtures'

describe('workspace resolution matrix (live)', () => {
  const fixture = getWorkspaceMatrixFixture()

  it('resolves public agent refs with personal auth context', async () => {
    if (shouldSkipLiveMatrix() || !fixture.personalApiKey) {
      return
    }

    const original = process.env.ORCHAGENT_API_KEY
    process.env.ORCHAGENT_API_KEY = fixture.personalApiKey

    const result = await runOrch(['info', fixture.publicAgentRef, '--json'], { timeout: 120000 })

    if (original === undefined) delete process.env.ORCHAGENT_API_KEY
    else process.env.ORCHAGENT_API_KEY = original

    expect(result.code).toBe(0)
    expect(result.stdout.toLowerCase()).toContain('name')
  })

  it('resolves public agent refs with team auth context', async () => {
    if (shouldSkipLiveMatrix() || !fixture.teamApiKey) {
      return
    }

    const original = process.env.ORCHAGENT_API_KEY
    process.env.ORCHAGENT_API_KEY = fixture.teamApiKey

    const result = await runOrch(['estimate', fixture.publicAgentRef, '--json'], { timeout: 120000 })

    if (original === undefined) delete process.env.ORCHAGENT_API_KEY
    else process.env.ORCHAGENT_API_KEY = original

    expect(result.code).toBe(0)
    expect(result.stdout.toLowerCase()).toContain('estimate')
  })
})
