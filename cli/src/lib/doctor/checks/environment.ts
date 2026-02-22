import { execSync, execFileSync } from 'child_process'
import { realpathSync } from 'fs'

import packageJson from '../../../../package.json'
import { DIST_TAGS_URL, writeCache } from '../../update-notifier'

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
    // Fetch latest version from the same dist-tags endpoint the update banner uses,
    // so both always agree on the latest version (fixes D-1 inconsistency).
    const response = await fetch(
      DIST_TAGS_URL,
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

    const data = (await response.json()) as { latest: string }
    const latestVersion = data.latest

    // Sync the update-notifier cache so the banner shows the same version
    writeCache(latestVersion)

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
        fix: 'Run `npm install -g @orchagent/cli@latest` to update',
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
 * Find all binary paths for a given command name using `which -a`.
 * Returns an empty array if the command is not found.
 * Note: Uses execSync with a hardcoded binary name — no user input, safe from injection.
 */
function findAllBinaryPaths(binaryName: string): string[] {
  try {
    const output = execSync(`which -a ${binaryName}`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return output.trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Get the CLI version from a binary path by running it with --version.
 * Uses execFileSync (no shell) to avoid injection via path characters.
 */
function getVersionFromBinary(binPath: string): string | null {
  try {
    const output = execFileSync(binPath, ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const match = output.match(/(\d+\.\d+\.\d+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

/**
 * Resolve a path through symlinks. Returns the original path if resolution fails.
 */
function safeRealpathSync(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

interface InstallationInfo {
  path: string
  realPath: string
  version: string
  binary: string
}

/**
 * Detect multiple CLI installations at different paths/versions (BUG-008).
 *
 * System-level (/usr/local/bin/orchagent) and user-level (~/.npm-global/bin/orch)
 * installs can coexist silently. `npm update -g` updates one but not the other,
 * leaving the user running an outdated version without knowing it.
 */
export async function checkDualInstallation(): Promise<CheckResult> {
  // Skip on Windows (which -a not available)
  if (process.platform === 'win32') {
    return {
      category: 'environment',
      name: 'dual_installation',
      status: 'info',
      message: 'Installation path check skipped (Windows)',
      details: { skipped: true, reason: 'Windows not supported' },
    }
  }

  try {
    const binaryNames = ['orch', 'orchagent']
    const installations = new Map<string, InstallationInfo>()

    for (const binary of binaryNames) {
      const paths = findAllBinaryPaths(binary)

      for (const binPath of paths) {
        const realPath = safeRealpathSync(binPath)

        // Deduplicate by resolved real path
        if (installations.has(realPath)) continue

        const version = getVersionFromBinary(binPath) || 'unknown'

        installations.set(realPath, {
          path: binPath,
          realPath,
          version,
          binary,
        })
      }
    }

    if (installations.size <= 1) {
      return {
        category: 'environment',
        name: 'dual_installation',
        status: 'success',
        message: 'Single CLI installation',
        details: {
          installationCount: installations.size,
          installations: [...installations.values()],
        },
      }
    }

    // Multiple installations found
    const allInstalls = [...installations.values()]
    const versions = new Set(allInstalls.map((i) => i.version))
    const versionsDiffer = versions.size > 1

    const pathList = allInstalls
      .map((i) => `${i.path} (v${i.version})`)
      .join(', ')

    if (versionsDiffer) {
      return {
        category: 'environment',
        name: 'dual_installation',
        status: 'warning',
        message: `Multiple CLI versions found: ${pathList}`,
        fix: 'Remove the outdated installation. Run `which -a orch orchagent` to see all paths, then remove the older binary',
        details: {
          installationCount: installations.size,
          versionMismatch: true,
          installations: allInstalls,
        },
      }
    }

    // Same version at multiple paths — informational only
    return {
      category: 'environment',
      name: 'dual_installation',
      status: 'info',
      message: `Multiple CLI paths (same version v${allInstalls[0].version}): ${pathList}`,
      details: {
        installationCount: installations.size,
        versionMismatch: false,
        installations: allInstalls,
      },
    }
  } catch (err) {
    return {
      category: 'environment',
      name: 'dual_installation',
      status: 'info',
      message: 'Could not check for duplicate installations',
      details: {
        error: err instanceof Error ? err.message : 'unknown error',
      },
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
    checkDualInstallation(),
  ])
  return results
}
