import { Command } from 'commander'

import { registerLoginCommand } from './login'
import { registerLogoutCommand } from './logout'
import { registerAgentsCommand } from './agents'
import { registerInitCommand } from './init'
import { registerPublishCommand } from './publish'
import { registerWhoamiCommand } from './whoami'
import { registerRunCommand } from './run'
import { registerInfoCommand } from './info'
import { registerSkillCommand } from './skill'
import { registerDeleteCommand } from './delete'
import { registerForkCommand } from './fork'
import { registerGitHubCommand } from './github'
import { registerDoctorCommand } from './doctor'
import { registerStatusCommand } from './status'
import { registerWorkspaceCommand } from './workspace'
import { registerTreeCommand } from './tree'
import { registerDocsCommand } from './docs'
import { registerConfigCommand } from './config'
import { registerInstallCommand } from './install'
import { registerFormatsCommand } from './formats'
import { registerUpdateCommand } from './update'
import { registerEnvCommand } from './env'
import { registerListCommand } from './list'
import { registerTestCommand } from './test'
import { registerSecurityCommand } from './security'
import { registerBillingCommand } from './billing'
import { registerAgentKeysCommand } from './agent-keys'
import { registerScheduleCommand } from './schedule'
import { registerServiceCommand } from './service'
import { registerTransferCommand } from './transfer'
import { registerPullCommand } from './pull'
import { registerLogsCommand } from './logs'
import { registerSecretsCommand } from './secrets'
import { registerDiffCommand } from './diff'
import { registerHealthCommand } from './health'
import { registerDevCommand } from './dev'
import { registerEstimateCommand } from './estimate'
import { registerReplayCommand } from './replay'
import { registerTraceCommand } from './trace'
import { registerMetricsCommand } from './metrics'
import { registerDagCommand } from './dag'
import { registerCompletionCommand } from './completion'

export function registerCommands(program: Command): void {
  registerLoginCommand(program)
  registerLogoutCommand(program)
  registerWhoamiCommand(program)
  registerInitCommand(program)
  registerPublishCommand(program)
  registerRunCommand(program)
  registerInfoCommand(program)
  registerAgentsCommand(program)
  registerSkillCommand(program)
  registerDeleteCommand(program)
  registerForkCommand(program)
  registerGitHubCommand(program)
  registerDoctorCommand(program)
  registerStatusCommand(program)
  registerWorkspaceCommand(program)
  registerTreeCommand(program)
  registerDocsCommand(program)
  registerConfigCommand(program)
  registerInstallCommand(program)
  registerFormatsCommand(program)
  registerUpdateCommand(program)
  registerEnvCommand(program)
  registerListCommand(program)
  registerTestCommand(program)
  registerSecurityCommand(program)
  registerBillingCommand(program)
  registerAgentKeysCommand(program)
  registerScheduleCommand(program)
  registerServiceCommand(program)
  registerTransferCommand(program)
  registerPullCommand(program)
  registerLogsCommand(program)
  registerSecretsCommand(program)
  registerDiffCommand(program)
  registerHealthCommand(program)
  registerDevCommand(program)
  registerEstimateCommand(program)
  registerReplayCommand(program)
  registerTraceCommand(program)
  registerMetricsCommand(program)
  registerDagCommand(program)
  registerCompletionCommand(program)
}
