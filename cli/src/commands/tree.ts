import { Command } from 'commander'
import chalk from 'chalk'
import { getResolvedConfig } from '../lib/config'
import { request } from '../lib/api'
import { parseAgentRef } from '../lib/agent-ref'
import { CliError } from '../lib/errors'

interface TreeNode {
  agent: string
  accessible: boolean
  type: 'prompt' | 'tool' | 'skill' | 'agent' | null
  skills: string[]
  skills_locked: boolean
  dependencies: TreeNode[]
}

interface TreeSummary {
  total_agents: number
  total_skills: number
  max_depth: number
  has_locked_skills: boolean
}

interface TreeResponse {
  agent: string
  type: 'prompt' | 'tool' | 'skill' | 'agent' | null
  skills: string[]
  skills_locked: boolean
  dependencies: TreeNode[]
  summary: TreeSummary
}

export function registerTreeCommand(program: Command): void {
  program
    .command('tree <agent>')
    .description('Show dependency tree for an agent')
    .option('--json', 'Output as JSON')
    .option('--no-color', 'Disable colored output')
    .action(async (agentArg: string, options: { json?: boolean; color?: boolean }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Authentication required. Run: orch login')
      }

      const { org, agent, version } = parseAgentRef(agentArg)

      const tree = await request<TreeResponse>(
        config,
        'GET',
        `/agents/${org}/${agent}/${version}/tree`
      )

      if (options.json) {
        console.log(JSON.stringify(tree, null, 2))
        return
      }

      const useColor = options.color !== false

      console.log()
      console.log(formatTree(tree, useColor))
      console.log()
      console.log(
        `Summary: ${tree.summary.total_agents} agents, ` +
        `${tree.summary.total_skills} skills, ` +
        `max depth ${tree.summary.max_depth}`
      )
    })
}

function formatTree(tree: TreeResponse, useColor: boolean): string {
  const lines: string[] = []

  const rootNode: TreeNode = {
    agent: tree.agent,
    accessible: true,
    type: tree.type,
    skills: tree.skills,
    skills_locked: tree.skills_locked,
    dependencies: tree.dependencies,
  }

  formatNode(rootNode, '', true, true, lines, useColor)

  return lines.join('\n')
}

function formatNode(
  node: TreeNode,
  prefix: string,
  isLast: boolean,
  isRoot: boolean,
  lines: string[],
  useColor: boolean
): void {
  const connector = isRoot ? '' : isLast ? '└── ' : '├── '
  const childPrefix = isRoot ? '' : prefix + (isLast ? '    ' : '│   ')

  // Format agent line
  let agentStr = node.agent
  if (!node.accessible) {
    agentStr = useColor ? chalk.dim(agentStr) : `(${agentStr})`
  }
  if (node.skills_locked && useColor) {
    agentStr = agentStr + chalk.yellow(' 🔒')
  }

  lines.push(prefix + connector + agentStr)

  // Format skills
  const allChildren = [
    ...node.skills.map(s => ({ type: 'skill' as const, value: s })),
    ...node.dependencies.map(d => ({ type: 'dep' as const, value: d })),
  ]

  allChildren.forEach((child, idx) => {
    const isLastChild = idx === allChildren.length - 1
    const childConnector = isLastChild ? '└── ' : '├── '

    if (child.type === 'skill') {
      const skillStr = useColor
        ? chalk.magenta(child.value) + chalk.dim(' (skill)')
        : `${child.value} (skill)`
      lines.push(childPrefix + childConnector + skillStr)
    } else {
      formatNode(child.value, childPrefix, isLastChild, false, lines, useColor)
    }
  })
}
