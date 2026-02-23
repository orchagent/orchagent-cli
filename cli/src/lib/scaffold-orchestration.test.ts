import { describe, expect, it } from 'vitest'

import {
  buildOrchestrationCustomTools,
  buildOrchestrationManifest,
  buildOrchestrationPrompt,
  buildOrchestrationSchema,
  dedupeOrchestrationDependencies,
  dependencyRef,
  validateScaffoldAgentName,
} from './scaffold-orchestration'

describe('validateScaffoldAgentName', () => {
  it('accepts valid names', () => {
    expect(validateScaffoldAgentName('security-orchestrator')).toEqual([])
  })

  it('rejects invalid names', () => {
    const errors = validateScaffoldAgentName('Bad_Name')
    expect(errors.join(' ')).toContain('lowercase')
    expect(errors.join(' ')).toContain('only lowercase letters')
  })
})

describe('dedupeOrchestrationDependencies', () => {
  it('dedupes identical references and preserves order', () => {
    const { dependencies, duplicates, conflicts } = dedupeOrchestrationDependencies([
      { org: 'acme', name: 'scanner', version: 'v2' },
      { org: 'acme', name: 'scanner', version: 'v2' },
      { org: 'acme', name: 'auditor', version: 'v1' },
    ])

    expect(conflicts).toEqual([])
    expect(duplicates).toEqual(['acme/scanner@v2'])
    expect(dependencies.map((d) => dependencyRef(d))).toEqual([
      'acme/scanner@v2',
      'acme/auditor@v1',
    ])
  })

  it('reports version conflicts for the same dependency id', () => {
    const result = dedupeOrchestrationDependencies([
      { org: 'acme', name: 'scanner', version: 'v1' },
      { org: 'acme', name: 'scanner', version: 'v2' },
    ])

    expect(result.conflicts).toEqual([
      { id: 'acme/scanner', versions: ['v1', 'v2'] },
    ])
  })
})

describe('buildOrchestrationCustomTools', () => {
  it('creates unique tool names when dependency names collide across orgs', () => {
    const tools = buildOrchestrationCustomTools([
      { org: 'acme', name: 'scanner', version: 'v1' },
      { org: 'other', name: 'scanner', version: 'v3' },
    ])

    expect(tools[0].name).toBe('call_scanner')
    expect(tools[1].name).toBe('call_other_scanner')
    expect(tools[0].command).toContain('acme/scanner@v1')
    expect(tools[1].command).toContain('other/scanner@v3')
  })

  it('uses dependency input schema when available', () => {
    const tools = buildOrchestrationCustomTools([
      {
        org: 'acme',
        name: 'scanner',
        version: 'v1',
        inputSchema: {
          type: 'object',
          properties: {
            target: { type: 'string' },
          },
          required: ['target'],
        },
      },
    ])

    expect(tools[0].input_schema).toEqual({
      type: 'object',
      properties: {
        target: { type: 'string' },
      },
      required: ['target'],
    })
  })
})

describe('buildOrchestrationManifest', () => {
  it('builds a managed-loop orchestration manifest with synced loop + top-level fields', () => {
    const deps = [
      { org: 'acme', name: 'scanner', version: 'v2' },
      { org: 'acme', name: 'auditor', version: 'v1' },
    ]
    const tools = buildOrchestrationCustomTools(deps)
    const manifest = buildOrchestrationManifest({
      name: 'security-orchestrator',
      dependencies: deps,
      customTools: tools,
    }) as any

    expect(manifest.type).toBe('agent')
    expect(manifest.max_turns).toBe(25)
    expect(manifest.custom_tools).toHaveLength(2)
    expect(manifest.loop.max_turns).toBe(25)
    expect(manifest.loop.custom_tools).toHaveLength(2)
    expect(manifest.manifest.dependencies).toEqual([
      { id: 'acme/scanner', version: 'v2' },
      { id: 'acme/auditor', version: 'v1' },
    ])
  })
})

describe('buildOrchestrationPrompt and schema', () => {
  it('renders dependency tools and task template marker in prompt', () => {
    const deps = [
      { org: 'acme', name: 'scanner', version: 'v2', description: 'Find leaked secrets' },
    ]
    const tools = buildOrchestrationCustomTools(deps)
    const prompt = buildOrchestrationPrompt({
      name: 'security-orchestrator',
      dependencies: deps,
      customTools: tools,
    })

    expect(prompt).toContain('security-orchestrator')
    expect(prompt).toContain('acme/scanner@v2')
    expect(prompt).toContain('call_scanner')
    expect(prompt).toContain('{{task}}')
  })

  it('builds schema with required task input and structured output', () => {
    const schema = buildOrchestrationSchema() as any
    expect(schema.input.required).toEqual(['task'])
    expect(schema.output.required).toEqual(['result', 'used_tools'])
    expect(schema.output.properties.notes.type).toBe('array')
  })
})
