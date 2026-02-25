export interface WorkspaceMatrixFixture {
  personalApiKey?: string
  teamApiKey?: string
  publicAgentRef: string
  personalPrivateAgentRef?: string
  teamPrivateAgentRef?: string
}

export function getWorkspaceMatrixFixture(): WorkspaceMatrixFixture {
  return {
    personalApiKey: process.env.ORCHAGENT_API_KEY_MATRIX_PERSONAL,
    teamApiKey: process.env.ORCHAGENT_API_KEY_MATRIX_TEAM,
    publicAgentRef: process.env.ORCHAGENT_MATRIX_PUBLIC_AGENT ?? 'orchagent-public/leak-finder',
    personalPrivateAgentRef: process.env.ORCHAGENT_MATRIX_PERSONAL_PRIVATE_AGENT,
    teamPrivateAgentRef: process.env.ORCHAGENT_MATRIX_TEAM_PRIVATE_AGENT,
  }
}

export function shouldSkipLiveMatrix(): boolean {
  return process.env.ORCH_E2E_SKIP_LIVE === '1'
}
