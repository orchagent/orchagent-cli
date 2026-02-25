import { parseAgentRef } from './agent-ref'
import type { AgentRef } from './agent-ref'
import { loadConfig } from './config'
import { resolveWorkspaceIdForOrg } from './api'
import { CliError } from './errors'
import type { ResolvedConfig } from '../types'

/**
 * Fully-resolved agent context returned by resolveAgentContext().
 * Every field is guaranteed non-null after resolution.
 */
export type ResolvedAgentContext = {
  /** The org slug (resolved from ref, config workspace, or defaultOrg) */
  org: string
  /** The agent name */
  agent: string
  /** The version string (e.g., 'v2', 'latest') */
  version: string
  /** Workspace ID for X-Workspace-Id header (undefined for personal orgs) */
  workspaceId: string | undefined
}

export type ResolveAgentOptions = {
  /** Skip workspace ID resolution (e.g., when caller manages workspace separately) */
  skipWorkspaceResolution?: boolean
  /** Custom error message when org cannot be resolved */
  missingOrgMessage?: string
}

/**
 * Resolve the org from a parsed AgentRef using the standard fallback chain:
 *   1. Explicit org from ref (org/agent@version)
 *   2. Workspace from config file
 *   3. defaultOrg from resolved config
 *
 * Throws CliError if no org can be determined.
 */
export async function resolveOrg(
  parsed: AgentRef,
  config: ResolvedConfig,
  options?: { missingOrgMessage?: string }
): Promise<string> {
  if (parsed.org) return parsed.org

  const configFile = await loadConfig()
  const org = configFile.workspace ?? config.defaultOrg
  if (!org) {
    throw new CliError(
      options?.missingOrgMessage ??
        'Missing org. Use org/agent format or set default org.'
    )
  }
  return org
}

/**
 * Central agent-reference resolution pipeline used by all commands.
 *
 * Takes a raw agent reference string (e.g., "org/agent@v2", "agent", "agent@latest")
 * and resolves it to a full context with org, agent name, version, and workspace ID.
 *
 * Resolution steps:
 *   1. Parse the ref string into { org?, agent, version }
 *   2. Resolve org via fallback chain: ref → config workspace → defaultOrg
 *   3. Resolve workspace ID for team workspace context (optional)
 *
 * @example
 *   const ctx = await resolveAgentContext('acme/my-agent@v2', config)
 *   // ctx = { org: 'acme', agent: 'my-agent', version: 'v2', workspaceId: 'ws-123' }
 *
 * @example
 *   const ctx = await resolveAgentContext('my-agent', config)
 *   // ctx = { org: 'default-org', agent: 'my-agent', version: 'latest', workspaceId: undefined }
 */
export async function resolveAgentContext(
  agentRefString: string,
  config: ResolvedConfig,
  options?: ResolveAgentOptions
): Promise<ResolvedAgentContext> {
  const parsed = parseAgentRef(agentRefString)

  const org = await resolveOrg(parsed, config, {
    missingOrgMessage: options?.missingOrgMessage,
  })

  let workspaceId: string | undefined
  if (!options?.skipWorkspaceResolution) {
    workspaceId = await resolveWorkspaceIdForOrg(config, org)
  }

  return {
    org,
    agent: parsed.agent,
    version: parsed.version,
    workspaceId,
  }
}
