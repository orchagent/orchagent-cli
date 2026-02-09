import fs from 'fs/promises'
import path from 'path'
import os from 'os'

import type { CheckResult } from '../types'

const CONFIG_DIR = path.join(os.homedir(), '.orchagent')
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')

/**
 * Check if config file exists.
 */
export async function checkConfigExists(): Promise<CheckResult> {
  try {
    await fs.access(CONFIG_PATH)

    return {
      category: 'configuration',
      name: 'config_exists',
      status: 'success',
      message: `Config file exists (~/.orchagent/config.json)`,
      details: { path: CONFIG_PATH },
    }
  } catch {
    return {
      category: 'configuration',
      name: 'config_exists',
      status: 'warning',
      message: 'Config file not found',
      fix: 'Run `orchagent login` to create config',
      details: { path: CONFIG_PATH, exists: false },
    }
  }
}

/**
 * Check config file permissions (should be 600 for security).
 */
export async function checkConfigPermissions(): Promise<CheckResult> {
  try {
    const stats = await fs.stat(CONFIG_PATH)

    // On Windows, file permissions work differently
    if (process.platform === 'win32') {
      return {
        category: 'configuration',
        name: 'config_permissions',
        status: 'success',
        message: 'Config file permissions (Windows)',
        details: { platform: 'win32', note: 'permissions check skipped on Windows' },
      }
    }

    // Check if permissions are 600 (owner read/write only)
    // mode & 0o777 gives us the permission bits
    const mode = stats.mode & 0o777

    if (mode === 0o600) {
      return {
        category: 'configuration',
        name: 'config_permissions',
        status: 'success',
        message: 'Config file permissions (600)',
        details: { mode: mode.toString(8), expected: '600' },
      }
    }

    // Check if it's too permissive (world or group readable)
    const worldReadable = (mode & 0o004) !== 0
    const groupReadable = (mode & 0o040) !== 0

    if (worldReadable || groupReadable) {
      return {
        category: 'configuration',
        name: 'config_permissions',
        status: 'warning',
        message: `Config file permissions too open (${mode.toString(8)})`,
        fix: 'Run `chmod 600 ~/.orchagent/config.json`',
        details: {
          mode: mode.toString(8),
          expected: '600',
          worldReadable,
          groupReadable,
        },
      }
    }

    return {
      category: 'configuration',
      name: 'config_permissions',
      status: 'success',
      message: `Config file permissions (${mode.toString(8)})`,
      details: { mode: mode.toString(8), expected: '600' },
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Config doesn't exist, skip permissions check
      return {
        category: 'configuration',
        name: 'config_permissions',
        status: 'warning',
        message: 'Config file permissions (file not found)',
        details: { error: 'file not found' },
      }
    }

    return {
      category: 'configuration',
      name: 'config_permissions',
      status: 'warning',
      message: 'Could not check config permissions',
      details: { error: err instanceof Error ? err.message : 'unknown error' },
    }
  }
}

/**
 * Run all config checks.
 */
export async function runConfigChecks(): Promise<CheckResult[]> {
  const results = await Promise.all([checkConfigExists(), checkConfigPermissions()])
  return results
}
