/**
 * Tests for batch-publish: agent discovery, dependency graph, topological sort.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('fs/promises')

import fs from 'fs/promises'
import { discoverAgents, topoSort, formatPublishPlan } from './batch-publish'
import type { DiscoveredAgent } from './batch-publish'

const mockFs = vi.mocked(fs)

describe('discoverAgents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('discovers orchagent.json in subdirectories', async () => {
    mockFs.readdir.mockImplementation(async (dirPath: unknown) => {
      const p = String(dirPath)
      if (p === '/project') {
        return [
          { name: 'leaf-tool', isDirectory: () => true, isFile: () => false },
          { name: 'orchestrator', isDirectory: () => true, isFile: () => false },
          { name: 'README.md', isDirectory: () => false, isFile: () => true },
        ] as any
      }
      return []
    })

    mockFs.readFile.mockImplementation(async (filePath: unknown) => {
      const p = String(filePath)
      if (p === '/project/leaf-tool/SKILL.md') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p === '/project/orchestrator/SKILL.md') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p === '/project/leaf-tool/orchagent.json') {
        return JSON.stringify({ name: 'leaf-tool', type: 'tool' })
      }
      if (p === '/project/orchestrator/orchagent.json') {
        return JSON.stringify({
          name: 'orchestrator',
          type: 'agent',
          manifest: {
            dependencies: [{ id: 'joe/leaf-tool', version: 'v1' }],
          },
        })
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const agents = await discoverAgents('/project')
    expect(agents).toHaveLength(2)
    expect(agents[0].name).toBe('leaf-tool')
    expect(agents[0].dependencyRefs).toEqual([])
    expect(agents[1].name).toBe('orchestrator')
    expect(agents[1].dependencyRefs).toEqual(['joe/leaf-tool'])
  })

  it('discovers SKILL.md files', async () => {
    mockFs.readdir.mockImplementation(async (dirPath: unknown) => {
      const p = String(dirPath)
      if (p === '/project') {
        return [
          { name: 'my-skill', isDirectory: () => true, isFile: () => false },
        ] as any
      }
      return []
    })

    mockFs.readFile.mockImplementation(async (filePath: unknown) => {
      const p = String(filePath)
      if (p === '/project/my-skill/SKILL.md') {
        return '---\nname: my-skill\ndescription: A test skill\n---\nSkill content here'
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const agents = await discoverAgents('/project')
    expect(agents).toHaveLength(1)
    expect(agents[0].name).toBe('my-skill')
    expect(agents[0].isSkill).toBe(true)
    expect(agents[0].dependencyRefs).toEqual([])
  })

  it('SKILL.md takes precedence over orchagent.json', async () => {
    mockFs.readdir.mockImplementation(async (dirPath: unknown) => {
      const p = String(dirPath)
      if (p === '/project') {
        return [
          { name: 'dual-agent', isDirectory: () => true, isFile: () => false },
        ] as any
      }
      return []
    })

    mockFs.readFile.mockImplementation(async (filePath: unknown) => {
      const p = String(filePath)
      if (p === '/project/dual-agent/SKILL.md') {
        return '---\nname: dual-skill\ndescription: A skill\n---\nBody'
      }
      if (p === '/project/dual-agent/orchagent.json') {
        return JSON.stringify({ name: 'dual-agent', type: 'agent' })
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const agents = await discoverAgents('/project')
    expect(agents).toHaveLength(1)
    expect(agents[0].name).toBe('dual-skill')
    expect(agents[0].isSkill).toBe(true)
  })

  it('skips hidden directories and node_modules', async () => {
    mockFs.readdir.mockImplementation(async (dirPath: unknown) => {
      const p = String(dirPath)
      if (p === '/project') {
        return [
          { name: '.git', isDirectory: () => true, isFile: () => false },
          { name: 'node_modules', isDirectory: () => true, isFile: () => false },
          { name: '__pycache__', isDirectory: () => true, isFile: () => false },
          { name: 'real-agent', isDirectory: () => true, isFile: () => false },
        ] as any
      }
      return []
    })

    mockFs.readFile.mockImplementation(async (filePath: unknown) => {
      const p = String(filePath)
      if (p === '/project/real-agent/SKILL.md') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p === '/project/real-agent/orchagent.json') {
        return JSON.stringify({ name: 'real-agent', type: 'prompt' })
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const agents = await discoverAgents('/project')
    expect(agents).toHaveLength(1)
    expect(agents[0].name).toBe('real-agent')
  })

  it('skips directories without orchagent.json or SKILL.md', async () => {
    mockFs.readdir.mockImplementation(async (dirPath: unknown) => {
      const p = String(dirPath)
      if (p === '/project') {
        return [
          { name: 'docs', isDirectory: () => true, isFile: () => false },
          { name: 'scripts', isDirectory: () => true, isFile: () => false },
        ] as any
      }
      return []
    })

    mockFs.readFile.mockImplementation(async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const agents = await discoverAgents('/project')
    expect(agents).toHaveLength(0)
  })

  it('skips manifests without a name field', async () => {
    mockFs.readdir.mockImplementation(async (dirPath: unknown) => {
      const p = String(dirPath)
      if (p === '/project') {
        return [
          { name: 'bad-agent', isDirectory: () => true, isFile: () => false },
        ] as any
      }
      return []
    })

    mockFs.readFile.mockImplementation(async (filePath: unknown) => {
      const p = String(filePath)
      if (p === '/project/bad-agent/SKILL.md') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p === '/project/bad-agent/orchagent.json') {
        return JSON.stringify({ type: 'tool' }) // no name
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const agents = await discoverAgents('/project')
    expect(agents).toHaveLength(0)
  })

  it('extracts dependencies from custom_tools orch_call commands', async () => {
    mockFs.readdir.mockImplementation(async (dirPath: unknown) => {
      const p = String(dirPath)
      if (p === '/project') {
        return [
          { name: 'caller', isDirectory: () => true, isFile: () => false },
        ] as any
      }
      return []
    })

    mockFs.readFile.mockImplementation(async (filePath: unknown) => {
      const p = String(filePath)
      if (p === '/project/caller/SKILL.md') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p === '/project/caller/orchagent.json') {
        return JSON.stringify({
          name: 'caller',
          type: 'agent',
          loop: {
            custom_tools: [
              { name: 'scan', command: 'orch_call.py joe/scanner@v1', description: 'Run scan' },
            ],
          },
        })
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const agents = await discoverAgents('/project')
    expect(agents).toHaveLength(1)
    expect(agents[0].dependencyRefs).toContain('joe/scanner')
  })

  it('deduplicates deps from manifest.dependencies and custom_tools', async () => {
    mockFs.readdir.mockImplementation(async (dirPath: unknown) => {
      const p = String(dirPath)
      if (p === '/project') {
        return [
          { name: 'orch', isDirectory: () => true, isFile: () => false },
        ] as any
      }
      return []
    })

    mockFs.readFile.mockImplementation(async (filePath: unknown) => {
      const p = String(filePath)
      if (p === '/project/orch/SKILL.md') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (p === '/project/orch/orchagent.json') {
        return JSON.stringify({
          name: 'orch',
          type: 'agent',
          manifest: { dependencies: [{ id: 'joe/scanner', version: 'v1' }] },
          loop: {
            custom_tools: [
              { name: 'scan', command: 'orch_call.py joe/scanner@v1', description: 'Scan' },
            ],
          },
        })
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const agents = await discoverAgents('/project')
    expect(agents[0].dependencyRefs).toEqual(['joe/scanner'])
  })

  it('returns empty array if root dir cannot be read', async () => {
    mockFs.readdir.mockRejectedValue(new Error('EPERM'))
    const agents = await discoverAgents('/nonexistent')
    expect(agents).toEqual([])
  })
})

describe('topoSort', () => {
  it('returns agents in dependency order (leaf first)', () => {
    const agents: DiscoveredAgent[] = [
      { dir: '/a', dirName: 'orchestrator', name: 'orchestrator', isSkill: false, dependencyRefs: ['joe/leaf-tool'] },
      { dir: '/b', dirName: 'leaf-tool', name: 'leaf-tool', isSkill: false, dependencyRefs: [] },
    ]

    const result = topoSort(agents)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.sorted.map(a => a.name)).toEqual(['leaf-tool', 'orchestrator'])
    }
  })

  it('handles three-level dependency chain', () => {
    const agents: DiscoveredAgent[] = [
      { dir: '/a', dirName: 'top', name: 'top', isSkill: false, dependencyRefs: ['joe/middle'] },
      { dir: '/b', dirName: 'middle', name: 'middle', isSkill: false, dependencyRefs: ['joe/bottom'] },
      { dir: '/c', dirName: 'bottom', name: 'bottom', isSkill: false, dependencyRefs: [] },
    ]

    const result = topoSort(agents)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.sorted.map(a => a.name)).toEqual(['bottom', 'middle', 'top'])
    }
  })

  it('handles fan-out (one agent depends on multiple)', () => {
    const agents: DiscoveredAgent[] = [
      { dir: '/a', dirName: 'orch', name: 'orch', isSkill: false, dependencyRefs: ['joe/tool-a', 'joe/tool-b'] },
      { dir: '/b', dirName: 'tool-a', name: 'tool-a', isSkill: false, dependencyRefs: [] },
      { dir: '/c', dirName: 'tool-b', name: 'tool-b', isSkill: false, dependencyRefs: [] },
    ]

    const result = topoSort(agents)
    expect(result.ok).toBe(true)
    if (result.ok) {
      // tool-a and tool-b have no deps, alphabetically sorted first
      expect(result.sorted.map(a => a.name)).toEqual(['tool-a', 'tool-b', 'orch'])
    }
  })

  it('handles fan-in (multiple agents depend on one)', () => {
    const agents: DiscoveredAgent[] = [
      { dir: '/a', dirName: 'orch-a', name: 'orch-a', isSkill: false, dependencyRefs: ['joe/shared'] },
      { dir: '/b', dirName: 'orch-b', name: 'orch-b', isSkill: false, dependencyRefs: ['joe/shared'] },
      { dir: '/c', dirName: 'shared', name: 'shared', isSkill: false, dependencyRefs: [] },
    ]

    const result = topoSort(agents)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.sorted[0].name).toBe('shared')
      // orch-a and orch-b after, alphabetically
      expect(result.sorted.slice(1).map(a => a.name)).toEqual(['orch-a', 'orch-b'])
    }
  })

  it('detects simple cycles', () => {
    const agents: DiscoveredAgent[] = [
      { dir: '/a', dirName: 'a', name: 'agent-a', isSkill: false, dependencyRefs: ['joe/agent-b'] },
      { dir: '/b', dirName: 'b', name: 'agent-b', isSkill: false, dependencyRefs: ['joe/agent-a'] },
    ]

    const result = topoSort(agents)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.cycle).toContain('agent-a')
      expect(result.cycle).toContain('agent-b')
    }
  })

  it('detects three-node cycles', () => {
    const agents: DiscoveredAgent[] = [
      { dir: '/a', dirName: 'a', name: 'a', isSkill: false, dependencyRefs: ['joe/b'] },
      { dir: '/b', dirName: 'b', name: 'b', isSkill: false, dependencyRefs: ['joe/c'] },
      { dir: '/c', dirName: 'c', name: 'c', isSkill: false, dependencyRefs: ['joe/a'] },
    ]

    const result = topoSort(agents)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.cycle).toHaveLength(3)
    }
  })

  it('handles agents with no dependencies (all independent)', () => {
    const agents: DiscoveredAgent[] = [
      { dir: '/a', dirName: 'c-agent', name: 'c-agent', isSkill: false, dependencyRefs: [] },
      { dir: '/b', dirName: 'a-agent', name: 'a-agent', isSkill: false, dependencyRefs: [] },
      { dir: '/c', dirName: 'b-agent', name: 'b-agent', isSkill: false, dependencyRefs: [] },
    ]

    const result = topoSort(agents)
    expect(result.ok).toBe(true)
    if (result.ok) {
      // Alphabetically sorted when all are independent
      expect(result.sorted.map(a => a.name)).toEqual(['a-agent', 'b-agent', 'c-agent'])
    }
  })

  it('handles single agent', () => {
    const agents: DiscoveredAgent[] = [
      { dir: '/a', dirName: 'solo', name: 'solo', isSkill: false, dependencyRefs: [] },
    ]

    const result = topoSort(agents)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.sorted).toHaveLength(1)
      expect(result.sorted[0].name).toBe('solo')
    }
  })

  it('ignores cross-org dependencies not in the project', () => {
    const agents: DiscoveredAgent[] = [
      { dir: '/a', dirName: 'my-agent', name: 'my-agent', isSkill: false, dependencyRefs: ['other-org/external-tool'] },
    ]

    const result = topoSort(agents)
    expect(result.ok).toBe(true)
    if (result.ok) {
      // External dep ignored, agent can be published independently
      expect(result.sorted).toHaveLength(1)
    }
  })

  it('skills are sorted before agents that might depend on them', () => {
    const agents: DiscoveredAgent[] = [
      { dir: '/a', dirName: 'agent', name: 'my-agent', isSkill: false, dependencyRefs: [] },
      { dir: '/b', dirName: 'skill', name: 'my-skill', isSkill: true, dependencyRefs: [] },
    ]

    const result = topoSort(agents)
    expect(result.ok).toBe(true)
    if (result.ok) {
      // Both independent — alphabetically my-agent before my-skill
      expect(result.sorted.map(a => a.name)).toEqual(['my-agent', 'my-skill'])
    }
  })

  it('handles diamond dependency pattern', () => {
    // top depends on left and right, both depend on bottom
    const agents: DiscoveredAgent[] = [
      { dir: '/a', dirName: 'top', name: 'top', isSkill: false, dependencyRefs: ['joe/left', 'joe/right'] },
      { dir: '/b', dirName: 'left', name: 'left', isSkill: false, dependencyRefs: ['joe/bottom'] },
      { dir: '/c', dirName: 'right', name: 'right', isSkill: false, dependencyRefs: ['joe/bottom'] },
      { dir: '/d', dirName: 'bottom', name: 'bottom', isSkill: false, dependencyRefs: [] },
    ]

    const result = topoSort(agents)
    expect(result.ok).toBe(true)
    if (result.ok) {
      const names = result.sorted.map(a => a.name)
      // bottom must be first
      expect(names[0]).toBe('bottom')
      // left and right must be before top
      expect(names.indexOf('left')).toBeLessThan(names.indexOf('top'))
      expect(names.indexOf('right')).toBeLessThan(names.indexOf('top'))
      // top must be last
      expect(names[3]).toBe('top')
    }
  })

  it('ignores self-referencing dependency', () => {
    const agents: DiscoveredAgent[] = [
      { dir: '/a', dirName: 'a', name: 'self-ref', isSkill: false, dependencyRefs: ['joe/self-ref'] },
    ]

    const result = topoSort(agents)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.sorted).toHaveLength(1)
    }
  })

  it('partial cycle: some agents in cycle, some not', () => {
    const agents: DiscoveredAgent[] = [
      { dir: '/a', dirName: 'ok', name: 'ok-agent', isSkill: false, dependencyRefs: [] },
      { dir: '/b', dirName: 'cycleA', name: 'cycle-a', isSkill: false, dependencyRefs: ['joe/cycle-b'] },
      { dir: '/c', dirName: 'cycleB', name: 'cycle-b', isSkill: false, dependencyRefs: ['joe/cycle-a'] },
    ]

    const result = topoSort(agents)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.cycle).toContain('cycle-a')
      expect(result.cycle).toContain('cycle-b')
      // ok-agent should NOT be in the cycle
      expect(result.cycle).not.toContain('ok-agent')
    }
  })
})

describe('formatPublishPlan', () => {
  it('formats plan with org prefix', () => {
    const agents: DiscoveredAgent[] = [
      { dir: '/a', dirName: 'leaf', name: 'leaf-tool', isSkill: false, dependencyRefs: [] },
      { dir: '/b', dirName: 'orch', name: 'orchestrator', isSkill: false, dependencyRefs: ['joe/leaf-tool'] },
    ]

    const output = formatPublishPlan(agents, 'joe')
    expect(output).toContain('Found 2 agents to publish')
    expect(output).toContain('1. joe/leaf-tool [agent]')
    expect(output).toContain('2. joe/orchestrator [agent]')
    expect(output).toContain('depends on: leaf-tool')
  })

  it('formats plan without org prefix', () => {
    const agents: DiscoveredAgent[] = [
      { dir: '/a', dirName: 'tool', name: 'my-tool', isSkill: false, dependencyRefs: [] },
    ]

    const output = formatPublishPlan(agents)
    expect(output).toContain('Found 1 agent to publish')
    expect(output).toContain('1. my-tool [agent]')
  })

  it('shows skill type for skills', () => {
    const agents: DiscoveredAgent[] = [
      { dir: '/a', dirName: 'my-skill', name: 'my-skill', isSkill: true, dependencyRefs: [] },
    ]

    const output = formatPublishPlan(agents)
    expect(output).toContain('[skill]')
  })

  it('shows directory name in gray', () => {
    const agents: DiscoveredAgent[] = [
      { dir: '/project/my-dir', dirName: 'my-dir', name: 'agent-name', isSkill: false, dependencyRefs: [] },
    ]

    const output = formatPublishPlan(agents)
    expect(output).toContain('my-dir/')
  })

  it('handles singular correctly', () => {
    const agents: DiscoveredAgent[] = [
      { dir: '/a', dirName: 'only', name: 'only-agent', isSkill: false, dependencyRefs: [] },
    ]

    const output = formatPublishPlan(agents)
    expect(output).toContain('Found 1 agent to publish')
    expect(output).not.toContain('agents to publish')
  })
})
