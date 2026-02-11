import { Command } from 'commander'

import { registerLoginCommand } from './login'
import { registerCallCommand } from './call'
import { registerAgentsCommand } from './agents'
import { registerInitCommand } from './init'
import { registerPublishCommand } from './publish'
import { registerWhoamiCommand } from './whoami'
import { registerKeysCommand } from './keys'
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

export function registerCommands(program: Command): void {
  registerLoginCommand(program)
  registerWhoamiCommand(program)
  registerInitCommand(program)
  registerPublishCommand(program)
  registerCallCommand(program)
  registerRunCommand(program)
  registerInfoCommand(program)
  registerAgentsCommand(program)
  registerKeysCommand(program)
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
}
