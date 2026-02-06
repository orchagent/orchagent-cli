import { publicRequest, ApiError, getOrg, listMyAgents } from './api'
import type { Agent, ResolvedConfig } from '../types'
import type { ResolvedSkill } from '../adapters/types'

type SkillRef = {
  org: string
  name: string
  version: string
}

type SkillDownload = {
  name: string
  version: string
  description?: string
  prompt?: string
}

function parseSkillRef(ref: string): SkillRef {
  const [namePart, versionPart] = ref.split('@')
  const version = versionPart?.trim() || 'latest'
  const segments = namePart.split('/')
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    throw new Error(`Invalid skill reference: ${ref}. Expected format: org/name[@version]`)
  }
  return { org: segments[0], name: segments[1], version }
}

/**
 * Download a single skill's content.
 * Tries public endpoint first, falls back to authenticated for private skills.
 * Returns null if the skill can't be found.
 */
async function downloadSkill(
  config: ResolvedConfig,
  org: string,
  name: string,
  version: string
): Promise<SkillDownload | null> {
  // Try public download endpoint first
  try {
    return await publicRequest<SkillDownload>(
      config,
      `/public/agents/${org}/${name}/${version}/download`
    )
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 404) {
      // Non-404 errors (network, 500, etc.) - rethrow
      throw err
    }
  }

  // Public not found - try authenticated endpoint for private skills
  if (!config.apiKey) {
    return null
  }

  try {
    const userOrg = await getOrg(config)
    if (userOrg.slug !== org) {
      return null
    }

    const agents = await listMyAgents(config)
    const matching = agents.filter(a => a.name === name && a.type === 'skill')
    if (matching.length === 0) {
      return null
    }

    let target: Agent
    if (version === 'latest') {
      target = matching.sort((a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      )[0]
    } else {
      const found = matching.find(a => a.version === version)
      if (!found) return null
      target = found
    }

    return {
      name: target.name,
      version: target.version,
      description: target.description,
      prompt: target.prompt,
    }
  } catch {
    return null
  }
}

/**
 * Resolve an array of skill references to their full content.
 * Fetches each skill from the API and returns resolved skills with prompts.
 * Skills that can't be fetched are skipped with a warning.
 */
export async function resolveSkills(
  config: ResolvedConfig,
  skillRefs: string[],
  onWarning?: (msg: string) => void
): Promise<ResolvedSkill[]> {
  const resolved: ResolvedSkill[] = []

  for (const ref of skillRefs) {
    let parsed: SkillRef
    try {
      parsed = parseSkillRef(ref)
    } catch {
      onWarning?.(`Skipping invalid skill reference: ${ref}`)
      continue
    }

    try {
      const skill = await downloadSkill(config, parsed.org, parsed.name, parsed.version)
      if (!skill || !skill.prompt) {
        onWarning?.(`Could not resolve skill '${ref}' (not found or empty)`)
        continue
      }

      resolved.push({
        ref,
        name: skill.name,
        description: skill.description,
        prompt: skill.prompt,
      })
    } catch (err) {
      onWarning?.(`Could not fetch skill '${ref}': ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return resolved
}
