/**
 * Utilities for handling AGENTS.md file updates
 */

import { escapeRegex } from './string-utils'

/**
 * Merge new content into an existing AGENTS.md file.
 *
 * - If the agent's section already exists (identified by markers), replace it
 * - If the file has content but no section for this agent, append
 * - If the file is empty/new, use the new content as-is
 *
 * @param existingContent - Current content of AGENTS.md (empty string if file doesn't exist)
 * @param newContent - New content to merge (should include orchagent markers)
 * @param agentRef - Agent reference like "org/agent-name" used in markers
 * @returns Merged content
 */
export function mergeAgentsMdContent(
  existingContent: string,
  newContent: string,
  agentRef: string
): string {
  const markerStart = `<!-- orchagent:${agentRef} -->`
  const markerEnd = `<!-- /orchagent:${agentRef} -->`

  if (existingContent.includes(markerStart)) {
    // Replace existing section
    const regex = new RegExp(
      `${escapeRegex(markerStart)}[\\s\\S]*?${escapeRegex(markerEnd)}`,
      'g'
    )
    return existingContent.replace(regex, newContent.trim())
  } else if (existingContent.trim()) {
    // Append to existing file
    return existingContent.trimEnd() + '\n\n' + newContent
  }
  // New file, use content as-is
  return newContent
}
