import { Command } from 'commander'

import {
  getDefaultFormats,
  setDefaultFormats,
  getDefaultScope,
  setDefaultScope,
  getDefaultProvider,
  setDefaultProvider,
  loadConfig,
  getResolvedConfig,
  VALID_FORMAT_IDS,
  VALID_PROVIDERS,
} from '../lib/config'
import { CliError } from '../lib/errors'
import { adapterRegistry } from '../adapters'

// Valid formats: union of skill directory formats and agent export adapters
function getAllValidFormatIds(): string[] {
  const adapterIds = adapterRegistry.getIds()
  const skillFormatIds = [...VALID_FORMAT_IDS] as string[]
  return [...new Set([...adapterIds, ...skillFormatIds])]
}

const SUPPORTED_KEYS = ['default-format', 'default-scope', 'default-provider'] as const
type ConfigKey = (typeof SUPPORTED_KEYS)[number]

function isValidKey(key: string): key is ConfigKey {
  return SUPPORTED_KEYS.includes(key as ConfigKey)
}

async function setConfigValue(key: string, value: string): Promise<void> {
  if (!isValidKey(key)) {
    throw new CliError(
      `Unknown config key: ${key}. Supported keys: ${SUPPORTED_KEYS.join(', ')}`
    )
  }

  if (key === 'default-format') {
    const formats = value.split(',').map((f) => f.trim()).filter(Boolean)

    // Validate format IDs against union of skill formats and agent adapters
    const validFormatIds = getAllValidFormatIds()
    const invalidFormats = formats.filter((f) => !validFormatIds.includes(f))
    if (invalidFormats.length > 0) {
      throw new CliError(
        `Invalid format ID(s): ${invalidFormats.join(', ')}. Valid formats: ${validFormatIds.join(', ')}`
      )
    }

    await setDefaultFormats(formats)
    process.stdout.write(`Set default-format to: ${formats.join(',')}\n`)
  }

  if (key === 'default-scope') {
    if (value !== 'user' && value !== 'project') {
      throw new CliError('Invalid scope. Must be "user" or "project"')
    }
    await setDefaultScope(value)
    process.stdout.write(`Set default-scope to: ${value}\n`)
  }

  if (key === 'default-provider') {
    const validProviders = [...VALID_PROVIDERS] as string[]
    if (!validProviders.includes(value)) {
      throw new CliError(
        `Invalid provider: ${value}. Valid providers: ${validProviders.join(', ')}`
      )
    }
    await setDefaultProvider(value)
    process.stdout.write(`Set default-provider to: ${value}\n`)
  }
}

async function getConfigValue(key: string): Promise<void> {
  if (!isValidKey(key)) {
    throw new CliError(
      `Unknown config key: ${key}. Supported keys: ${SUPPORTED_KEYS.join(', ')}`
    )
  }

  if (key === 'default-format') {
    const resolved = await getResolvedConfig()
    const formats = await getDefaultFormats(resolved)
    if (formats.length === 0) {
      process.stdout.write('(not set)\n')
    } else {
      process.stdout.write(`${formats.join(',')}\n`)
    }
  }

  if (key === 'default-scope') {
    const scope = await getDefaultScope()
    if (!scope) {
      process.stdout.write('(not set)\n')
    } else {
      process.stdout.write(`${scope}\n`)
    }
  }

  if (key === 'default-provider') {
    const provider = await getDefaultProvider()
    if (!provider) {
      process.stdout.write('(not set)\n')
    } else {
      process.stdout.write(`${provider}\n`)
    }
  }
}

async function listConfigValues(): Promise<void> {
  const config = await loadConfig()

  process.stdout.write('CLI Configuration:\n\n')

  // default-format
  const formats = config.default_formats ?? []
  if (formats.length > 0) {
    process.stdout.write(`  default-format: ${formats.join(',')}\n`)
  } else {
    process.stdout.write('  default-format: (not set)\n')
  }

  // default-scope
  const scope = config.default_scope
  if (scope) {
    process.stdout.write(`  default-scope: ${scope}\n`)
  } else {
    process.stdout.write('  default-scope: (not set)\n')
  }

  // default-provider
  const provider = config.default_provider
  if (provider) {
    process.stdout.write(`  default-provider: ${provider}\n`)
  } else {
    process.stdout.write('  default-provider: (not set)\n')
  }

  process.stdout.write('\n')
}

export function registerConfigCommand(program: Command): void {
  const config = program
    .command('config')
    .description('Manage CLI configuration')

  config
    .command('set <key> <value>')
    .description('Set a configuration value')
    .action(async (key: string, value: string) => {
      await setConfigValue(key, value)
    })

  config
    .command('get <key>')
    .description('Get a configuration value')
    .action(async (key: string) => {
      await getConfigValue(key)
    })

  config
    .command('list')
    .description('List all configuration values')
    .action(async () => {
      await listConfigValues()
    })
}
