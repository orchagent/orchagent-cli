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
  type?: AgentTypeValue
  run_mode?: AgentRunMode | null
  execution_engine?: AgentExecutionEngine | null
  callable?: boolean
  description?: string | null
  tags?: string[]
  supported_providers?: LlmProvider[]
  // Schema fields (returned by detail endpoint)
  input_schema?: object
  output_schema?: object
  org_id?: string
  allow_local_download?: boolean
  required_secrets?: string[]
  optional_secrets?: string[]
}

export type LlmProvider = 'openai' | 'anthropic' | 'gemini' | 'any'
// Note: 'any' is only used in supported_providers, not as an actual provider for keys

export type AgentObjectType = 'prompt' | 'tool' | 'agent' | 'skill'
export type LegacyAgentObjectType = 'agentic' | 'code'
export type AgentTypeValue = AgentObjectType | LegacyAgentObjectType
export type AgentRunMode = 'on_demand' | 'always_on'
export type AgentExecutionEngine = 'direct_llm' | 'managed_loop' | 'code_runtime'

export type AgentManifest = {
  name: string
  version: string
  description?: string
  // Canonical values are "prompt" | "tool" | "agent" | "skill". Legacy aliases: "agentic" → "agent", "code" → "tool".
  type: AgentTypeValue
  run_mode?: AgentRunMode
  runtime?: {
    command?: string
    [key: string]: unknown
  }
  loop?: {
    max_turns?: number
    tools?: string[]
    [key: string]: unknown
  }
  callable?: boolean
  /** @deprecated Ignored by CLI. Use prompt.md file instead. */
  prompt?: string
  /** @deprecated Ignored by CLI. Use schema.json file instead. */
  input_schema?: object
  /** @deprecated Ignored by CLI. Use schema.json file instead. */
  output_schema?: object
  tags?: string[]
  // Managed loop fields (legacy aliases retained for compatibility)
  custom_tools?: Array<{
    name: string
    description: string
    command: string
    input_schema?: object
  }>
  max_turns?: number
  timeout_seconds?: number
  // New: which LLM providers this agent supports
  supported_providers?: LlmProvider[]
  // New: default model per provider (optional)
  default_models?: {
    openai?: string
    anthropic?: string
    gemini?: string
  }
  // For local execution of tool agents
  source_url?: string      // Git URL to install from (e.g., "git+https://github.com/org/repo#subdirectory=agents/name")
  pip_package?: string     // PyPI package name if published there
  run_command?: string     // Command to run locally (e.g., "python -m leak_finder.cli")
  // Workspace secrets to inject as env vars in sandbox
  required_secrets?: string[]
  // Optional secrets that unlock additional features
  optional_secrets?: string[]
  // Skills composition: default skills to inject
  default_skills?: string[]
  skills_locked?: boolean
  // Tool hosting configuration
  entrypoint?: string      // Entry point file (default: main.py)
  bundle?: {
    include?: string[]     // Glob patterns to include
    exclude?: string[]     // Glob patterns to exclude
  }
  // Environment pinning (optional runtime version/flag constraints)
  environment?: {
    python_version?: string   // e.g., "3.9", "3.11"
    node_version?: string     // e.g., "18", "20"
    pip_flags?: string        // e.g., "--no-deps", "--pre"
    npm_flags?: string        // e.g., "--legacy-peer-deps"
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
  type: AgentTypeValue
  run_mode?: AgentRunMode | null
  execution_engine?: AgentExecutionEngine | null
  callable?: boolean
  description?: string
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
  required_secrets?: string[]
  optional_secrets?: string[]
  default_skills?: string[]
  skills_locked?: boolean
  allow_local_download?: boolean
}

export type User = {
  id: string
  display_name: string
  email: string
  preferences?: {
    default_formats?: string[]
  }
}
