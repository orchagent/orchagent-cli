/**
 * Local HTTP dev server for agent development.
 *
 * Provides agent config loading, execution dispatch (code_runtime, direct_llm,
 * managed_loop), and an HTTP server that accepts JSON input and returns results.
 */

import http from 'http'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { spawn } from 'child_process'

import { loadDotEnv } from './dotenv'
import {
  detectLlmKey,
  getDefaultModel,
  buildPrompt,
  callLlm,
  PROVIDER_ENV_VARS,
  type LlmProvider,
} from './llm'
import { detectEntrypoint } from './bundle'
import { getResolvedConfig } from './config'
import type { AgentManifest, ResolvedConfig } from '../types'

// ─── Types ──────────────────────────────────────────────────────────────────

export type ExecutionEngine = 'direct_llm' | 'managed_loop' | 'code_runtime'

export type AgentConfig = {
  manifest: AgentManifest
  engine: ExecutionEngine
  entrypoint?: string
  prompt?: string
  outputSchema?: object
  inputSchema?: object
  customTools?: object[]
  agentDir: string
}

export type RequestLog = {
  id: number
  method: string
  path: string
  statusCode: number
  durationMs: number
  inputPreview?: string
  error?: string
}

export type DevServerCallbacks = {
  onRequest?: (log: RequestLog) => void
  onError?: (err: Error) => void
}

// ─── Engine inference ───────────────────────────────────────────────────────

export function inferEngine(manifest: AgentManifest): ExecutionEngine {
  const hasRuntimeCommand = Boolean(manifest.runtime?.command?.trim())
  const hasLoop = Boolean(manifest.loop && Object.keys(manifest.loop).length > 0)

  if (hasRuntimeCommand) return 'code_runtime'
  if (hasLoop) return 'managed_loop'

  const rawType = (manifest.type || 'agent').trim().toLowerCase()
  if (rawType === 'tool' || rawType === 'code') return 'code_runtime'
  if (rawType === 'agentic') return 'managed_loop'
  if (rawType === 'agent') return 'managed_loop'
  return 'direct_llm'
}

export function engineLabel(engine: ExecutionEngine): string {
  switch (engine) {
    case 'direct_llm': return 'prompt'
    case 'managed_loop': return 'agent loop'
    case 'code_runtime': return 'code runtime'
  }
}

// ─── Agent config loading ───────────────────────────────────────────────────

export async function loadAgentConfig(agentDir: string): Promise<AgentConfig> {
  const manifestPath = path.join(agentDir, 'orchagent.json')
  const raw = await fs.readFile(manifestPath, 'utf-8')
  const manifest: AgentManifest = JSON.parse(raw)

  const engine = inferEngine(manifest)

  // Read prompt.md if needed
  let prompt: string | undefined
  if (engine === 'direct_llm' || engine === 'managed_loop') {
    try {
      prompt = await fs.readFile(path.join(agentDir, 'prompt.md'), 'utf-8')
    } catch {
      // Will error at execution time
    }
  }

  // Read schema.json
  let inputSchema: object | undefined
  let outputSchema: object | undefined
  try {
    const schemaRaw = await fs.readFile(path.join(agentDir, 'schema.json'), 'utf-8')
    const schemas = JSON.parse(schemaRaw)
    inputSchema = schemas.input
    outputSchema = schemas.output
  } catch {
    // Optional
  }

  // Custom tools
  const customTools = manifest.custom_tools || undefined

  // Detect entrypoint for code_runtime
  let entrypoint: string | undefined
  if (engine === 'code_runtime') {
    entrypoint = manifest.entrypoint || (await detectEntrypoint(agentDir)) || undefined
  }

  return { manifest, engine, entrypoint, prompt, outputSchema, inputSchema, customTools, agentDir }
}

// ─── Agent execution ────────────────────────────────────────────────────────

/**
 * Execute a code_runtime agent: spawn entrypoint with stdin JSON, return stdout.
 */
async function executeCodeRuntime(
  config: AgentConfig,
  input: Record<string, unknown>,
  verbose: boolean
): Promise<unknown> {
  if (!config.entrypoint) {
    throw new Error('No entrypoint found. Set "entrypoint" in orchagent.json or create main.py/main.js.')
  }

  const entrypoint = config.entrypoint
  const isJs = entrypoint.endsWith('.js') || entrypoint.endsWith('.ts') ||
               entrypoint.endsWith('.mjs') || entrypoint.endsWith('.cjs')
  const cmd = isJs ? 'node' : 'python3'
  const inputJson = JSON.stringify(input)

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, [entrypoint], {
      cwd: config.agentDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ORCHAGENT_LOCAL_EXECUTION: 'true' },
    })

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      stderr += text
      if (verbose) {
        process.stderr.write(text)
      }
    })

    proc.stdin?.write(inputJson)
    proc.stdin?.end()

    proc.on('close', (code) => {
      if (code !== 0) {
        const detail = stderr.trim() ? `\n${stderr.trim()}` : ''
        reject(new Error(`Entrypoint exited with code ${code}${detail}`))
        return
      }
      const trimmed = stdout.trim()
      if (!trimmed) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(trimmed))
      } catch {
        // Return raw output wrapped
        resolve({ raw_output: trimmed })
      }
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn ${cmd}: ${err.message}`))
    })
  })
}

/**
 * Execute a direct_llm agent: call LLM with prompt + input.
 */
async function executeDirectLlm(
  config: AgentConfig,
  input: Record<string, unknown>,
  verbose: boolean,
  resolvedConfig?: ResolvedConfig
): Promise<unknown> {
  if (!config.prompt) {
    throw new Error('No prompt.md found. Create prompt.md in the agent directory.')
  }

  const supportedProviders = config.manifest.supported_providers || (['any'] as LlmProvider[])
  const detected = await detectLlmKey(supportedProviders as LlmProvider[], resolvedConfig)

  if (!detected) {
    throw new Error(
      `No LLM key found. Set an environment variable (e.g., OPENAI_API_KEY) or add one to .env`
    )
  }

  const { provider, key, model: serverModel } = detected
  const model = serverModel
    || config.manifest.default_models?.[provider as keyof typeof config.manifest.default_models]
    || getDefaultModel(provider)

  if (verbose) {
    process.stderr.write(`  LLM: ${provider} (${model})\n`)
  }

  const prompt = buildPrompt(config.prompt, input)
  return await callLlm(provider, key, model, prompt, config.outputSchema)
}

/**
 * Execute a managed_loop agent: spawn agent_runner.py with temp files.
 */
async function executeManagedLoop(
  config: AgentConfig,
  input: Record<string, unknown>,
  verbose: boolean,
  resolvedConfig?: ResolvedConfig
): Promise<unknown> {
  if (!config.prompt) {
    throw new Error('No prompt.md found. Create prompt.md in the agent directory.')
  }

  const supportedProviders = config.manifest.supported_providers || (['any'] as LlmProvider[])
  const detected = await detectLlmKey(supportedProviders as LlmProvider[], resolvedConfig)

  if (!detected) {
    throw new Error(
      `No LLM key found. Set an environment variable (e.g., OPENAI_API_KEY) or add one to .env`
    )
  }

  const { provider, key: apiKey, model: serverModel } = detected
  const model = serverModel
    || config.manifest.default_models?.[provider as keyof typeof config.manifest.default_models]
    || getDefaultModel(provider)
  const apiKeyEnvVar = PROVIDER_ENV_VARS[provider]

  if (verbose) {
    process.stderr.write(`  LLM: ${provider} (${model})\n`)
  }

  // Create temp directory with agent files
  const tempDir = path.join(os.tmpdir(), `orchagent-dev-${Date.now()}`)
  await fs.mkdir(tempDir, { recursive: true })

  try {
    // Copy agent_runner.py from resources
    const runnerSource = path.join(__dirname, '..', 'resources', 'agent_runner.py')
    let runnerContent: string
    try {
      runnerContent = await fs.readFile(runnerSource, 'utf-8')
    } catch {
      const altSource = path.join(__dirname, '..', '..', 'src', 'resources', 'agent_runner.py')
      runnerContent = await fs.readFile(altSource, 'utf-8')
    }

    await fs.writeFile(path.join(tempDir, 'agent_runner.py'), runnerContent)
    await fs.writeFile(path.join(tempDir, 'prompt.md'), config.prompt)
    await fs.writeFile(path.join(tempDir, 'input.json'), JSON.stringify(input, null, 2))

    if (config.outputSchema) {
      await fs.writeFile(path.join(tempDir, 'output_schema.json'), JSON.stringify(config.outputSchema))
    }
    if (config.customTools && config.customTools.length > 0) {
      await fs.writeFile(path.join(tempDir, 'custom_tools.json'), JSON.stringify(config.customTools))
    }

    const subprocessEnv: Record<string, string | undefined> = { ...process.env }
    subprocessEnv.LOCAL_MODE = '1'
    subprocessEnv.LLM_PROVIDER = provider
    subprocessEnv.LLM_MODEL = model
    if (apiKeyEnvVar && apiKey) {
      subprocessEnv[apiKeyEnvVar] = apiKey
    }

    const maxTurns = config.manifest.max_turns || 25

    return await new Promise((resolve, reject) => {
      const proc = spawn('python3', ['agent_runner.py', '--max-turns', String(maxTurns), '--verbose'], {
        cwd: tempDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: subprocessEnv,
      })

      proc.stdin.end()

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })

      proc.stderr?.on('data', (data: Buffer) => {
        const text = data.toString()
        stderr += text
        if (verbose) {
          for (const line of text.split('\n')) {
            if (line.startsWith('@@ORCHAGENT_EVENT:')) continue
            if (line.trim() === '.' || line.trim() === '') continue
            process.stderr.write(`  ${line}\n`)
          }
        }
      })

      proc.on('close', (code) => {
        if (stdout.trim()) {
          try {
            const result = JSON.parse(stdout.trim())
            if (code !== 0 && typeof result === 'object' && result !== null && 'error' in result) {
              reject(new Error(String(result.error)))
              return
            }
            resolve(result)
          } catch {
            if (code !== 0) {
              reject(new Error(`Agent exited with code ${code}`))
            } else {
              resolve({ raw_output: stdout.trim() })
            }
          }
        } else if (code !== 0) {
          reject(new Error(`Agent exited with code ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : ''}`))
        } else {
          resolve({})
        }
      })

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn python3: ${err.message}`))
      })
    })
  } finally {
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Execute an agent with the given input, dispatching by engine type.
 */
export async function executeAgent(
  config: AgentConfig,
  input: Record<string, unknown>,
  verbose: boolean,
  resolvedConfig?: ResolvedConfig
): Promise<unknown> {
  switch (config.engine) {
    case 'code_runtime':
      return executeCodeRuntime(config, input, verbose)
    case 'direct_llm':
      return executeDirectLlm(config, input, verbose, resolvedConfig)
    case 'managed_loop':
      return executeManagedLoop(config, input, verbose, resolvedConfig)
  }
}

// ─── HTTP server ────────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(json)
}

export type DevServerHandle = {
  server: http.Server
  close: () => Promise<void>
}

export function createDevServer(
  port: number,
  verbose: boolean,
  getConfig: () => AgentConfig | null,
  callbacks: DevServerCallbacks = {}
): DevServerHandle {
  let requestCounter = 0

  const server = http.createServer(async (req, res) => {
    const startTime = Date.now()
    const reqId = ++requestCounter
    const method = req.method || 'GET'
    const urlPath = req.url || '/'

    // CORS preflight
    if (method === 'OPTIONS') {
      sendJson(res, 204, null)
      return
    }

    // GET /health — agent info
    if (method === 'GET' && (urlPath === '/health' || urlPath === '/info')) {
      const config = getConfig()
      if (!config) {
        sendJson(res, 503, { status: 'error', error: 'Agent configuration invalid' })
        return
      }
      sendJson(res, 200, {
        status: 'ok',
        agent: config.manifest.name,
        version: config.manifest.version,
        type: config.manifest.type,
        engine: config.engine,
        entrypoint: config.entrypoint,
        has_prompt: Boolean(config.prompt),
        has_schema: Boolean(config.inputSchema || config.outputSchema),
      })
      return
    }

    // GET / — usage page
    if (method === 'GET' && urlPath === '/') {
      const config = getConfig()
      const name = config?.manifest.name || 'unknown'
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(
        `orchagent dev server — ${name}\n\n` +
        `Endpoints:\n` +
        `  POST /       Run agent with JSON body\n` +
        `  POST /run    Run agent with JSON body\n` +
        `  GET  /health Agent configuration info\n\n` +
        `Example:\n` +
        `  curl -X POST http://localhost:${port}/run \\\n` +
        `    -H "Content-Type: application/json" \\\n` +
        `    -d '{"task": "hello world"}'\n`
      )
      return
    }

    // POST / or POST /run — execute agent
    if (method === 'POST' && (urlPath === '/' || urlPath === '/run')) {
      const config = getConfig()
      if (!config) {
        const log: RequestLog = {
          id: reqId, method, path: urlPath, statusCode: 503,
          durationMs: Date.now() - startTime, error: 'Agent configuration invalid',
        }
        callbacks.onRequest?.(log)
        sendJson(res, 503, { error: 'Agent configuration invalid. Check console for validation errors.' })
        return
      }

      let input: Record<string, unknown>
      try {
        const body = await readBody(req)
        input = body.trim() ? JSON.parse(body) : {}
      } catch {
        const log: RequestLog = {
          id: reqId, method, path: urlPath, statusCode: 400,
          durationMs: Date.now() - startTime, error: 'Invalid JSON body',
        }
        callbacks.onRequest?.(log)
        sendJson(res, 400, { error: 'Invalid JSON body' })
        return
      }

      const inputPreview = JSON.stringify(input).slice(0, 80)

      try {
        const resolvedCfg = await getResolvedConfig()
        const result = await executeAgent(config, input, verbose, resolvedCfg)
        const durationMs = Date.now() - startTime

        const log: RequestLog = {
          id: reqId, method, path: urlPath, statusCode: 200,
          durationMs, inputPreview,
        }
        callbacks.onRequest?.(log)
        sendJson(res, 200, result)
      } catch (err) {
        const durationMs = Date.now() - startTime
        const message = err instanceof Error ? err.message : String(err)
        const log: RequestLog = {
          id: reqId, method, path: urlPath, statusCode: 500,
          durationMs, inputPreview, error: message,
        }
        callbacks.onRequest?.(log)
        callbacks.onError?.(err instanceof Error ? err : new Error(message))
        sendJson(res, 500, { error: message })
      }
      return
    }

    // 404 for everything else
    sendJson(res, 404, { error: `Not found: ${method} ${urlPath}` })
  })

  const close = (): Promise<void> => {
    return new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  return { server, close }
}
