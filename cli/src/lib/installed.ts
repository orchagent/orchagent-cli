import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import crypto from 'crypto'

const ORCHAGENT_DIR = path.join(os.homedir(), '.orchagent')
const INSTALLED_PATH = path.join(ORCHAGENT_DIR, 'installed.json')

export interface InstalledAgent {
  agent: string           // e.g., "joe/code-reviewer"
  version: string         // e.g., "v2"
  format: string          // e.g., "claude-code"
  scope: 'user' | 'project'
  path: string            // Full path to installed file
  installedAt: string     // ISO timestamp
  adapterVersion: string  // Version of adapter used
  contentHash: string     // SHA-256 hash for modification detection
}

interface InstalledFile {
  version: 1
  installed: InstalledAgent[]
}

/**
 * Compute SHA-256 hash of content
 */
export function computeHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

/**
 * Load installed agents from tracking file
 */
export async function loadInstalled(): Promise<InstalledFile> {
  try {
    const raw = await fs.readFile(INSTALLED_PATH, 'utf-8')
    return JSON.parse(raw) as InstalledFile
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, installed: [] }
    }
    throw err
  }
}

/**
 * Save installed agents to tracking file
 */
export async function saveInstalled(data: InstalledFile): Promise<void> {
  await fs.mkdir(ORCHAGENT_DIR, { recursive: true })
  await fs.writeFile(INSTALLED_PATH, JSON.stringify(data, null, 2) + '\n')
}

/**
 * Track a newly installed agent
 */
export async function trackInstall(agent: InstalledAgent): Promise<void> {
  const data = await loadInstalled()

  // Remove any existing entry for same agent/format/scope/path
  data.installed = data.installed.filter(
    i => !(i.agent === agent.agent && i.format === agent.format && i.path === agent.path)
  )

  // Add new entry
  data.installed.push(agent)

  await saveInstalled(data)
}

/**
 * Get all installed agents
 */
export async function getInstalled(): Promise<InstalledAgent[]> {
  const data = await loadInstalled()
  return data.installed
}

/**
 * Get installed agents filtered by format
 */
export async function getInstalledByFormat(format: string): Promise<InstalledAgent[]> {
  const data = await loadInstalled()
  return data.installed.filter(i => i.format === format)
}

export interface FileStatus {
  modified: boolean
  missing: boolean
}

/**
 * Check if a file has been modified since installation or is missing
 */
export async function checkModified(installed: InstalledAgent): Promise<FileStatus> {
  try {
    const content = await fs.readFile(installed.path, 'utf-8')
    const currentHash = computeHash(content)
    return { modified: currentHash !== installed.contentHash, missing: false }
  } catch {
    // File doesn't exist or can't be read
    return { modified: false, missing: true }
  }
}

/**
 * Remove an installed agent from tracking
 */
export async function untrackInstall(agentRef: string, format: string, filePath: string): Promise<void> {
  const data = await loadInstalled()
  data.installed = data.installed.filter(
    i => !(i.agent === agentRef && i.format === format && i.path === filePath)
  )
  await saveInstalled(data)
}

/**
 * Verify installed entries and optionally remove orphaned ones
 * Returns { valid: InstalledAgent[], orphaned: InstalledAgent[] }
 */
export async function verifyInstalled(removeOrphaned: boolean = false): Promise<{
  valid: InstalledAgent[]
  orphaned: InstalledAgent[]
}> {
  const data = await loadInstalled()
  const valid: InstalledAgent[] = []
  const orphaned: InstalledAgent[] = []

  for (const agent of data.installed) {
    try {
      await fs.access(agent.path)
      valid.push(agent)
    } catch {
      orphaned.push(agent)
    }
  }

  if (removeOrphaned && orphaned.length > 0) {
    data.installed = valid
    await saveInstalled(data)
  }

  return { valid, orphaned }
}
