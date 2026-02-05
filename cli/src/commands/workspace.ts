import { Command } from 'commander'
import Table from 'cli-table3'
import chalk from 'chalk'

import { getResolvedConfig, loadConfig, saveConfig } from '../lib/config'
import { request } from '../lib/api'
import { CliError } from '../lib/errors'
import { track } from '../lib/analytics'
import type { ResolvedConfig, ConfigFile } from '../types'

interface Workspace {
  id: string
  name: string
  slug: string
  type: 'personal' | 'team'
  role: 'owner' | 'member'
  member_count: number
}

interface WorkspaceMember {
  id: string
  clerk_user_id: string
  email: string | null
  name: string | null
  role: 'owner' | 'member'
  accepted_at: string | null
}

interface WorkspaceInvite {
  id: string
  email: string
  role: 'owner' | 'member'
  created_at: string
  expires_at: string
  email_sent?: boolean
  invite_url?: string
}

interface MembersResponse {
  members: WorkspaceMember[]
  invites: WorkspaceInvite[]
}

interface UserProfile {
  id: string
  email: string
  display_name: string
  avatar_url?: string
  bio?: string
  email_verified?: boolean
  created_at: string
  updated_at: string
  last_login_at?: string
}

interface WorkspacesResponse {
  workspaces: Workspace[]
}

interface WorkspaceCreateResponse {
  workspace: Workspace
}

interface UserResponse {
  user: UserProfile
}

interface InviteCreateResponse {
  invite: {
    id: string
    email: string
    role: string
    created_at: string
    expires_at: string
    email_sent: boolean
    invite_url?: string
  }
}

function deriveSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

async function resolveWorkspaceId(
  config: ResolvedConfig,
  slug?: string
): Promise<string> {
  const configFile = await loadConfig()
  const targetSlug = slug ?? configFile.workspace

  if (!targetSlug) {
    throw new CliError(
      'No workspace specified. Use --workspace <slug> or run `orchagent workspace use <slug>` first.'
    )
  }

  const response = await request<WorkspacesResponse>(config, 'GET', '/workspaces')
  const workspace = response.workspaces.find((w) => w.slug === targetSlug)

  if (!workspace) {
    throw new CliError(`Workspace '${targetSlug}' not found.`)
  }

  return workspace.id
}

async function listWorkspaces(
  config: ResolvedConfig,
  options: { json?: boolean }
): Promise<void> {
  const response = await request<WorkspacesResponse>(config, 'GET', '/workspaces')
  const workspaces = response.workspaces
  const configFile = await loadConfig()
  const currentSlug = configFile.workspace

  await track('cli_workspace_list')

  if (options.json) {
    process.stdout.write(`${JSON.stringify(workspaces, null, 2)}\n`)
    return
  }

  if (workspaces.length === 0) {
    process.stdout.write('No workspaces found.\n')
    process.stdout.write('\nCreate one with: orchagent workspace create <name>\n')
    return
  }

  const table = new Table({
    head: [
      '',
      chalk.bold('Name'),
      chalk.bold('Slug'),
      chalk.bold('Type'),
      chalk.bold('Role'),
      chalk.bold('Members'),
    ],
  })

  workspaces.forEach((workspace) => {
    const isCurrent = workspace.slug === currentSlug
    const marker = isCurrent ? chalk.green('\u2192') : ''

    table.push([
      marker,
      workspace.name,
      workspace.slug,
      workspace.type,
      workspace.role,
      workspace.member_count.toString(),
    ])
  })

  process.stdout.write(`${table.toString()}\n`)
}

async function createWorkspace(
  config: ResolvedConfig,
  name: string,
  options: { slug?: string }
): Promise<void> {
  const slug = options.slug ?? deriveSlug(name)

  const response = await request<WorkspaceCreateResponse>(config, 'POST', '/workspaces', {
    body: JSON.stringify({ name, slug }),
    headers: { 'Content-Type': 'application/json' },
  })

  await track('cli_workspace_create', { slug })

  process.stdout.write(chalk.green('\u2713') + ` Created workspace: ${response.workspace.name} (${response.workspace.slug})\n`)
}

async function useWorkspace(slug: string): Promise<void> {
  const config = await getResolvedConfig()

  // Verify workspace exists
  const response = await request<WorkspacesResponse>(config, 'GET', '/workspaces')
  const workspace = response.workspaces.find((w) => w.slug === slug)

  if (!workspace) {
    throw new CliError(`Workspace '${slug}' not found.`)
  }

  // Save to config
  const configFile = await loadConfig()
  configFile.workspace = slug
  await saveConfig(configFile)

  await track('cli_workspace_use', { slug })

  process.stdout.write(chalk.green('\u2713') + ` Now using workspace: ${workspace.name} (${workspace.slug})\n`)
}

async function listMembers(
  config: ResolvedConfig,
  workspaceSlug: string | undefined,
  options: { json?: boolean }
): Promise<void> {
  const workspaceId = await resolveWorkspaceId(config, workspaceSlug)

  const response = await request<MembersResponse>(
    config,
    'GET',
    `/workspaces/${workspaceId}/members`
  )

  await track('cli_workspace_members')

  if (options.json) {
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`)
    return
  }

  // Members table
  if (response.members.length > 0) {
    process.stdout.write('Members:\n')
    const membersTable = new Table({
      head: [
        chalk.bold('Name'),
        chalk.bold('Email'),
        chalk.bold('Role'),
        chalk.bold('Joined'),
      ],
    })

    response.members.forEach((member) => {
      membersTable.push([
        member.name ?? '-',
        member.email ?? '-',
        member.role,
        member.accepted_at ? new Date(member.accepted_at).toLocaleDateString() : '-',
      ])
    })

    process.stdout.write(`${membersTable.toString()}\n`)
  } else {
    process.stdout.write('No members found.\n')
  }

  // Pending invites table (the gateway only returns pending invites)
  if (response.invites.length > 0) {
    process.stdout.write('\nPending Invites:\n')
    const invitesTable = new Table({
      head: [
        chalk.bold('Email'),
        chalk.bold('Role'),
        chalk.bold('Sent'),
      ],
    })

    response.invites.forEach((invite) => {
      invitesTable.push([
        invite.email,
        invite.role,
        new Date(invite.created_at).toLocaleDateString(),
      ])
    })

    process.stdout.write(`${invitesTable.toString()}\n`)
  }
}

async function inviteMember(
  config: ResolvedConfig,
  email: string,
  options: { role?: string; workspace?: string }
): Promise<void> {
  const workspaceId = await resolveWorkspaceId(config, options.workspace)
  const role = options.role ?? 'member'

  const response = await request<InviteCreateResponse>(
    config,
    'POST',
    `/workspaces/${workspaceId}/invites`,
    {
      body: JSON.stringify({ email, role }),
      headers: { 'Content-Type': 'application/json' },
    }
  )

  await track('cli_workspace_invite', { role })

  process.stdout.write(chalk.green('\u2713') + ` Invited ${email} as ${role}\n`)

  if (response.invite.invite_url) {
    process.stdout.write(`\nInvite URL: ${response.invite.invite_url}\n`)
  }
}

async function leaveWorkspace(
  config: ResolvedConfig,
  workspaceSlug: string | undefined
): Promise<void> {
  const workspaceId = await resolveWorkspaceId(config, workspaceSlug)

  // Get current user's email and members list to find our clerk_user_id
  const [userResponse, membersResponse] = await Promise.all([
    request<UserResponse>(config, 'GET', '/users/me'),
    request<MembersResponse>(config, 'GET', `/workspaces/${workspaceId}/members`),
  ])

  const currentUserEmail = userResponse.user.email
  const currentMember = membersResponse.members.find((m) => m.email === currentUserEmail)

  if (!currentMember) {
    throw new CliError('Could not find your membership in this workspace.')
  }

  await request(
    config,
    'DELETE',
    `/workspaces/${workspaceId}/members/${currentMember.clerk_user_id}`
  )

  await track('cli_workspace_leave')

  // Clear workspace from config if it was the current one
  const configFile = await loadConfig()
  if (configFile.workspace) {
    const response = await request<WorkspacesResponse>(config, 'GET', '/workspaces')
    const leftWorkspace = response.workspaces.find((w) => w.id === workspaceId)
    if (leftWorkspace && configFile.workspace === leftWorkspace.slug) {
      delete configFile.workspace
      await saveConfig(configFile)
    }
  }

  process.stdout.write(chalk.green('\u2713') + ' Left workspace\n')
}

export function registerWorkspaceCommand(program: Command): void {
  const workspace = program
    .command('workspace')
    .description('Manage workspaces')

  // workspace list
  workspace
    .command('list')
    .description('List all workspaces')
    .option('--json', 'Output raw JSON')
    .action(async (options: { json?: boolean }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orchagent login` first.')
      }

      await listWorkspaces(config, options)
    })

  // workspace create <name>
  workspace
    .command('create <name>')
    .description('Create a new workspace')
    .option('--slug <slug>', 'Workspace slug (default: derived from name)')
    .action(async (name: string, options: { slug?: string }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orchagent login` first.')
      }

      await createWorkspace(config, name, options)
    })

  // workspace use <slug>
  workspace
    .command('use <slug>')
    .description('Set the current workspace')
    .action(async (slug: string) => {
      await useWorkspace(slug)
    })

  // workspace members [workspace]
  workspace
    .command('members [workspace]')
    .description('List workspace members and pending invites')
    .option('--json', 'Output raw JSON')
    .action(async (workspaceSlug: string | undefined, options: { json?: boolean }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orchagent login` first.')
      }

      await listMembers(config, workspaceSlug, options)
    })

  // workspace invite <email>
  workspace
    .command('invite <email>')
    .description('Invite a user to the workspace')
    .option('--role <role>', 'Role for the invited user (default: member)', 'member')
    .option('--workspace <slug>', 'Workspace slug (default: current workspace)')
    .action(async (email: string, options: { role?: string; workspace?: string }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orchagent login` first.')
      }

      await inviteMember(config, email, options)
    })

  // workspace leave [workspace]
  workspace
    .command('leave [workspace]')
    .description('Leave a workspace')
    .action(async (workspaceSlug: string | undefined) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orchagent login` first.')
      }

      await leaveWorkspace(config, workspaceSlug)
    })
}
