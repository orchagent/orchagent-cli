import { describe, it, expect } from 'vitest'
import { runOrch } from '../setup'
import { shouldSkipLiveMatrix } from '../fixtures/workspace-fixtures'

interface OrchestrationFixture {
  personalApiKey?: string
  orchestratorAgentRef?: string
  workspaceSlug?: string
  scheduleId?: string
}

function getOrchestrationFixture(): OrchestrationFixture {
  return {
    personalApiKey: process.env.ORCHAGENT_API_KEY_MATRIX_PERSONAL,
    orchestratorAgentRef: process.env.ORCHAGENT_MATRIX_ORCHESTRATOR_AGENT,
    workspaceSlug: process.env.ORCHAGENT_MATRIX_ORCHESTRATION_WORKSPACE,
    scheduleId: process.env.ORCHAGENT_MATRIX_SCHEDULE_ID,
  }
}

function parseJsonSafe(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch {
    return null
  }
}

function extractRunIdFromOutput(stdout: string, stderr: string): string | null {
  const fromHint = `${stdout}\n${stderr}`.match(/orch\s+logs\s+([0-9a-fA-F-]{8,36})/)
  if (fromHint?.[1]) {
    return fromHint[1]
  }

  const parsed = parseJsonSafe(stdout)
  if (!parsed) {
    return null
  }

  const direct = parsed.run_id
  if (typeof direct === 'string' && direct.length >= 8) {
    return direct
  }

  const metadata = parsed.metadata
  if (typeof metadata === 'object' && metadata !== null) {
    const requestId = (metadata as Record<string, unknown>).request_id
    if (typeof requestId === 'string' && requestId.length >= 8) {
      return requestId
    }
  }

  return null
}

async function waitForTerminalRun(
  runId: string,
  workspaceSlug: string,
  timeoutMs = 240_000
): Promise<{ status: string; error: string | null; raw: Record<string, unknown> }> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const result = await runOrch([
      'logs',
      runId,
      '--workspace',
      workspaceSlug,
      '--json',
    ], { timeout: 90_000 })

    if (result.code === 0) {
      const parsed = parseJsonSafe(result.stdout)
      if (parsed) {
        const status = parsed.run_status
        const error = parsed.error_message
        if (typeof status === 'string') {
          if (['completed', 'failed', 'timeout', 'dead_letter', 'cancelled'].includes(status)) {
            return {
              status,
              error: typeof error === 'string' ? error : null,
              raw: parsed,
            }
          }
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 3000))
  }

  throw new Error(`Timed out waiting for terminal status for run ${runId}`)
}

describe('orchestration reliability matrix (live)', () => {
  const fixture = getOrchestrationFixture()

  it('run -> replay keeps typed status semantics (no opaque nested 500s)', async () => {
    if (
      shouldSkipLiveMatrix() ||
      !fixture.personalApiKey ||
      !fixture.orchestratorAgentRef ||
      !fixture.workspaceSlug
    ) {
      return
    }

    const original = process.env.ORCHAGENT_API_KEY
    process.env.ORCHAGENT_API_KEY = fixture.personalApiKey

    const run = await runOrch([
      'run',
      fixture.orchestratorAgentRef,
      '--data',
      '{}',
      '--json',
      '--wait-timeout',
      '900',
    ], { timeout: 420_000 })

    expect(run.code).toBe(0)

    const sourceRunId = extractRunIdFromOutput(run.stdout, run.stderr)
    expect(sourceRunId).toBeTruthy()

    const replay = await runOrch([
      'replay',
      sourceRunId as string,
      '--workspace',
      fixture.workspaceSlug,
      '--no-wait',
      '--json',
    ], { timeout: 120_000 })

    if (original === undefined) delete process.env.ORCHAGENT_API_KEY
    else process.env.ORCHAGENT_API_KEY = original

    expect(replay.code).toBe(0)

    const replayJson = parseJsonSafe(replay.stdout)
    expect(replayJson).toBeTruthy()

    const replayRunId = replayJson?.run_id
    expect(typeof replayRunId).toBe('string')

    const terminal = await waitForTerminalRun(replayRunId as string, fixture.workspaceSlug, 300_000)
    expect(['completed', 'failed', 'timeout', 'dead_letter', 'cancelled']).toContain(terminal.status)

    const text = `${terminal.error ?? ''}\n${JSON.stringify(terminal.raw)}`.toLowerCase()
    if (terminal.status !== 'completed') {
      expect(text.includes('all providers exhausted: 500 sandbox execution failed')).toBe(false)
    }
  })

  it('schedule trigger path returns typed async status and produces an observable run', async () => {
    if (
      shouldSkipLiveMatrix() ||
      !fixture.personalApiKey ||
      !fixture.workspaceSlug ||
      !fixture.scheduleId
    ) {
      return
    }

    const original = process.env.ORCHAGENT_API_KEY
    process.env.ORCHAGENT_API_KEY = fixture.personalApiKey

    const trigger = await runOrch([
      'schedule',
      'trigger',
      fixture.scheduleId,
      '--workspace',
      fixture.workspaceSlug,
      '--json',
    ], { timeout: 120_000 })

    if (original === undefined) delete process.env.ORCHAGENT_API_KEY
    else process.env.ORCHAGENT_API_KEY = original

    expect(trigger.code).toBe(0)
    const payload = parseJsonSafe(trigger.stdout)
    expect(payload).toBeTruthy()

    const status = payload?.status
    expect(typeof status).toBe('string')
    expect(['queued', 'deduplicated', 'completed', 'failed', 'timeout']).toContain(status as string)

    const runId = payload?.run_id
    expect(typeof runId).toBe('string')

    const terminal = await waitForTerminalRun(runId as string, fixture.workspaceSlug, 240_000)
    expect(['completed', 'failed', 'timeout', 'dead_letter', 'cancelled']).toContain(terminal.status)

    const info = await runOrch([
      'schedule',
      'info',
      fixture.scheduleId,
      '--workspace',
      fixture.workspaceSlug,
      '--json',
    ], { timeout: 120_000 })

    expect(info.code).toBe(0)
    const infoJson = parseJsonSafe(info.stdout)
    expect(infoJson).toBeTruthy()

    const runs = infoJson?.runs
    expect(Array.isArray(runs)).toBe(true)
    expect((runs as unknown[]).length).toBeGreaterThan(0)
  })
})
