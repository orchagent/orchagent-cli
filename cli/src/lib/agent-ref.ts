import { CliError } from './errors'
import { rejectResourceIdChars } from './sanitize'

export type AgentRef = {
  org?: string
  agent: string
  version: string
}

export function parseAgentRef(value: string, defaultVersion = 'latest'): AgentRef {
  // DX-29: reject unsafe chars in the raw input before parsing
  rejectResourceIdChars(value, 'agent reference')

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
