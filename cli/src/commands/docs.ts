import { Command } from 'commander'
import open from 'open'

const DOCS_BASE = 'https://docs.orchagent.io'

const DOCS_ROUTES: Record<string, string> = {
  '': '/',
  'cli': '/using-agents/cli-commands',
  'agents': '/building-agents/agent-types',
  'skills': '/building-agents/orchestration',
  'sdk': '/building-agents/sdk',
  'api': '/api-reference/overview',
  'quickstart': '/quickstart',
}

export function registerDocsCommand(program: Command): void {
  program
    .command('docs')
    .description('Open documentation in browser')
    .argument('[topic]', 'Topic: cli, agents, skills, sdk, api, quickstart')
    .action(async (topic?: string) => {
      if (topic && !(topic in DOCS_ROUTES)) {
        const validTopics = Object.keys(DOCS_ROUTES).filter(k => k).join(', ')
        process.stderr.write(`Unknown topic "${topic}". Valid topics: ${validTopics}\n`)
        process.stderr.write('Opening docs homepage instead.\n\n')
      }
      const route = DOCS_ROUTES[topic ?? ''] ?? '/'
      const url = `${DOCS_BASE}${route}`
      process.stdout.write(`Opening ${url}\n`)
      await open(url)
    })
}
