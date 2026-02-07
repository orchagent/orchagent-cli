import type { Org, PublicAgent, ResolvedConfig, Agent, AgentManifest, User } from '../types'
import { NetworkError } from './errors'

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
        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1)
          const jitter = Math.random() * 500
          process.stderr.write(`Request failed (${response.status}), retrying in ${Math.round((delay + jitter) / 1000)}s...\n`)
          await new Promise(r => setTimeout(r, delay + jitter))
          continue
        }
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
        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1)
          const jitter = Math.random() * 500
          process.stderr.write(`Request failed (${response.status}), retrying in ${Math.round((delay + jitter) / 1000)}s...\n`)
          await new Promise(r => setTimeout(r, delay + jitter))
          continue
        }
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

export async function getOrg(config: ResolvedConfig): Promise<Org> {
  return request<Org>(config, 'GET', '/org')
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

export async function listPublicAgents(
  config: ResolvedConfig,
  options?: { sort?: 'stars' | 'recent' | 'name'; tags?: string[]; type?: string }
): Promise<PublicAgent[]> {
  const params = new URLSearchParams()
  if (options?.sort) params.append('sort', options.sort)
  if (options?.tags?.length) params.append('tags', options.tags.join(','))
  if (options?.type) params.append('type', options.type)
  const queryStr = params.toString()
  return publicRequest<PublicAgent[]>(
    config,
    `/public/agents${queryStr ? `?${queryStr}` : ''}`
  )
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

// GitHub-like features

export async function listMyAgents(config: ResolvedConfig): Promise<Agent[]> {
  return request<Agent[]>(config, 'GET', '/agents')
}

export async function createAgent(
  config: ResolvedConfig,
  data: {
    name: string
    version?: string  // Server auto-assigns if not provided
    type: 'prompt' | 'code' | 'skill' | 'agentic'
    description?: string
    prompt?: string
    url?: string
    input_schema?: object
    output_schema?: object
    tags?: string[]
    is_public?: boolean
    supported_providers?: string[]
    default_models?: Record<string, string>
    // Local run support for code agents
    source_url?: string
    pip_package?: string
    run_command?: string
    // SDK compatibility flag
    sdk_compatible?: boolean
    // Orchestration manifest (includes dependencies)
    manifest?: object
    // Skills configuration
    default_skills?: string[]
    skills_locked?: boolean
    // SC-05: Multi-file skill content
    skill_files?: { path: string; content: string; size: number }[]
    // Local download toggle
    allow_local_download?: boolean
  }
): Promise<{ agent: Agent; service_key?: string }> {
  return request(config, 'POST', '/agents', {
    body: JSON.stringify(data),
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function starAgent(
  config: ResolvedConfig,
  agentId: string
): Promise<{ starred: boolean }> {
  return request(config, 'POST', `/agents/${agentId}/star`)
}

export async function unstarAgent(
  config: ResolvedConfig,
  agentId: string
): Promise<void> {
  await request(config, 'DELETE', `/agents/${agentId}/star`)
}

export async function forkAgent(
  config: ResolvedConfig,
  agentId: string
): Promise<{ agent_id: string }> {
  return request(config, 'POST', `/agents/${agentId}/fork`)
}

export async function searchAgents(
  config: ResolvedConfig,
  query: string,
  options?: { sort?: 'stars' | 'recent' | 'name'; tags?: string[]; type?: string }
): Promise<PublicAgent[]> {
  const params = new URLSearchParams()
  if (query) params.append('search', query)
  if (options?.sort) params.append('sort', options.sort)
  if (options?.tags?.length) params.append('tags', options.tags.join(','))
  if (options?.type) params.append('type', options.type)
  const queryStr = params.toString()
  return publicRequest<PublicAgent[]>(
    config,
    `/public/agents${queryStr ? `?${queryStr}` : ''}`
  )
}

/**
 * Search within the authenticated user's own agents (public and private).
 * Uses the authenticated /agents endpoint with client-side filtering.
 */
export async function searchMyAgents(
  config: ResolvedConfig,
  query?: string,
  options?: { sort?: 'stars' | 'recent' | 'name'; type?: string }
): Promise<PublicAgent[]> {
  let agents = await listMyAgents(config)

  // Deduplicate: keep only latest version per agent name
  const latestByName = new Map<string, Agent>()
  for (const agent of agents) {
    const existing = latestByName.get(agent.name)
    if (!existing || new Date(agent.created_at) > new Date(existing.created_at)) {
      latestByName.set(agent.name, agent)
    }
  }
  agents = Array.from(latestByName.values())

  // Apply type filter
  if (options?.type) {
    const typeFilter = options.type
    if (typeFilter === 'agents') {
      agents = agents.filter(a => a.type === 'prompt' || a.type === 'code')
    } else if (typeFilter === 'skills' || typeFilter === 'skill') {
      agents = agents.filter(a => a.type === 'skill')
    } else if (typeFilter === 'code' || typeFilter === 'prompt') {
      agents = agents.filter(a => a.type === typeFilter)
    }
  }

  // Apply search filter (match against name and description)
  if (query) {
    const words = query.toLowerCase().replace(/-/g, ' ').split(/\s+/)
    agents = agents.filter(a => {
      const name = (a.name || '').toLowerCase().replace(/-/g, ' ')
      const desc = (a.description || '').toLowerCase()
      return words.every(w => name.includes(w) || desc.includes(w))
    })
  }

  // Map Agent to PublicAgent-compatible objects
  const org = await getOrg(config)
  return agents.map(a => ({
    id: a.id,
    org_name: org.name || org.slug || 'unknown',
    org_slug: a.org_slug || org.slug || 'unknown',
    name: a.name,
    version: a.version,
    type: a.type,
    description: a.description,
    stars_count: a.stars_count ?? 0,
    tags: a.tags ?? [],
    default_endpoint: a.default_endpoint || 'analyze',
    created_at: a.created_at,
    supported_providers: a.supported_providers ?? ['any'],
    is_public: a.is_public,
    pricing_mode: a.pricing_mode,
    price_per_call_cents: a.price_per_call_cents,
  } as PublicAgent))
}

// LLM Keys (for CLI to fetch server-stored keys)

export interface LlmKey {
  provider: string
  api_key: string
  endpoint_url?: string
  model?: string
}

export async function fetchLlmKeys(config: ResolvedConfig): Promise<LlmKey[]> {
  const result = await request<{ keys: LlmKey[] }>(config, 'GET', '/llm-keys/export')
  return result.keys
}

/**
 * Download a code bundle for local execution.
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
 * Upload a code bundle for a hosted code agent.
 */
export async function uploadCodeBundle(
  config: ResolvedConfig,
  agentId: string,
  bundlePath: string,
  entrypoint?: string
): Promise<{
  success: boolean
  code_hash: string
  bundle_size_bytes: number
  environment_id?: string
  environment_source?: 'dockerfile_new' | 'dockerfile_reused' | 'workspace_default' | null
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
  version: string
): Promise<Agent | null> {
  const agents = await listMyAgents(config)
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
  version: string
): Promise<PublicAgent | Agent> {
  try {
    return await getPublicAgent(config, org, agentName, version)
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 404) throw err
  }

  if (!config.apiKey) {
    throw new ApiError(`Agent '${org}/${agentName}@${version}' not found`, 404)
  }

  const userOrg = await getOrg(config)
  if (userOrg.slug !== org) {
    throw new ApiError(`Agent '${org}/${agentName}@${version}' not found`, 404)
  }

  const myAgent = await getMyAgent(config, agentName, version)
  if (!myAgent) {
    throw new ApiError(`Agent '${org}/${agentName}@${version}' not found`, 404)
  }
  return myAgent
}

/**
 * Download a code bundle for a private agent using authenticated endpoint.
 */
export async function downloadCodeBundleAuthenticated(
  config: ResolvedConfig,
  agentId: string
): Promise<Buffer> {
  if (!config.apiKey) {
    throw new ApiError('Missing API key for authenticated bundle download', 401)
  }

  const response = await safeFetch(
    `${config.apiUrl.replace(/\/$/, '')}/agents/${agentId}/bundle`,
    {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
    }
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
  agentId: string
): Promise<{ agent_id: string; agent_name: string; stars_count: number; fork_count: number; requires_confirmation: boolean }> {
  return request(config, 'GET', `/agents/${agentId}/delete-check`)
}

/**
 * Soft delete an agent.
 */
export async function deleteAgent(
  config: ResolvedConfig,
  agentId: string,
  confirmationName?: string
): Promise<{ deleted: boolean; agent_id: string; agent_name: string }> {
  const params = confirmationName ? `?confirmation_name=${encodeURIComponent(confirmationName)}` : ''
  return request(config, 'DELETE', `/agents/${agentId}${params}`)
}

/**
 * Preview the next version number for an agent.
 */
export async function previewAgentVersion(
  config: ResolvedConfig,
  agentName: string
): Promise<{ name: string; existing_versions: string[]; next_version: string; org_slug: string }> {
  return request(config, 'GET', `/agents/preview?name=${encodeURIComponent(agentName)}`)
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
// BILLING API TYPES AND FUNCTIONS
// ============================================

// Billing API types
export interface CreditTransaction {
  amount_cents: number
  balance_after_cents: number
  transaction_type: string
  created_at: string
  reference_id?: string
}

export interface CreditsBalanceResponse {
  balance_cents: number
  recent_transactions: CreditTransaction[]
}

export interface CreateCreditCheckoutResponse {
  checkout_url: string
  session_id: string
}

export interface SellerStatus {
  onboarded: boolean
  payouts_enabled?: boolean
  charges_enabled?: boolean
}

export interface SellerDashboardResponse {
  dashboard_url: string
}

export interface EarningsResponse {
  total_earnings_cents: number
  by_agent?: Array<{
    agent_name: string
    calls: number
    earnings_cents: number
  }>
  recent_transactions?: Array<{
    created_at: string
    agent_name: string
    sale_amount_cents: number
    earnings_cents: number
    fee_cents: number
  }>
}

// Billing API functions
export async function getCreditsBalance(
  config: ResolvedConfig
): Promise<CreditsBalanceResponse> {
  return request<CreditsBalanceResponse>(config, 'GET', '/billing/credits')
}

export async function createCreditCheckout(
  config: ResolvedConfig,
  amountCents: number
): Promise<CreateCreditCheckoutResponse> {
  return request<CreateCreditCheckoutResponse>(config, 'POST', '/billing/add-credits', {
    body: JSON.stringify({ amount_cents: amountCents }),
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function getSellerStatus(
  config: ResolvedConfig
): Promise<SellerStatus> {
  return request<SellerStatus>(config, 'GET', '/sellers/status')
}

export async function createSellerOnboarding(
  config: ResolvedConfig,
  country?: string
): Promise<{ onboarding_url: string }> {
  return request<{ onboarding_url: string }>(config, 'POST', '/sellers/onboard', {
    body: JSON.stringify({ country }),
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function getSellerDashboardLink(
  config: ResolvedConfig
): Promise<SellerDashboardResponse> {
  return request<SellerDashboardResponse>(config, 'POST', '/sellers/dashboard-link')
}

export async function getSellerEarnings(
  config: ResolvedConfig
): Promise<EarningsResponse> {
  return request<EarningsResponse>(config, 'GET', '/billing/earnings')
}

export async function setAgentPricing(
  config: ResolvedConfig,
  agentId: string,
  pricingMode: 'free' | 'per_call',
  pricePerCallCents?: number,
  allowLocalDownload?: boolean
): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(config, 'PUT', `/agents/${agentId}/pricing`, {
    body: JSON.stringify({
      pricing_mode: pricingMode,
      price_per_call_cents: pricePerCallCents,
      allow_local_download: allowLocalDownload,
    }),
    headers: { 'Content-Type': 'application/json' },
  })
}
