import type { Org, PublicAgent, ResolvedConfig, Agent, AgentManifest, User } from '../types'
import { NetworkError } from './errors'
import packageJson from '../../package.json'

const DEFAULT_TIMEOUT_MS = 15000
const CALL_TIMEOUT_MS = 120000  // 2 minutes for agent calls (can take time)
const MAX_RETRIES = 3
const BASE_DELAY_MS = 1000

export interface SafeFetchOptions extends RequestInit {
  /** Override the default timeout (ms). Use for long-running operations. */
  timeoutMs?: number
}

export async function safeFetch(url: string, options?: SafeFetchOptions): Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const { timeoutMs: _, ...fetchOptions } = options ?? {}

  try {
    return await fetch(url, {
      ...fetchOptions,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new NetworkError(url, err)
    }
    // Network errors (ECONNREFUSED, DNS failure, etc.)
    throw new NetworkError(url, err instanceof Error ? err : undefined)
  }
}

/**
 * safeFetch with retry logic for connection failures.
 * Use for important operations that should retry on transient errors.
 */
export async function safeFetchWithRetryForCalls(
  url: string,
  options?: SafeFetchOptions
): Promise<Response> {
  let lastError: Error | undefined
  const timeoutMs = options?.timeoutMs ?? CALL_TIMEOUT_MS

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await safeFetch(url, { ...options, timeoutMs })

      // Don't retry client errors (except 429)
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        return response
      }

      // Retry on 5xx or 429
      if (response.status >= 500 || response.status === 429) {
        // Read body to check if error is retryable
        const bodyText = await response.text().catch(() => '')
        let parsed: Record<string, unknown> | null = null
        try { parsed = JSON.parse(bodyText) } catch { /* ignore */ }
        const isRetryable = (parsed?.error as Record<string, unknown>)?.is_retryable

        // Don't retry if server explicitly says error is not retryable
        if (isRetryable === false) {
          return new Response(bodyText, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          })
        }

        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1)
          const jitter = Math.random() * 500
          process.stderr.write(`Server error (${response.status}), retrying in ${Math.round((delay + jitter) / 1000)}s...\n`)
          await new Promise(r => setTimeout(r, delay + jitter))
          continue
        }

        // Last attempt — return reconstructed response (body was consumed)
        return new Response(bodyText, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      }

      return response
    } catch (error) {
      lastError = error as Error
      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1)
        const jitter = Math.random() * 500
        process.stderr.write(`Connection error, retrying in ${Math.round((delay + jitter) / 1000)}s...\n`)
        await new Promise(r => setTimeout(r, delay + jitter))
      }
    }
  }

  throw lastError ?? new NetworkError(url)
}

async function safeFetchWithRetry(
  url: string,
  options?: RequestInit
): Promise<Response> {
  let lastError: Error | undefined

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await safeFetch(url, options)

      // Don't retry client errors (except 429)
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        return response
      }

      // Retry on 5xx or 429
      if (response.status >= 500 || response.status === 429) {
        // Read body to check if error is retryable
        const bodyText = await response.text().catch(() => '')
        let parsed: Record<string, unknown> | null = null
        try { parsed = JSON.parse(bodyText) } catch { /* ignore */ }
        const isRetryable = (parsed?.error as Record<string, unknown>)?.is_retryable

        // Don't retry if server explicitly says error is not retryable
        if (isRetryable === false) {
          return new Response(bodyText, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          })
        }

        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1)
          const jitter = Math.random() * 500
          process.stderr.write(`Server error (${response.status}), retrying in ${Math.round((delay + jitter) / 1000)}s...\n`)
          await new Promise(r => setTimeout(r, delay + jitter))
          continue
        }

        // Last attempt — return reconstructed response (body was consumed)
        return new Response(bodyText, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      }

      return response
    } catch (error) {
      lastError = error as Error
      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1)
        const jitter = Math.random() * 500
        process.stderr.write(`Network error, retrying in ${Math.round((delay + jitter) / 1000)}s...\n`)
        await new Promise(r => setTimeout(r, delay + jitter))
      }
    }
  }

  throw lastError ?? new NetworkError(url)
}

export class ApiError extends Error {
  status: number
  payload?: unknown

  constructor(message: string, status: number, payload?: unknown) {
    super(message)
    this.status = status
    this.payload = payload
  }
}

function buildUrl(apiUrl: string, path: string): string {
  return `${apiUrl.replace(/\/$/, '')}${path}`
}

async function parseError(response: Response): Promise<ApiError> {
  const text = await response.text()
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    payload = text
  }

  const message =
    typeof payload === 'object' && payload
      ? (payload as { error?: { message?: string }; message?: string }).error
          ?.message ||
        (payload as { message?: string }).message ||
        response.statusText
      : response.statusText

  return new ApiError(message, response.status, payload)
}

export async function request<T>(
  config: ResolvedConfig,
  method: string,
  path: string,
  options: { body?: BodyInit; headers?: Record<string, string> } = {}
): Promise<T> {
  if (!config.apiKey) {
    throw new ApiError('Missing API key. Run `orchagent login` first.', 401)
  }

  const response = await safeFetchWithRetry(buildUrl(config.apiUrl, path), {
    method,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'X-CLI-Version': packageJson.version,
      ...(options.headers ?? {}),
    },
    body: options.body,
  })

  if (!response.ok) {
    throw await parseError(response)
  }

  return (await response.json()) as T
}

export async function publicRequest<T>(
  config: ResolvedConfig,
  path: string
): Promise<T> {
  // Pass API key if available - allows server to skip IP-based rate limiting
  // for authenticated users while still using the public endpoint for data
  const headers: Record<string, string> = {}
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`
  }

  const response = await safeFetchWithRetry(buildUrl(config.apiUrl, path), { headers })
  if (!response.ok) {
    throw await parseError(response)
  }
  return (await response.json()) as T
}

export async function getOrg(config: ResolvedConfig, workspaceId?: string): Promise<Org> {
  const headers: Record<string, string> = {}
  if (workspaceId) headers['X-Workspace-Id'] = workspaceId
  return request<Org>(config, 'GET', '/org', { headers })
}

export async function updateOrg(
  config: ResolvedConfig,
  payload: Partial<Org>
): Promise<Org> {
  return request<Org>(config, 'PATCH', '/org', {
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function getPublicAgent(
  config: ResolvedConfig,
  org: string,
  agent: string,
  version: string
): Promise<PublicAgent> {
  return publicRequest<PublicAgent>(
    config,
    `/public/agents/${org}/${agent}/${version}`
  )
}

export type CostEstimateProvider = {
  provider: string
  model: string
  runs: number
  total_cost_usd: number
  avg_cost_usd: number
}

export type CostEstimate = {
  sample_size: number
  avg_cost_usd?: number
  p50_cost_usd?: number
  p95_cost_usd?: number
  avg_input_tokens?: number
  avg_output_tokens?: number
  avg_duration_ms?: number | null
  success_rate?: number
  provider_breakdown?: CostEstimateProvider[]
  period_days?: number
}

export type CostEstimateResponse = {
  agent: string
  type: string
  execution_engine: string | null
  supported_providers: string[]
  estimate: CostEstimate
  metadata: { request_id: string }
}

export async function getAgentCostEstimate(
  config: ResolvedConfig,
  org: string,
  agent: string,
  version: string,
  workspaceId?: string
): Promise<CostEstimateResponse> {
  const path = `/public/agents/${org}/${agent}/${version}/cost-estimate`
  if (workspaceId && config.apiKey) {
    return request<CostEstimateResponse>(config, 'GET', path, {
      headers: { 'X-Workspace-Id': workspaceId },
    })
  }
  return publicRequest<CostEstimateResponse>(config, path)
}

export async function listMyAgents(config: ResolvedConfig, workspaceId?: string): Promise<Agent[]> {
  const headers: Record<string, string> = {}
  if (workspaceId) headers['X-Workspace-Id'] = workspaceId
  return request<Agent[]>(config, 'GET', '/agents', { headers })
}

export async function createAgent(
  config: ResolvedConfig,
  data: {
    name: string
    version?: string  // Server auto-assigns if not provided
    type: 'agent' | 'skill' | 'prompt' | 'tool' | 'agentic' | 'code'
    run_mode?: 'on_demand' | 'always_on'
    runtime?: { command?: string; [key: string]: unknown }
    loop?: { [key: string]: unknown }
    callable?: boolean
    description?: string
    prompt?: string
    url?: string
    input_schema?: object
    output_schema?: object
    tags?: string[]
    is_public?: boolean
    supported_providers?: string[]
    default_models?: Record<string, string>
    timeout_seconds?: number
    // Local run support for tool agents
    source_url?: string
    pip_package?: string
    run_command?: string
    // SDK compatibility flag
    sdk_compatible?: boolean
    // Orchestration manifest (includes dependencies)
    manifest?: object
    // Workspace secrets to inject as env vars in sandbox
    required_secrets?: string[]
    // Skills configuration
    default_skills?: string[]
    skills_locked?: boolean
    // SC-05: Multi-file skill content
    skill_files?: { path: string; content: string; size: number }[]
    // Local download toggle
    allow_local_download?: boolean
    // Environment pinning (python_version, node_version, pip_flags, npm_flags)
    environment?: { python_version?: string; node_version?: string; pip_flags?: string; npm_flags?: string }
  },
  workspaceId?: string
): Promise<{ agent: Agent; service_key?: string; services_updated?: number }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (workspaceId) headers['X-Workspace-Id'] = workspaceId
  return request(config, 'POST', '/agents', {
    body: JSON.stringify(data),
    headers,
  })
}

/**
 * Download a code-runtime bundle for local execution.
 */
export async function downloadCodeBundle(
  config: ResolvedConfig,
  org: string,
  agent: string,
  version: string
): Promise<Buffer> {
  const response = await safeFetch(
    `${config.apiUrl.replace(/\/$/, '')}/public/agents/${org}/${agent}/${version}/bundle`
  )

  if (!response.ok) {
    throw await parseError(response)
  }

  const arrayBuffer = await response.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

/**
 * Upload a code bundle for a hosted tool agent.
 */
export async function uploadCodeBundle(
  config: ResolvedConfig,
  agentId: string,
  bundlePath: string,
  entrypoint?: string,
  workspaceId?: string
): Promise<{
  success: boolean
  code_hash: string
  bundle_size_bytes: number
  environment_id?: string
  environment_source?: 'dockerfile_new' | 'dockerfile_reused' | 'workspace_default' | null
  services_updated?: number
}> {
  if (!config.apiKey) {
    throw new ApiError('Missing API key. Run `orchagent login` first.', 401)
  }

  // Read the bundle file
  const fs = await import('fs/promises')
  const buffer = await fs.readFile(bundlePath)
  const blob = new Blob([buffer], { type: 'application/zip' })

  // Create form data
  const formData = new FormData()
  formData.append('file', blob, 'bundle.zip')

  // Build headers
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
  }
  if (entrypoint) {
    headers['x-entrypoint'] = entrypoint
  }
  if (workspaceId) {
    headers['X-Workspace-Id'] = workspaceId
  }

  const response = await safeFetch(
    `${config.apiUrl.replace(/\/$/, '')}/agents/${agentId}/upload`,
    {
      method: 'POST',
      headers,
      body: formData,
    }
  )

  if (!response.ok) {
    throw await parseError(response)
  }

  return (await response.json()) as {
    success: boolean
    code_hash: string
    bundle_size_bytes: number
    environment_id?: string
    environment_source?: 'dockerfile_new' | 'dockerfile_reused' | 'workspace_default' | null
    environment_status?: 'building' | 'ready'
  }
}

/**
 * Get single agent by name/version from authenticated endpoint.
 */
export async function getMyAgent(
  config: ResolvedConfig,
  agentName: string,
  version: string,
  workspaceId?: string
): Promise<Agent | null> {
  const agents = await listMyAgents(config, workspaceId)
  const matching = agents.filter(a => a.name === agentName)
  if (matching.length === 0) return null

  if (version === 'latest') {
    return matching.sort((a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )[0]
  }
  return matching.find(a => a.version === version) ?? null
}

/**
 * Try public endpoint first, fallback to authenticated for private agents.
 */
export async function getAgentWithFallback(
  config: ResolvedConfig,
  org: string,
  agentName: string,
  version: string,
  workspaceId?: string
): Promise<PublicAgent | Agent> {
  try {
    return await getPublicAgent(config, org, agentName, version)
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 404) throw err
  }

  if (!config.apiKey) {
    throw new ApiError(`Agent '${org}/${agentName}@${version}' not found`, 404)
  }

  const userOrg = await getOrg(config, workspaceId)
  if (userOrg.slug !== org) {
    throw new ApiError(`Agent '${org}/${agentName}@${version}' not found`, 404)
  }

  const myAgent = await getMyAgent(config, agentName, version, workspaceId)
  if (!myAgent) {
    throw new ApiError(`Agent '${org}/${agentName}@${version}' not found`, 404)
  }
  return myAgent
}

/**
 * Resolve a workspace ID from an org slug.
 * Returns undefined for personal orgs or if unauthenticated.
 */
export async function resolveWorkspaceIdForOrg(
  config: ResolvedConfig,
  orgSlug: string
): Promise<string | undefined> {
  if (!config.apiKey) return undefined
  try {
    const { workspaces } = await request<{ workspaces: Array<{ id: string; slug: string }> }>(
      config, 'GET', '/workspaces'
    )
    return workspaces.find(w => w.slug === orgSlug)?.id
  } catch {
    return undefined
  }
}

/**
 * Download a tool bundle for a private agent using authenticated endpoint.
 */
export async function downloadCodeBundleAuthenticated(
  config: ResolvedConfig,
  agentId: string,
  workspaceId?: string
): Promise<Buffer> {
  if (!config.apiKey) {
    throw new ApiError('Missing API key for authenticated bundle download', 401)
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
  }
  if (workspaceId) headers['X-Workspace-Id'] = workspaceId

  const response = await safeFetch(
    `${config.apiUrl.replace(/\/$/, '')}/agents/${agentId}/bundle`,
    { headers }
  )

  if (!response.ok) {
    const text = await response.text()
    let message = response.statusText
    try {
      const payload = JSON.parse(text)
      message = payload.error?.message || payload.message || message
    } catch {
      // Use default message
    }
    throw new ApiError(message, response.status)
  }

  const arrayBuffer = await response.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

/**
 * Check if an agent requires confirmation for deletion.
 */
export async function checkAgentDelete(
  config: ResolvedConfig,
  agentId: string,
  workspaceId?: string
): Promise<{ agent_id: string; agent_name: string; requires_confirmation: boolean }> {
  const headers: Record<string, string> = {}
  if (workspaceId) headers['X-Workspace-Id'] = workspaceId
  return request(config, 'GET', `/agents/${agentId}/delete-check`, { headers })
}

/**
 * Soft delete an agent.
 */
export async function deleteAgent(
  config: ResolvedConfig,
  agentId: string,
  confirmationName?: string,
  workspaceId?: string
): Promise<{ deleted: boolean; agent_id: string; agent_name: string }> {
  const params = confirmationName ? `?confirmation_name=${encodeURIComponent(confirmationName)}` : ''
  const headers: Record<string, string> = {}
  if (workspaceId) headers['X-Workspace-Id'] = workspaceId
  return request(config, 'DELETE', `/agents/${agentId}${params}`, { headers })
}

export interface ForkAgentResponse {
  agent: Agent
  service_key?: string
  service_key_prefix?: string
}

/**
 * Fork a public agent into the caller's workspace (or an explicit workspace_id).
 */
export async function forkAgent(
  config: ResolvedConfig,
  sourceAgentId: string,
  data: { workspace_id?: string; new_name?: string } = {}
): Promise<ForkAgentResponse> {
  return request<ForkAgentResponse>(config, 'POST', `/agents/${sourceAgentId}/fork`, {
    body: JSON.stringify(data),
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Check if an agent can be transferred to another workspace.
 */
export async function checkAgentTransfer(
  config: ResolvedConfig,
  agentId: string,
  targetWorkspaceId: string
): Promise<{
  can_transfer: boolean
  blockers: string[]
  warnings: string[]
  details: { version_count: number; grants_count: number; keys_count: number; schedules_count: number }
}> {
  return request(config, 'GET', `/agents/${agentId}/transfer-check?target_workspace_id=${encodeURIComponent(targetWorkspaceId)}`)
}

/**
 * Transfer an agent to another workspace.
 */
export async function transferAgent(
  config: ResolvedConfig,
  agentId: string,
  data: { target_workspace_id: string; confirmation_name: string }
): Promise<{
  transfer_id: string
  agent_name: string
  versions_transferred: number
  source_workspace: { id: string; slug: string; name: string }
  target_workspace: { id: string; slug: string; name: string }
  cleanup: { grants_revoked: number; keys_deleted: number; schedules_disabled: number }
}> {
  return request(config, 'POST', `/agents/${agentId}/transfer`, {
    body: JSON.stringify(data),
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Preview the next version number for an agent.
 */
export async function previewAgentVersion(
  config: ResolvedConfig,
  agentName: string,
  workspaceId?: string
): Promise<{ name: string; existing_versions: string[]; next_version: string; org_slug: string }> {
  const headers: Record<string, string> = {}
  if (workspaceId) headers['X-Workspace-Id'] = workspaceId
  return request(config, 'GET', `/agents/preview?name=${encodeURIComponent(agentName)}`, { headers })
}

/**
 * Validate an agent publish payload without actually creating the agent.
 * Runs server-side validation (name, tier limits, manifest, dependencies, etc.)
 * and returns a validation report. Used by --dry-run.
 */
export async function validateAgentPublish(
  config: ResolvedConfig,
  data: {
    name: string
    type: string
    description?: string
    prompt?: string
    url?: string
    input_schema?: object
    output_schema?: object
    is_public?: boolean
    callable?: boolean
    run_mode?: string
    runtime?: { command?: string; [key: string]: unknown }
    loop?: { [key: string]: unknown }
    default_endpoint?: string
    timeout_seconds?: number
    manifest?: object
    supported_providers?: string[]
    default_models?: Record<string, string>
    required_secrets?: string[]
    default_skills?: string[]
    skills_locked?: boolean
    sdk_compatible?: boolean
    run_command?: string
    skill_files?: { path: string; content: string; size: number }[]
    allow_local_download?: boolean
    environment?: { python_version?: string; node_version?: string; pip_flags?: string; npm_flags?: string }
  },
  workspaceId?: string
): Promise<{ valid: boolean; errors: string[]; warnings: string[] }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (workspaceId) headers['X-Workspace-Id'] = workspaceId
  return request(config, 'POST', '/agents/validate', {
    body: JSON.stringify(data),
    headers,
  })
}

/**
 * Report a skill installation to the backend.
 * Only tracks authenticated installs (requires API key).
 * Fire-and-forget - errors are silently ignored.
 */
export async function reportInstall(
  config: ResolvedConfig,
  org: string,
  skill: string,
  version: string,
  cliVersion: string
): Promise<void> {
  if (!config.apiKey) return

  await request(config, 'POST', `/agents/${org}/${skill}/${version}/install`, {
    headers: { 'X-CLI-Version': cliVersion },
  })
}

/**
 * Fetch the current user's profile from the server.
 */
export async function fetchUserProfile(config: ResolvedConfig): Promise<User> {
  const result = await request<{ user: User }>(config, 'GET', '/users/me')
  return result.user
}

// ============================================
// ENVIRONMENT API FUNCTIONS
// ============================================

export interface AgentEnvironment {
  id: string
  workspace_id: string | null
  name: string
  dockerfile_content: string
  dockerfile_hash: string
  is_predefined: boolean
  created_by_clerk_user_id: string | null
  created_at: string
  updated_at: string
}

export interface EnvironmentBuild {
  id: string
  environment_id: string
  provider: string
  provider_template_id: string | null
  status: 'pending' | 'building' | 'ready' | 'failed'
  build_logs: string | null
  error_message: string | null
  started_at: string | null
  completed_at: string | null
}

export interface EnvironmentWithBuild {
  environment: AgentEnvironment
  build: EnvironmentBuild | null
  agent_count: number
}

export interface ListEnvironmentsResponse {
  environments: EnvironmentWithBuild[]
  default_environment_id: string | null
}

export interface CreateEnvironmentResponse {
  environment: AgentEnvironment
  build: EnvironmentBuild | null
  reused: boolean
}

/**
 * List environments in a workspace (plus predefined).
 */
export async function listEnvironments(
  config: ResolvedConfig,
  workspaceId?: string
): Promise<ListEnvironmentsResponse> {
  const params = workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : ''
  return request<ListEnvironmentsResponse>(config, 'GET', `/environments${params}`)
}

/**
 * Get environment details including build status.
 */
export async function getEnvironment(
  config: ResolvedConfig,
  environmentId: string
): Promise<EnvironmentWithBuild> {
  return request<EnvironmentWithBuild>(config, 'GET', `/environments/${environmentId}`)
}

/**
 * Create a new environment from Dockerfile.
 */
export async function createEnvironment(
  config: ResolvedConfig,
  name: string,
  dockerfileContent: string
): Promise<CreateEnvironmentResponse> {
  return request<CreateEnvironmentResponse>(config, 'POST', '/environments', {
    body: JSON.stringify({ name, dockerfile_content: dockerfileContent }),
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Delete an environment (must have no agents using it).
 */
export async function deleteEnvironment(
  config: ResolvedConfig,
  environmentId: string
): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(config, 'DELETE', `/environments/${environmentId}`)
}

/**
 * Set workspace default environment.
 */
export async function setWorkspaceDefaultEnvironment(
  config: ResolvedConfig,
  workspaceId: string,
  environmentId: string | null
): Promise<{ success: boolean; default_environment_id: string | null }> {
  return request(config, 'POST', `/environments/workspaces/${workspaceId}/default-environment`, {
    body: JSON.stringify({ environment_id: environmentId }),
    headers: { 'Content-Type': 'application/json' },
  })
}

// ============================================
// AGENT SERVICE KEY MANAGEMENT
// ============================================

export interface AgentKey {
  id: string
  prefix: string
  created_at: string
  last_used_at: string | null
}

export async function listAgentKeys(
  config: ResolvedConfig,
  agentId: string,
  workspaceId?: string
): Promise<{ keys: AgentKey[] }> {
  const headers: Record<string, string> = {}
  if (workspaceId) headers['X-Workspace-Id'] = workspaceId
  return request<{ keys: AgentKey[] }>(config, 'GET', `/agents/${agentId}/keys`, { headers })
}

export async function createAgentKey(
  config: ResolvedConfig,
  agentId: string,
  workspaceId?: string
): Promise<{ key: string; prefix: string }> {
  const headers: Record<string, string> = {}
  if (workspaceId) headers['X-Workspace-Id'] = workspaceId
  return request<{ key: string; prefix: string }>(config, 'POST', `/agents/${agentId}/keys`, { headers })
}

export async function deleteAgentKey(
  config: ResolvedConfig,
  agentId: string,
  keyId: string,
  workspaceId?: string
): Promise<{ deleted: boolean }> {
  const headers: Record<string, string> = {}
  if (workspaceId) headers['X-Workspace-Id'] = workspaceId
  return request<{ deleted: boolean }>(config, 'DELETE', `/agents/${agentId}/keys/${keyId}`, { headers })
}
