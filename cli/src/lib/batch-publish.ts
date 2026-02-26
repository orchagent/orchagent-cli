import fs from 'fs/promises'
import path from 'path'
import chalk from 'chalk'

import type { AgentManifest } from '../types'

/**
 * Represents a discovered agent directory with its parsed manifest.
 */
export type DiscoveredAgent = {
  /** Directory path containing orchagent.json or SKILL.md */
  dir: string
  /** Directory name (for display) */
  dirName: string
  /** Agent name from manifest (or SKILL.md frontmatter) */
  name: string
  /** Whether this is a skill (SKILL.md) or agent (orchagent.json) */
  isSkill: boolean
  /** Parsed manifest dependencies (org/name refs) — empty for skills */
  dependencyRefs: string[]
}

/**
 * Scan immediate subdirectories for orchagent.json or SKILL.md files.
 * Does NOT recurse deeper than one level (matching GitHub App import behavior).
 */
export async function discoverAgents(rootDir: string): Promise<DiscoveredAgent[]> {
  const agents: DiscoveredAgent[] = []

  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true })
  } catch {
    return []
  }

  // Also check the root directory itself
  const dirsToCheck: Array<{ dir: string; dirName: string }> = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue
    dirsToCheck.push({
      dir: path.join(rootDir, entry.name),
      dirName: entry.name,
    })
  }

  for (const { dir, dirName } of dirsToCheck) {
    const agent = await tryParseAgentDir(dir, dirName)
    if (agent) agents.push(agent)
  }

  return agents
}

/**
 * Try to parse a directory as an agent. Returns null if no orchagent.json or SKILL.md found.
 */
async function tryParseAgentDir(dir: string, dirName: string): Promise<DiscoveredAgent | null> {
  // Check for SKILL.md first (takes precedence, matching publish.ts behavior)
  const skillMdPath = path.join(dir, 'SKILL.md')
  try {
    const content = await fs.readFile(skillMdPath, 'utf-8')
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (match) {
      // Parse YAML frontmatter to get name
      const yamlContent = match[1]
      const nameMatch = yamlContent.match(/^name:\s*(.+)$/m)
      const name = nameMatch ? nameMatch[1].trim().replace(/^['"]|['"]$/g, '') : dirName
      return {
        dir,
        dirName,
        name,
        isSkill: true,
        dependencyRefs: [], // Skills have no dependencies
      }
    }
  } catch {
    // No SKILL.md, try orchagent.json
  }

  // Check for orchagent.json
  const manifestPath = path.join(dir, 'orchagent.json')
  try {
    const raw = await fs.readFile(manifestPath, 'utf-8')
    const manifest: AgentManifest = JSON.parse(raw)
    if (!manifest.name) return null

    // Extract dependency refs from manifest.manifest.dependencies
    const dependencyRefs: string[] = []
    const deps = manifest.manifest?.dependencies
    if (deps && Array.isArray(deps)) {
      for (const dep of deps) {
        if (dep.id && typeof dep.id === 'string') {
          dependencyRefs.push(dep.id)
        }
      }
    }

    // Also extract from custom_tools that reference other agents via orch_call
    // Pattern: orch_call.py org/agent@version or orch_call.js org/agent@version
    const loopTools = manifest.loop?.custom_tools || manifest.custom_tools
    if (Array.isArray(loopTools)) {
      for (const tool of loopTools as Array<{ command?: string }>) {
        if (tool.command) {
          const orchCallMatch = tool.command.match(/orch_call(?:\.py|\.js)?\s+([a-z0-9-]+\/[a-z0-9-]+)/)
          if (orchCallMatch) {
            const ref = orchCallMatch[1]
            if (!dependencyRefs.includes(ref)) {
              dependencyRefs.push(ref)
            }
          }
        }
      }
    }

    return {
      dir,
      dirName,
      name: manifest.name,
      isSkill: false,
      dependencyRefs,
    }
  } catch {
    return null
  }
}

/**
 * Result of topological sorting.
 */
export type TopoSortResult =
  | { ok: true; sorted: DiscoveredAgent[] }
  | { ok: false; cycle: string[] }

/**
 * Topologically sort agents so dependencies are published first (leaf-first).
 *
 * Only considers intra-project dependencies (agents whose dependency refs
 * match another discovered agent's name). Cross-org or external deps are
 * ignored since they must already be published.
 */
export function topoSort(agents: DiscoveredAgent[]): TopoSortResult {
  // Build name → agent lookup (using agent name, not dir name)
  const byName = new Map<string, DiscoveredAgent>()
  for (const agent of agents) {
    byName.set(agent.name, agent)
  }

  // Build adjacency: agent → set of local agents it depends on
  // "depends on" means: must be published BEFORE this agent
  const adjList = new Map<string, Set<string>>()
  for (const agent of agents) {
    const localDeps = new Set<string>()
    for (const ref of agent.dependencyRefs) {
      // ref is "org/name" — extract just the name part for local matching
      const depName = ref.includes('/') ? ref.split('/')[1] : ref
      if (byName.has(depName) && depName !== agent.name) {
        localDeps.add(depName)
      }
    }
    adjList.set(agent.name, localDeps)
  }

  // Kahn's algorithm for topological sort
  const inDegree = new Map<string, number>()
  for (const agent of agents) {
    inDegree.set(agent.name, 0)
  }
  for (const [, deps] of adjList) {
    for (const dep of deps) {
      inDegree.set(dep, (inDegree.get(dep) || 0) + 1)
    }
  }

  // Note: inDegree counts how many agents depend ON this agent.
  // We want to publish agents with no dependents-that-haven't-been-published first.
  // Actually, let me re-think: we want leaf-first ordering.
  // A "leaf" is an agent with NO dependencies (inDegree in the "depends-on" graph = 0 outgoing).
  // Let's use Kahn's on the reverse: process nodes whose dependencies are all satisfied.

  // Reset: inDegree = number of local deps this agent has (not yet satisfied)
  const remaining = new Map<string, number>()
  for (const agent of agents) {
    remaining.set(agent.name, adjList.get(agent.name)?.size || 0)
  }

  const queue: string[] = []
  for (const [name, count] of remaining) {
    if (count === 0) queue.push(name)
  }

  // Sort queue alphabetically for deterministic ordering among peers
  queue.sort()

  const sorted: DiscoveredAgent[] = []
  const visited = new Set<string>()

  while (queue.length > 0) {
    const name = queue.shift()!
    if (visited.has(name)) continue
    visited.add(name)

    const agent = byName.get(name)!
    sorted.push(agent)

    // For each agent that depends on this one, decrement their remaining count
    for (const [otherName, deps] of adjList) {
      if (deps.has(name) && !visited.has(otherName)) {
        const newCount = (remaining.get(otherName) || 1) - 1
        remaining.set(otherName, newCount)
        if (newCount === 0) {
          // Insert in sorted position for determinism
          const insertIdx = queue.findIndex(q => q > otherName)
          if (insertIdx === -1) queue.push(otherName)
          else queue.splice(insertIdx, 0, otherName)
        }
      }
    }
  }

  // If not all agents were visited, there's a cycle
  if (sorted.length < agents.length) {
    const inCycle = agents
      .filter(a => !visited.has(a.name))
      .map(a => a.name)
    return { ok: false, cycle: inCycle }
  }

  return { ok: true, sorted }
}

/**
 * Format the publish plan for display (used by both dry-run and normal mode).
 */
export function formatPublishPlan(sorted: DiscoveredAgent[], orgSlug?: string): string {
  const lines: string[] = []
  lines.push('')
  lines.push(`  Found ${sorted.length} agent${sorted.length === 1 ? '' : 's'} to publish:`)
  lines.push('')

  for (let i = 0; i < sorted.length; i++) {
    const agent = sorted[i]
    const type = agent.isSkill ? 'skill' : 'agent'
    const deps = agent.dependencyRefs.length > 0
      ? ` (depends on: ${agent.dependencyRefs.map(r => r.split('/').pop()).join(', ')})`
      : ''
    const prefix = orgSlug ? `${orgSlug}/` : ''
    lines.push(`  ${i + 1}. ${prefix}${agent.name} [${type}]${deps}`)
    lines.push(`     ${chalk.gray(agent.dirName + '/')}`)
  }

  lines.push('')
  return lines.join('\n')
}

/**
 * Format an enhanced dry-run summary for --all --dry-run.
 * Shows publish ordering, local/external dependencies, and graph health.
 */
export function formatDryRunSummary(sorted: DiscoveredAgent[], orgSlug?: string): string {
  const lines: string[] = []
  const localNames = new Set(sorted.map(a => a.name))

  // Collect external deps (referenced but not in the project)
  const externalDeps = new Map<string, string[]>() // ref → [agent names that reference it]
  for (const agent of sorted) {
    for (const ref of agent.dependencyRefs) {
      const depName = ref.includes('/') ? ref.split('/')[1] : ref
      if (!localNames.has(depName)) {
        const consumers = externalDeps.get(ref) || []
        consumers.push(agent.name)
        externalDeps.set(ref, consumers)
      }
    }
  }

  // Publish order table
  lines.push('')
  lines.push(chalk.bold(`  Publish order (${sorted.length} agent${sorted.length === 1 ? '' : 's'}):`))
  lines.push('')

  for (let i = 0; i < sorted.length; i++) {
    const agent = sorted[i]
    const type = agent.isSkill ? 'skill' : 'agent'
    const prefix = orgSlug ? `${orgSlug}/` : ''

    // Separate local and external deps for clarity
    const localDeps: string[] = []
    const extDeps: string[] = []
    for (const ref of agent.dependencyRefs) {
      const depName = ref.includes('/') ? ref.split('/')[1] : ref
      if (localNames.has(depName)) {
        localDeps.push(depName)
      } else {
        extDeps.push(ref)
      }
    }

    let depInfo = ''
    if (localDeps.length > 0 || extDeps.length > 0) {
      const parts: string[] = []
      if (localDeps.length > 0) parts.push(localDeps.join(', '))
      if (extDeps.length > 0) parts.push(extDeps.map(d => `${d} ${chalk.yellow('(external)')}`).join(', '))
      depInfo = ` ${chalk.gray('→')} ${parts.join(', ')}`
    }

    lines.push(`  ${chalk.bold(`${i + 1}.`)} ${prefix}${agent.name} ${chalk.gray(`[${type}]`)}${depInfo}`)
    lines.push(`     ${chalk.gray(agent.dirName + '/')}`)
  }

  // External dependencies section
  if (externalDeps.size > 0) {
    lines.push('')
    lines.push(chalk.yellow(`  External dependencies (must already be published):`))
    for (const [ref, consumers] of externalDeps) {
      lines.push(`    ${ref} ${chalk.gray(`← ${consumers.join(', ')}`)}`)
    }
  }

  // Summary
  lines.push('')
  const skillCount = sorted.filter(a => a.isSkill).length
  const agentCount = sorted.length - skillCount
  const parts: string[] = []
  if (agentCount > 0) parts.push(`${agentCount} agent${agentCount === 1 ? '' : 's'}`)
  if (skillCount > 0) parts.push(`${skillCount} skill${skillCount === 1 ? '' : 's'}`)
  lines.push(chalk.green(`  ✓ ${parts.join(', ')} ready to publish (no circular dependencies)`))
  lines.push('')

  return lines.join('\n')
}
