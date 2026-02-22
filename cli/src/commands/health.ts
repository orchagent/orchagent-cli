import { Command } from 'commander'
import chalk from 'chalk'

import { getResolvedConfig, loadConfig } from '../lib/config'
import {
  ApiError,
  getAgentWithFallback,
  resolveWorkspaceIdForOrg,
  safeFetchWithRetryForCalls,
} from '../lib/api'
import { parseAgentRef } from '../lib/agent-ref'
import { CliError } from '../lib/errors'
import { createElapsedSpinner } from '../lib/spinner'
import { printJson } from '../lib/output'
import packageJson from '../../package.json'
import type { Agent } from '../types'

type HealthResult = {
  agent: string
  version: string
  status: 'pass' | 'fail'
  latency_ms: number
  run_id?: string
  error?: string
  checks: {
    resolve: 'pass' | 'fail'
    execute: 'pass' | 'fail' | 'skip'
  }
}

type Schema = {
  type?: string
  properties?: Record<string, SchemaProperty>
  required?: string[]
}

type SchemaProperty = {
  type?: string
  description?: string
  items?: { type?: string }
  enum?: string[]
  default?: unknown
}

/**
 * Generate a minimal sample input from an agent's input schema.
 * Produces just enough to satisfy required fields.
 */
function generateSampleInput(schema?: Schema): Record<string, unknown> | undefined {
  if (!schema?.properties) return undefined
  const required = new Set(schema.required || [])
  const result: Record<string, unknown> = {}

  for (const [key, prop] of Object.entries(schema.properties)) {
    if (!required.has(key)) continue
    result[key] = sampleValue(prop)
  }

  // If no required fields, fill one optional field so the request isn't empty
  if (Object.keys(result).length === 0) {
    const firstKey = Object.keys(schema.properties)[0]
    if (firstKey) {
      result[firstKey] = sampleValue(schema.properties[firstKey])
    }
  }

  return Object.keys(result).length > 0 ? result : undefined
}

function sampleValue(prop: SchemaProperty): unknown {
  if (prop.default !== undefined) return prop.default
  if (prop.enum?.length) return prop.enum[0]
  switch (prop.type) {
    case 'string': return 'test'
    case 'number':
    case 'integer': return 1
    case 'boolean': return true
    case 'array': return []
    case 'object': return {}
    default: return 'test'
  }
}

export function registerHealthCommand(program: Command): void {
  program
    .command('health <agent>')
    .description('Smoke test an agent with a minimal cloud execution')
    .option('--json', 'Output result as JSON')
    .option('--data <json>', 'Custom input data (JSON string)')
    .option('--timeout <ms>', 'Execution timeout in milliseconds', '30000')
    .action(async (agentArg: string, options: {
      json?: boolean
      data?: string
      timeout?: string
    }) => {
      const startTime = Date.now()
      const config = await getResolvedConfig()

      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orchagent login` first.')
      }

      const parsed = parseAgentRef(agentArg)
      const configFile = await loadConfig()
      const org = parsed.org ?? configFile.workspace ?? config.defaultOrg
      if (!org) {
        throw new CliError('Missing org. Use org/agent[@version] format or set default org.')
      }

      const timeoutMs = parseInt(options.timeout || '30000', 10)
      if (isNaN(timeoutMs) || timeoutMs < 1000) {
        throw new CliError('Timeout must be at least 1000ms.')
      }

      const result: HealthResult = {
        agent: `${org}/${parsed.agent}`,
        version: parsed.version,
        status: 'fail',
        latency_ms: 0,
        checks: { resolve: 'fail', execute: 'skip' },
      }

      const { spinner, dispose } = options.json
        ? { spinner: null, dispose: () => {} }
        : createElapsedSpinner(`Health check: ${org}/${parsed.agent}@${parsed.version}`)
      spinner?.start()

      // --- Step 1: Resolve agent metadata ---
      let agentMeta: Awaited<ReturnType<typeof getAgentWithFallback>>
      let workspaceId: string | undefined

      try {
        workspaceId = await resolveWorkspaceIdForOrg(config, org)
        agentMeta = await getAgentWithFallback(
          config, org, parsed.agent, parsed.version, workspaceId
        )
        result.checks.resolve = 'pass'
      } catch (err) {
        result.latency_ms = Date.now() - startTime
        result.error = err instanceof Error ? err.message : String(err)
        dispose()
        return reportResult(result, options.json, spinner)
      }

      // Skills are not runnable
      const agentType = agentMeta.type || 'prompt'
      if (agentType === 'skill') {
        result.latency_ms = Date.now() - startTime
        result.error = 'Skills are not runnable — nothing to health check.'
        result.checks.execute = 'skip'
        dispose()
        return reportResult(result, options.json, spinner)
      }

      // --- Step 2: Execute agent ---
      const inputSchema = agentMeta.input_schema as Schema | undefined
      let body: string

      if (options.data) {
        try {
          JSON.parse(options.data)
          body = options.data
        } catch {
          throw new CliError('Invalid JSON in --data option.')
        }
      } else {
        const sample = generateSampleInput(inputSchema)
        body = JSON.stringify(sample || {})
      }

      const endpoint = agentMeta.default_endpoint || 'analyze'
      const url = `${config.apiUrl.replace(/\/$/, '')}/${org}/${parsed.agent}/${parsed.version}/${endpoint}`

      const headers: Record<string, string> = {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'X-CLI-Version': packageJson.version,
        'X-OrchAgent-Client': 'cli',
      }
      if (workspaceId) {
        headers['X-Workspace-Id'] = workspaceId
      }

      try {
        const response = await safeFetchWithRetryForCalls(url, {
          method: 'POST',
          headers,
          body,
          timeoutMs: timeoutMs,
        })

        result.latency_ms = Date.now() - startTime

        // Extract run ID from response headers or body
        const runId = response.headers.get('x-orchagent-run-id')
        if (runId) result.run_id = runId

        if (response.ok) {
          // Try to extract run_id from body if not in headers
          const text = await response.text()
          if (!result.run_id) {
            try {
              const parsed = JSON.parse(text)
              if (parsed?.run_id) result.run_id = parsed.run_id
            } catch { /* not JSON, that's fine */ }
          }
          result.checks.execute = 'pass'
          result.status = 'pass'
        } else {
          result.checks.execute = 'fail'
          const text = await response.text()
          let detail: string
          try {
            const parsed = JSON.parse(text)
            detail = parsed?.error?.message || parsed?.message || parsed?.detail || `HTTP ${response.status}`
            if (parsed?.run_id) result.run_id = parsed.run_id
          } catch {
            detail = `HTTP ${response.status}: ${text.slice(0, 200)}`
          }
          result.error = detail
        }
      } catch (err) {
        result.latency_ms = Date.now() - startTime
        result.checks.execute = 'fail'
        result.error = err instanceof Error ? err.message : String(err)
      }

      dispose()
      reportResult(result, options.json, spinner)
    })
}

function reportResult(
  result: HealthResult,
  json: boolean | undefined,
  spinner: ReturnType<typeof createElapsedSpinner>['spinner'] | null
): void {
  if (json) {
    printJson(result)
    if (result.status === 'fail') {
      process.exitCode = 1
    }
    return
  }

  const passed = result.status === 'pass'
  const latency = `${result.latency_ms}ms`

  if (passed) {
    spinner?.succeed(
      `${chalk.green('PASS')} ${result.agent}@${result.version} — ${latency}`
    )
  } else {
    spinner?.fail(
      `${chalk.red('FAIL')} ${result.agent}@${result.version} — ${latency}`
    )
  }

  // Detail lines
  process.stderr.write('\n')
  process.stderr.write(`  Resolve:  ${checkMark(result.checks.resolve)}\n`)
  process.stderr.write(`  Execute:  ${checkMark(result.checks.execute)}\n`)

  if (result.run_id) {
    process.stderr.write(`  Run ID:   ${chalk.gray(result.run_id)}\n`)
    process.stderr.write(`  Logs:     ${chalk.gray(`orch logs ${result.run_id}`)}\n`)
  }

  if (result.error) {
    process.stderr.write(`\n  ${chalk.red('Error:')} ${result.error}\n`)
  }

  process.stderr.write('\n')

  if (!passed) {
    process.exitCode = 1
  }
}

function checkMark(status: 'pass' | 'fail' | 'skip'): string {
  switch (status) {
    case 'pass': return chalk.green('pass')
    case 'fail': return chalk.red('fail')
    case 'skip': return chalk.gray('skip')
  }
}
