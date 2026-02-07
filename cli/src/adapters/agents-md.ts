import type { FormatAdapter, CanonicalAgent, ConversionResult, ConvertedFile } from './types'

export const agentsMdAdapter: FormatAdapter = {
  id: 'agents-md',
  name: 'AGENTS.md (Universal)',
  version: '1.0.0',
  formatVersion: '1.0',

  supportedTypes: ['prompt', 'skill'],

  installPaths: [
    {
      scope: 'project',
      path: './',
      description: 'Project root (AGENTS.md)',
    },
  ],

  canConvert(agent: CanonicalAgent): ConversionResult {
    const warnings: string[] = []
    const errors: string[] = []

    if (agent.type === 'tool') {
      errors.push('Tool agents cannot be converted to AGENTS.md')
      return { canConvert: false, warnings, errors }
    }

    if (!agent.prompt) {
      errors.push('Agent has no prompt content')
      return { canConvert: false, warnings, errors }
    }

    warnings.push('AGENTS.md content should be appended to existing file, not replaced')

    return { canConvert: true, warnings, errors }
  },

  convert(agent: CanonicalAgent): ConvertedFile[] {
    const orgSlug = agent.org_slug || 'unknown'
    const agentRef = `${orgSlug}/${agent.name}`
    const description = agent.description || ''

    // Build skills section if present
    let skillsSection = ''
    if (agent.resolvedSkills && agent.resolvedSkills.length > 0) {
      skillsSection = '\n### Bundled Skills\n\nThe following skills are bundled with this agent and must be applied.'
      for (const skill of agent.resolvedSkills) {
        skillsSection += `\n\n#### ${skill.name}`
        if (skill.description) {
          skillsSection += `\n\n${skill.description}`
        }
        skillsSection += `\n\n${skill.prompt}`
      }
      skillsSection += '\n'
    }

    // Use orchagent markers for managed section
    const content = `<!-- orchagent:${agentRef} -->
## ${agent.name}

${description}

${agent.prompt || ''}${skillsSection}
<!-- /orchagent:${agentRef} -->
`

    return [
      {
        filename: 'AGENTS.md',
        content,
        installPath: './',
      },
    ]
  },
}
