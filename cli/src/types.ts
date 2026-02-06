export type ConfigFile = {
  api_key?: string
  api_url?: string
  default_org?: string
  workspace?: string
  profiles?: Record<string, { api_key: string; api_url?: string }>
  default_formats?: string[]
  default_scope?: 'user' | 'project'
  default_provider?: string
  no_progress?: boolean
}

export type ResolvedConfig = {
  apiKey?: string
  apiUrl: string
  defaultOrg?: string
}

export type LlmConfig = {
  endpoint?: string
  model?: string
  api_key?: string
}

export type Org = {
  id: string
  name: string
  slug: string
  created_at: string
  default_llm_config?: LlmConfig | null
}

export type PublicAgent = {
  id: string
  org_name: string
  org_slug: string
  name: string
  version: string
  default_endpoint?: string
  created_at?: string | null
  // GitHub-like fields
  type?: 'prompt' | 'code' | 'skill'
  description?: string | null
  stars_count?: number
  tags?: string[]
  supported_providers?: LlmProvider[]
  // Schema fields (returned by detail endpoint)
  input_schema?: object
  output_schema?: object
  // Pricing fields
  org_id?: string
  pricing_mode?: 'free' | 'per_call' | null
  price_per_call_cents?: number | null
}

export type LlmProvider = 'openai' | 'anthropic' | 'gemini' | 'any'
// Note: 'any' is only used in supported_providers, not as an actual provider for keys

export type AgentManifest = {
  name: string
  version: string
  description?: string
  type: 'prompt' | 'code' | 'skill'
  prompt?: string
  input_schema?: object
  output_schema?: object
  tags?: string[]
  // New: which LLM providers this agent supports
  supported_providers?: LlmProvider[]
  // New: default model per provider (optional)
  default_models?: {
    openai?: string
    anthropic?: string
    gemini?: string
  }
  // For local execution of code agents
  source_url?: string      // Git URL to install from (e.g., "git+https://github.com/org/repo#subdirectory=agents/name")
  pip_package?: string     // PyPI package name if published there
  run_command?: string     // Command to run locally (e.g., "python -m leak_finder.cli")
  // Skills composition: default skills to inject
  default_skills?: string[]
  skills_locked?: boolean
  // Code hosting configuration
  entrypoint?: string      // Entry point file (default: main.py)
  bundle?: {
    include?: string[]     // Glob patterns to include
    exclude?: string[]     // Glob patterns to exclude
  }
  // Orchestration manifest (for orchestrator agents with dependencies)
  manifest?: {
    manifest_version?: number
    dependencies?: Array<{ id: string; version: string }>
    max_hops?: number
    timeout_ms?: number
    per_call_downstream_cap?: number
    downstream_spend_cap?: number
  }
  // DEPRECATED: llm_config is no longer used (keys are user-provided now)
  llm_config?: {
    endpoint?: string
    model?: string
  }
}

export type Agent = {
  id: string
  name: string
  version: string
  type: 'prompt' | 'code' | 'skill'
  description?: string
  stars_count?: number
  tags?: string[]
  supported_providers?: LlmProvider[]
  created_at: string
  org_slug?: string
  org_id?: string
  default_endpoint?: string
  prompt?: string
  input_schema?: object
  output_schema?: object
  default_models?: Record<string, string>
  source_url?: string
  pip_package?: string
  run_command?: string
  url?: string
  manifest?: object
  code_bundle_url?: string
  entrypoint?: string
  is_public?: boolean
  default_skills?: string[]
  skills_locked?: boolean
  pricing_mode?: 'free' | 'per_call' | null
  price_per_call_cents?: number | null
}

export type User = {
  id: string
  display_name: string
  email: string
  preferences?: {
    default_formats?: string[]
  }
}
