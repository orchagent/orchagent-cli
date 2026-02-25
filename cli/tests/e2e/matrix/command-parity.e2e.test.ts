import { describe, it, expect } from 'vitest'
import { runOrch } from '../setup'
import { getWorkspaceMatrixFixture, shouldSkipLiveMatrix } from '../fixtures/workspace-fixtures'

describe('command parity matrix (live)', () => {
  const fixture = getWorkspaceMatrixFixture()

  it('keeps info/tree parity on the same ref', async () => {
    if (shouldSkipLiveMatrix() || !fixture.personalApiKey) {
      return
    }

    const original = process.env.ORCHAGENT_API_KEY
    process.env.ORCHAGENT_API_KEY = fixture.personalApiKey

    const info = await runOrch(['info', fixture.publicAgentRef], { timeout: 120000 })
    const tree = await runOrch(['tree', fixture.publicAgentRef], { timeout: 120000 })

    if (original === undefined) delete process.env.ORCHAGENT_API_KEY
    else process.env.ORCHAGENT_API_KEY = original

    expect(info.code).toBe(0)
    expect(tree.code).toBe(0)
  })

  it('keeps estimate/run parity for public refs', async () => {
    if (shouldSkipLiveMatrix() || !fixture.personalApiKey) {
      return
    }

    const original = process.env.ORCHAGENT_API_KEY
    process.env.ORCHAGENT_API_KEY = fixture.personalApiKey

    const estimate = await runOrch(['estimate', fixture.publicAgentRef, '--json'], { timeout: 120000 })
    const run = await runOrch(['run', fixture.publicAgentRef, '--data', '{}', '--json'], { timeout: 180000 })

    if (original === undefined) delete process.env.ORCHAGENT_API_KEY
    else process.env.ORCHAGENT_API_KEY = original

    expect(estimate.code).toBe(0)
    expect(run.code).toBe(0)
  })
})
