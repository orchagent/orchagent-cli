import { execSync } from 'child_process'

import packageJson from '../../../../package.json'

import type { CheckResult } from '../types'

const REQUIRED_NODE_MAJOR = 18

/**
 * Check if Node.js version is 18+.
 */
export async function checkNodeVersion(): Promise<CheckResult> {
  const version = process.version
  const major = parseInt(version.slice(1).split('.')[0], 10)

  if (major >= REQUIRED_NODE_MAJOR) {
    return {
      category: 'environment',
      name: 'node_version',
      status: 'success',
      message: `Node.js ${version} (${REQUIRED_NODE_MAJOR}+ required)`,
      details: { version, required: `${REQUIRED_NODE_MAJOR}.0.0` },
    }
  }

  return {
    category: 'environment',
    name: 'node_version',
    status: 'error',
    message: `Node.js ${version} is too old (${REQUIRED_NODE_MAJOR}+ required)`,
    fix: `Install Node.js ${REQUIRED_NODE_MAJOR}+ from https://nodejs.org`,
    details: { version, required: `${REQUIRED_NODE_MAJOR}.0.0` },
  }
}

/**
 * Check if CLI is up to date by comparing with npm registry.
 */
export async function checkCliVersion(): Promise<CheckResult> {
  const installedVersion = packageJson.version

  try {
    // Fetch latest version from npm registry
    const response = await fetch(
      'https://registry.npmjs.org/@orchagent/cli/latest',
      { signal: AbortSignal.timeout(5000) }
    )

    if (!response.ok) {
      return {
        category: 'environment',
        name: 'cli_version',
        status: 'warning',
        message: `CLI v${installedVersion} (could not check for updates)`,
        details: { installed: installedVersion, error: 'npm registry unreachable' },
      }
    }

    const data = (await response.json()) as { version: string }
    const latestVersion = data.version

    if (installedVersion === latestVersion) {
      return {
        category: 'environment',
        name: 'cli_version',
        status: 'success',
        message: `CLI v${installedVersion} (up to date)`,
        details: { installed: installedVersion, latest: latestVersion },
      }
    }

    // Compare versions (simple semver comparison)
    const installedParts = installedVersion.split('.').map(Number)
    const latestParts = latestVersion.split('.').map(Number)

    let isOutdated = false
    for (let i = 0; i < 3; i++) {
      if ((latestParts[i] || 0) > (installedParts[i] || 0)) {
        isOutdated = true
        break
      }
      if ((latestParts[i] || 0) < (installedParts[i] || 0)) {
        break
      }
    }

    if (isOutdated) {
      return {
        category: 'environment',
        name: 'cli_version',
        status: 'warning',
        message: `CLI v${installedVersion} (v${latestVersion} available)`,
        fix: 'Run `npm update -g @orchagent/cli` to update',
        details: { installed: installedVersion, latest: latestVersion },
      }
    }

    return {
      category: 'environment',
      name: 'cli_version',
      status: 'success',
      message: `CLI v${installedVersion}`,
      details: { installed: installedVersion, latest: latestVersion },
    }
  } catch (err) {
    return {
      category: 'environment',
      name: 'cli_version',
      status: 'warning',
      message: `CLI v${installedVersion} (could not check for updates)`,
      details: {
        installed: installedVersion,
        error: err instanceof Error ? err.message : 'unknown error',
      },
    }
  }
}

/**
 * Check if git is available in PATH.
 * Note: Uses execSync with hardcoded command string - no user input, safe from injection.
 */
export async function checkGitAvailable(): Promise<CheckResult> {
  try {
    const output = execSync('git --version', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const versionMatch = output.match(/git version (\S+)/)
    const version = versionMatch ? versionMatch[1] : 'unknown'

    return {
      category: 'environment',
      name: 'git_available',
      status: 'success',
      message: `Git available (${version})`,
      details: { version },
    }
  } catch {
    return {
      category: 'environment',
      name: 'git_available',
      status: 'warning',
      message: 'Git not found in PATH',
      fix: 'Install git from https://git-scm.com',
      details: { available: false },
    }
  }
}

/**
 * Run all environment checks.
 */
export async function runEnvironmentChecks(): Promise<CheckResult[]> {
  const results = await Promise.all([
    checkNodeVersion(),
    checkCliVersion(),
    checkGitAvailable(),
  ])
  return results
}
