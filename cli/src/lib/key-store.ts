import fs from 'fs/promises'
import path from 'path'
import os from 'os'

const KEYS_DIR = path.join(os.homedir(), '.orchagent', 'keys')

export interface StoredKey {
  key: string
  prefix: string
  agent_version: string
  created_at: string
}

/**
 * Build the path to the key file for an agent: ~/.orchagent/keys/{org}/{agent}.json
 */
function keyFilePath(org: string, agentName: string): string {
  return path.join(KEYS_DIR, org, `${agentName}.json`)
}

/**
 * Save a service key locally after creation (publish, fork, or agent-keys create).
 * Keys are stored per-agent in ~/.orchagent/keys/{org}/{agent}.json with 0600 permissions.
 */
export async function saveServiceKey(
  org: string,
  agentName: string,
  agentVersion: string,
  key: string,
  prefix: string,
): Promise<string> {
  const filePath = keyFilePath(org, agentName)
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })

  // Load existing keys for this agent
  const existing = await loadServiceKeys(org, agentName)

  const entry: StoredKey = {
    key,
    prefix,
    agent_version: agentVersion,
    created_at: new Date().toISOString(),
  }

  existing.push(entry)
  await fs.writeFile(filePath, JSON.stringify(existing, null, 2) + '\n', { mode: 0o600 })
  await fs.chmod(filePath, 0o600)

  return filePath
}

/**
 * Load locally-saved service keys for a specific agent.
 */
export async function loadServiceKeys(org: string, agentName: string): Promise<StoredKey[]> {
  try {
    const raw = await fs.readFile(keyFilePath(org, agentName), 'utf-8')
    return JSON.parse(raw) as StoredKey[]
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw err
  }
}

/**
 * List all locally-saved service keys across all orgs/agents.
 * Returns entries grouped by org/agent.
 */
export async function listAllLocalKeys(): Promise<{ org: string; agent: string; keys: StoredKey[] }[]> {
  const results: { org: string; agent: string; keys: StoredKey[] }[] = []

  let orgDirs: string[]
  try {
    orgDirs = await fs.readdir(KEYS_DIR)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw err
  }

  for (const orgDir of orgDirs) {
    const orgPath = path.join(KEYS_DIR, orgDir)
    const stat = await fs.stat(orgPath)
    if (!stat.isDirectory()) continue

    const files = await fs.readdir(orgPath)
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const agentName = file.replace('.json', '')
      try {
        const raw = await fs.readFile(path.join(orgPath, file), 'utf-8')
        const keys = JSON.parse(raw) as StoredKey[]
        if (keys.length > 0) {
          results.push({ org: orgDir, agent: agentName, keys })
        }
      } catch {
        // Skip corrupted files
      }
    }
  }

  return results
}

/**
 * Delete a locally-saved key by prefix match. Returns true if found and removed.
 */
export async function deleteLocalKey(org: string, agentName: string, prefix: string): Promise<boolean> {
  const keys = await loadServiceKeys(org, agentName)
  const filtered = keys.filter(k => k.prefix !== prefix)

  if (filtered.length === keys.length) {
    return false // nothing removed
  }

  const filePath = keyFilePath(org, agentName)
  if (filtered.length === 0) {
    await fs.unlink(filePath)
  } else {
    await fs.writeFile(filePath, JSON.stringify(filtered, null, 2) + '\n', { mode: 0o600 })
    await fs.chmod(filePath, 0o600)
  }

  return true
}

/**
 * Get the keys directory path (for display purposes).
 */
export function getKeysDir(): string {
  return KEYS_DIR
}
