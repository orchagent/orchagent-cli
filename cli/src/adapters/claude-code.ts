import type { FormatAdapter, CanonicalAgent, ConversionResult, ConvertedFile } from './types'
import { normalizeAgentName, mapModelToAlias } from './utils'
import yaml from 'yaml'

export const claudeCodeAdapter: FormatAdapter = {
  id: 'claude-code',
  name: 'Claude Code Sub-Agent',
  version: '1.0.0',
  formatVersion: '2026-01',

  supportedTypes: ['prompt', 'skill'],

  installPaths: [
    {
      scope: 'user',
      path: '~/.claude/agents/',
      description: 'User-level (available in all projects)',
    },
    {
      scope: 'project',
      path: '.claude/agents/',
      description: 'Project-level (current directory)',
    },
  ],

  canConvert(agent: CanonicalAgent): ConversionResult {
    const warnings: string[] = []
    const errors: string[] = []

    // Tool agents cannot be converted
    if (agent.type === 'tool') {
      errors.push(
        'Tool agents cannot be converted to Claude Code sub-agents (they require execution)'
      )
      return { canConvert: false, warnings, errors }
    }

    // Check for prompt
    if (!agent.prompt) {
      errors.push('Agent has no prompt content')
      return { canConvert: false, warnings, errors }
    }

    return { canConvert: true, warnings, errors }
  },

  convert(agent: CanonicalAgent): ConvertedFile[] {
    const normalizedName = normalizeAgentName(agent.name)

    // Build frontmatter
    const frontmatter: Record<string, unknown> = {
      name: normalizedName,
      description: agent.description || `Delegatable agent: ${agent.name}`,
    }

    // Only include tools for agent-type (prompt and skill types are single LLM calls)
    if (agent.type === 'agent') {
      frontmatter.tools = 'Read, Glob, Grep' // Safe defaults - read-only
    }

    // Map model if specified
    if (agent.default_models?.anthropic) {
      const modelAlias = mapModelToAlias(agent.default_models.anthropic)
      if (modelAlias !== 'inherit') {
        frontmatter.model = modelAlias
      }
    }

    // Build body
    let body = agent.prompt || ''

    // Add schema descriptions if present
    if (agent.input_schema) {
      body += `\n\n## Input Schema\n\nThis agent expects input matching:\n\`\`\`json\n${JSON.stringify(agent.input_schema, null, 2)}\n\`\`\``
    }
    if (agent.output_schema) {
      body += `\n\n## Output Schema\n\nThis agent should return output matching:\n\`\`\`json\n${JSON.stringify(agent.output_schema, null, 2)}\n\`\`\``
    }

    // Embed resolved skills
    if (agent.resolvedSkills && agent.resolvedSkills.length > 0) {
      body += '\n\n## Bundled Skills\n\nThe following skills are bundled with this agent and must be applied.'
      for (const skill of agent.resolvedSkills) {
        body += `\n\n### ${skill.name}`
        if (skill.description) {
          body += `\n\n${skill.description}`
        }
        body += `\n\n${skill.prompt}`
      }
    }

    // Combine frontmatter + body
    const content = `---\n${yaml.stringify(frontmatter).trim()}\n---\n\n${body.trim()}\n`

    return [
      {
        filename: `${normalizedName}.md`,
        content,
        installPath: '.claude/agents/',
      },
    ]
  },
}
