import type { FormatAdapter, CanonicalAgent, ConversionResult, ConvertedFile } from './types'
import { normalizeAgentName } from './utils'

export const cursorAdapter: FormatAdapter = {
  id: 'cursor',
  name: 'Cursor Rules',
  version: '1.0.0',
  formatVersion: '2026-01',

  supportedTypes: ['prompt', 'skill'],

  installPaths: [
    {
      scope: 'project',
      path: '.cursor/rules/',
      description: 'Project-level Cursor rules',
    },
  ],

  canConvert(agent: CanonicalAgent): ConversionResult {
    const warnings: string[] = []
    const errors: string[] = []

    if (agent.type === 'code') {
      errors.push('Code agents cannot be converted to Cursor rules')
      return { canConvert: false, warnings, errors }
    }

    if (!agent.prompt) {
      errors.push('Agent has no prompt content')
      return { canConvert: false, warnings, errors }
    }

    // Cursor doesn't support input/output schemas
    if (agent.input_schema) {
      warnings.push('input_schema is not supported in Cursor rules')
    }
    if (agent.output_schema) {
      warnings.push('output_schema is not supported in Cursor rules')
    }

    return { canConvert: true, warnings, errors }
  },

  convert(agent: CanonicalAgent): ConvertedFile[] {
    const normalizedName = normalizeAgentName(agent.name)
    const description = agent.description || `Rules from ${agent.name}`

    // Cursor .mdc format
    const content = `---
description: ${description}
globs:
alwaysApply: false
---

# ${agent.name}

${agent.prompt || ''}
`

    return [
      {
        filename: `${normalizedName}.mdc`,
        content,
        installPath: '.cursor/rules/',
      },
    ]
  },
}
