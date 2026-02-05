import { Command } from 'commander'

import {
  getDefaultFormats,
  setDefaultFormats,
  loadConfig,
  getResolvedConfig,
  VALID_FORMAT_IDS,
} from '../lib/config'
import { CliError } from '../lib/errors'
import { adapterRegistry } from '../adapters'

// Valid formats: union of skill directory formats and agent export adapters
function getAllValidFormatIds(): string[] {
  const adapterIds = adapterRegistry.getIds()
  const skillFormatIds = [...VALID_FORMAT_IDS] as string[]
  return [...new Set([...adapterIds, ...skillFormatIds])]
}

const SUPPORTED_KEYS = ['default-format'] as const
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
