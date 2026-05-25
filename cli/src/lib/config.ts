import fs from 'fs/promises'
import path from 'path'
import os from 'os'

import type { ConfigFile, ResolvedConfig } from '../types'

const CONFIG_DIR = path.join(os.homedir(), '.orchagent')
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')
const DEFAULT_API_URL = 'https://api.orchagent.io'

// Valid format IDs for multi-format agent export
export const VALID_FORMAT_IDS = ['claude-code', 'cursor', 'amp', 'opencode', 'antigravity'] as const
export type FormatId = typeof VALID_FORMAT_IDS[number]

// Map format IDs to skill directories (used by skill install and agent install)
export const FORMAT_SKILL_DIRS: Record<FormatId, { name: string; projectPath: string; userPath: string }> = {
  'claude-code': { name: 'Claude Code', projectPath: '.claude/skills', userPath: '.claude/skills' },
  'cursor': { name: 'Cursor', projectPath: '.cursor/skills', userPath: '.cursor/skills' },
  'amp': { name: 'Amp', projectPath: '.agents/skills', userPath: '.agents/skills' },
  'opencode': { name: 'OpenCode', projectPath: '.opencode/skill', userPath: '.opencode/skill' },
  'antigravity': { name: 'Antigravity', projectPath: '.agent/skills', userPath: '.agent/skills' },
}

export async function loadConfig(): Promise<ConfigFile> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf-8')
    return JSON.parse(raw) as ConfigFile
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {}
    }
    throw err
  }
}

export async function saveConfig(config: ConfigFile): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true })
  const payload = `${JSON.stringify(config, null, 2)}\n`
  await fs.writeFile(CONFIG_PATH, payload, { mode: 0o600 })
  await fs.chmod(CONFIG_PATH, 0o600)
}

export async function getResolvedConfig(
  overrides: Partial<ConfigFile> = {},
  profile?: string
): Promise<ResolvedConfig> {
  const fileConfig = await loadConfig()
  const requestedProfile = profile ?? process.env.ORCHAGENT_PROFILE

  // If profile specified, get config from profiles
  const profileConfig = requestedProfile ? fileConfig.profiles?.[requestedProfile] : undefined
  const profileMode = Boolean(requestedProfile)

  // Config file wins over env var for interactive use (login/logout work correctly).
  // CI/CD and per-process task runners can use overrides, profiles, or
  // ORCHAGENT_PROFILE+ORCHAGENT_API_KEY. In profile mode we intentionally do
  // not fall back to the top-level active login, because that would silently
  // target the wrong account from an isolated task terminal.
  const apiKey =
    overrides.api_key ??
    profileConfig?.api_key ??
    (profileMode ? (process.env.ORCHAGENT_API_KEY || undefined) : (fileConfig.api_key ?? (process.env.ORCHAGENT_API_KEY || undefined)))
  const apiUrl =
    overrides.api_url ??
    process.env.ORCHAGENT_API_URL ??
    profileConfig?.api_url ??
    (profileMode ? undefined : fileConfig.api_url) ??
    DEFAULT_API_URL
  const defaultOrg =
    overrides.default_org ??
    process.env.ORCHAGENT_DEFAULT_ORG ??
    profileConfig?.default_org ??
    (profileMode ? undefined : fileConfig.default_org)

  return {
    apiKey,
    apiUrl,
    defaultOrg,
  }
}

export function getConfigPath(): string {
  return CONFIG_PATH
}

export async function getDefaultFormats(resolvedConfig?: ResolvedConfig): Promise<string[]> {
  // 1. Check local config first (explicit override)
  const config = await loadConfig()
  if (config.default_formats?.length) {
    return config.default_formats
  }

  // 2. Try server preferences (if logged in)
  if (resolvedConfig?.apiKey) {
    try {
      const { fetchUserProfile } = await import('./api')
      const user = await fetchUserProfile(resolvedConfig)
      if (user.preferences?.default_formats?.length) {
        return user.preferences.default_formats
      }
    } catch {
      // Offline or not logged in - use defaults
    }
  }

  // 3. Return empty (no default = install to all)
  return []
}

export async function setDefaultFormats(formats: string[]): Promise<void> {
  const config = await loadConfig()
  config.default_formats = formats
  await saveConfig(config)
}

export async function getDefaultScope(): Promise<'user' | 'project' | undefined> {
  const config = await loadConfig()
  return config.default_scope
}

export async function setDefaultScope(scope: 'user' | 'project'): Promise<void> {
  const config = await loadConfig()
  config.default_scope = scope
  await saveConfig(config)
}

export const VALID_PROVIDERS = ['openai', 'anthropic', 'gemini'] as const

export async function getDefaultProvider(): Promise<string | undefined> {
  const config = await loadConfig()
  return config.default_provider
}

export async function setDefaultProvider(provider: string): Promise<void> {
  const config = await loadConfig()
  config.default_provider = provider
  await saveConfig(config)
}

/**
 * Remove a config key, restoring it to "not set" state.
 * Maps CLI key names (kebab-case) to ConfigFile properties.
 */
const CONFIG_KEY_MAP: Record<string, keyof ConfigFile> = {
  'default-format': 'default_formats',
  'default-scope': 'default_scope',
  'default-provider': 'default_provider',
}

export async function unsetConfigKey(cliKey: string): Promise<void> {
  const configProp = CONFIG_KEY_MAP[cliKey]
  if (!configProp) {
    throw new Error(`Unknown config key: ${cliKey}`)
  }
  const config = await loadConfig()
  delete config[configProp]
  await saveConfig(config)
}
