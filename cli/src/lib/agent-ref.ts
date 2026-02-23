import { CliError } from './errors'

export type AgentRef = {
  org?: string
  agent: string
  version: string
}

export function parseAgentRef(value: string, defaultVersion = 'latest'): AgentRef {
  const [ref, versionPart] = value.split('@')
  const version = versionPart?.trim() || defaultVersion
  const segments = ref.split('/')
  if (segments.length === 1) {
    return { org: undefined, agent: segments[0], version }
  }
  if (segments.length === 2) {
    return { org: segments[0], agent: segments[1], version }
  }
  throw new CliError('Invalid agent reference. Use agent or org/agent[@version] format')
}
