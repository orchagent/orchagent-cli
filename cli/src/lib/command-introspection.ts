import { Argument, Command, Option } from 'commander'

export type FlagValueType = 'boolean' | 'string' | 'string[]'

export interface CommandArgumentMetadata {
  name: string
  required: boolean
  variadic: boolean
  description: string
  format: string
}

export interface CommandFlagMetadata {
  name: string
  short: string | null
  type: FlagValueType
  required: boolean
  valueRequired: boolean
  description: string
  defaultValue?: unknown
  choices?: readonly string[]
  alias?: string
}

export interface CommandMetadata {
  name: string
  path: string
  description: string
  usage: string
  aliases: string[]
  arguments: CommandArgumentMetadata[]
  flags: CommandFlagMetadata[]
  subcommands: CommandMetadata[]
  mutations: boolean
  dryRun: boolean
  examples: string[]
}

interface BuildMetadataOptions {
  excludeTopLevelCommands?: readonly string[]
}

const MUTATING_TOKENS = new Set([
  'add',
  'clear',
  'connect',
  'create',
  'delete',
  'deploy',
  'disconnect',
  'fork',
  'install',
  'invite',
  'login',
  'logout',
  'publish',
  'remove',
  'revoke',
  'rotate',
  'set',
  'trigger',
  'transfer',
  'unlink',
  'unset',
  'update',
  'use',
])

function normalizeToken(value: string): string {
  return value.trim().toLowerCase()
}

function parseAliasTarget(description: string): string | null {
  const match = description.match(/^\s*alias for\s+(--[a-z0-9][a-z0-9-]*)(?:\.)?\s*$/i)
  if (!match) return null
  return match[1].toLowerCase()
}

function extractOptionAliases(options: readonly Option[]): {
  aliasOptions: Set<string>
  aliasesByPrimary: Map<string, string[]>
} {
  const aliasOptions = new Set<string>()
  const aliasesByPrimary = new Map<string, string[]>()

  for (const option of options) {
    if (!option.long) continue
    const primary = parseAliasTarget(option.description || '')
    if (!primary) continue

    const aliasName = option.long.toLowerCase()
    if (aliasName === primary) continue

    aliasOptions.add(aliasName)
    const existing = aliasesByPrimary.get(primary) || []
    existing.push(option.long)
    aliasesByPrimary.set(primary, existing)
  }

  return { aliasOptions, aliasesByPrimary }
}

function getFlagType(option: Option): FlagValueType {
  if (option.isBoolean()) return 'boolean'
  if (option.variadic) return 'string[]'
  return 'string'
}

function inferArgumentFormat(pathSegments: readonly string[], argument: Argument): string {
  const name = argument.name().toLowerCase()
  const path = pathSegments.join(' ').toLowerCase()

  if (name === 'agent' || name.endsWith('agent')) {
    return 'org/name[@version]'
  }

  if (name === 'command') {
    return 'command [subcommand...]'
  }

  if (name === 'shell') {
    return 'bash | zsh | fish'
  }

  if (name === 'json' || name === 'data' || name === 'input' || name.includes('json')) {
    return 'inline-json | @file | @-'
  }

  if (name.includes('file') || name.includes('path') || name.includes('dir')) {
    return 'path'
  }

  if (path === 'run' && name === 'agent') {
    return 'org/name[@version]'
  }

  return argument.variadic ? `${argument.name()}...` : argument.name()
}

function extractArguments(pathSegments: readonly string[], args: readonly Argument[]): CommandArgumentMetadata[] {
  return args.map((arg) => ({
    name: arg.name(),
    required: arg.required,
    variadic: arg.variadic,
    description: arg.description || '',
    format: inferArgumentFormat(pathSegments, arg),
  }))
}

function extractFlags(options: readonly Option[]): CommandFlagMetadata[] {
  const { aliasOptions, aliasesByPrimary } = extractOptionAliases(options)
  const flags: CommandFlagMetadata[] = []

  for (const option of options) {
    if (option.hidden) continue
    if (!option.long && !option.short) continue
    if (option.long && aliasOptions.has(option.long.toLowerCase())) continue
    if (option.long === '--help') continue

    const aliases = option.long
      ? aliasesByPrimary.get(option.long.toLowerCase()) || []
      : []

    flags.push({
      name: option.long || option.short!,
      short: option.short || null,
      type: getFlagType(option),
      required: option.mandatory,
      valueRequired: option.required,
      description: option.description || '',
      ...(option.defaultValue !== undefined ? { defaultValue: option.defaultValue } : {}),
      ...(option.argChoices ? { choices: option.argChoices } : {}),
      ...(aliases.length > 0 ? { alias: aliases[0] } : {}),
    })
  }

  return flags
}

function renderHelpText(command: Command): string {
  const internal = command as Command & {
    _outputConfiguration: {
      writeOut?: (str: string) => void
      writeErr?: (str: string) => void
      getOutHelpWidth?: () => number
      getErrHelpWidth?: () => number
      outputError?: (str: string, write: (str: string) => void) => void
    }
  }

  const original = internal._outputConfiguration
  let output = ''

  internal._outputConfiguration = {
    ...original,
    writeOut: (str: string) => {
      output += str
    },
    writeErr: (str: string) => {
      output += str
    },
  }

  try {
    command.outputHelp()
  } finally {
    internal._outputConfiguration = original
  }

  return output
}

function extractExamples(command: Command): string[] {
  const helpText = renderHelpText(command)
  const examples = helpText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(orch|orchagent)\s+\S+/.test(line))

  return [...new Set(examples)]
}

function isMutatingSelf(pathSegments: readonly string[], description: string, flags: readonly CommandFlagMetadata[]): boolean {
  if (flags.some((flag) => flag.name === '--dry-run')) {
    return true
  }

  const tokens = pathSegments
    .map((segment) => normalizeToken(segment))
    .flatMap((segment) => segment.split(/[^a-z0-9]+/g))
    .filter(Boolean)

  if (tokens.some((token) => MUTATING_TOKENS.has(token))) {
    return true
  }

  const desc = description.toLowerCase()
  return /\b(add|create|delete|deploy|fork|install|invite|login|logout|publish|remove|revoke|set|transfer|trigger|unset|update|use)\b/.test(desc)
}

function buildUsage(pathSegments: readonly string[], command: Command): string {
  const base = pathSegments.join(' ')
  const usage = command.usage()
  if (!usage) return base
  return `${base} ${usage}`.trim()
}

function buildCommandMetadata(command: Command, parentPath: readonly string[]): CommandMetadata {
  const pathSegments = [...parentPath, command.name()]
  const subcommands = command.commands
    .filter((subcommand) => subcommand.name() !== 'help')
    .map((subcommand) => buildCommandMetadata(subcommand, pathSegments))
  const flags = extractFlags(command.options)
  const selfMutating = isMutatingSelf(pathSegments, command.description(), flags)
  const childMutating = subcommands.some((subcommand) => subcommand.mutations)
  const hasDryRun = flags.some((flag) => flag.name === '--dry-run') || subcommands.some((subcommand) => subcommand.dryRun)

  return {
    name: command.name(),
    path: pathSegments.join(' '),
    description: command.description() || '',
    usage: buildUsage(pathSegments, command),
    aliases: command.aliases(),
    arguments: extractArguments(pathSegments, command.registeredArguments),
    flags,
    subcommands,
    mutations: selfMutating || childMutating,
    dryRun: hasDryRun,
    examples: extractExamples(command),
  }
}

function isCommandMatch(command: CommandMetadata, token: string): boolean {
  const lower = normalizeToken(token)
  if (command.name.toLowerCase() === lower) return true
  return command.aliases.some((alias) => alias.toLowerCase() === lower)
}

export function tokenizeCommandQuery(parts: readonly string[]): string[] {
  return parts
    .flatMap((part) => part.split(/[/:.]/g))
    .map((part) => normalizeToken(part))
    .filter(Boolean)
}

export function buildCliCommandMetadata(program: Command, options?: BuildMetadataOptions): CommandMetadata[] {
  const excluded = new Set((options?.excludeTopLevelCommands || []).map((name) => name.toLowerCase()))

  return program.commands
    .filter((command) => command.name() !== 'help')
    .filter((command) => !excluded.has(command.name().toLowerCase()))
    .map((command) => buildCommandMetadata(command, []))
}

export function findCommandMetadata(commands: readonly CommandMetadata[], queryParts: readonly string[]): CommandMetadata | null {
  const tokens = tokenizeCommandQuery(queryParts)
  if (tokens.length === 0) return null

  let currentCommands = commands
  let matched: CommandMetadata | null = null

  for (const token of tokens) {
    matched = currentCommands.find((command) => isCommandMatch(command, token)) || null
    if (!matched) {
      return null
    }
    currentCommands = matched.subcommands
  }

  return matched
}

export function collectFlagNames(command: CommandMetadata): string[] {
  const names = new Set<string>()

  const visit = (node: CommandMetadata): void => {
    for (const flag of node.flags) {
      names.add(flag.name)
      if (flag.alias) {
        names.add(flag.alias)
      }
    }
    for (const child of node.subcommands) {
      visit(child)
    }
  }

  visit(command)
  return [...names].sort()
}
