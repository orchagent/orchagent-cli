/**
 * Lightweight CLI update notifier.
 *
 * Design goals:
 *   1. NEVER crash or block the CLI — every call is wrapped in try/catch
 *   2. Zero npm dependencies — uses only Node built-ins (https, fs, path, os)
 *   3. Works on Node 14+ — avoids fetch(), AbortController, and other modern APIs
 *   4. Non-blocking — the HTTP check uses req.unref() so it won't prevent process exit
 *   5. Cached — checks npm registry at most once per 24 hours
 *
 * Flow:
 *   - On startup: read ~/.orchagent/update-check.json (sync, ~1ms)
 *   - If cache is stale (>24h): fire off a background HTTPS GET to registry, write result
 *   - After command completes: if cached version > current version, print one-line notice
 */

import https from 'https'
import fs from 'fs'
import path from 'path'
import os from 'os'

import packageJson from '../../package.json'

const PACKAGE_NAME = '@orchagent/cli'
const CACHE_DIR = path.join(os.homedir(), '.orchagent')
const CACHE_PATH = path.join(CACHE_DIR, 'update-check.json')
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours
const REQUEST_TIMEOUT_MS = 5000

interface UpdateCache {
  latest: string
  checkedAt: number
}

// ── Cache I/O ──────────────────────────────────────────────────────────

function readCache(): UpdateCache | null {
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.latest === 'string' && typeof parsed.checkedAt === 'number') {
      return parsed as UpdateCache
    }
    return null
  } catch {
    return null
  }
}

function writeCache(latest: string): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    fs.writeFileSync(
      CACHE_PATH,
      JSON.stringify({ latest, checkedAt: Date.now() } satisfies UpdateCache)
    )
  } catch {
    // Best-effort — silently ignore write failures
  }
}

function isCacheStale(cache: UpdateCache | null): boolean {
  if (!cache) return true
  return Date.now() - cache.checkedAt > CHECK_INTERVAL_MS
}

// ── Version comparison ─────────────────────────────────────────────────

function isNewer(latest: string, current: string): boolean {
  const a = latest.split('.').map(Number)
  const b = current.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true
    if ((a[i] || 0) < (b[i] || 0)) return false
  }
  return false
}

// ── Background check ───────────────────────────────────────────────────

function triggerBackgroundCheck(): void {
  try {
    const url = `https://registry.npmjs.org/-/package/${PACKAGE_NAME}/dist-tags`
    const req = https.get(url, { timeout: REQUEST_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume() // drain
        return
      }
      let data = ''
      res.on('data', (chunk: Buffer) => { data += chunk })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          if (typeof parsed.latest === 'string') {
            writeCache(parsed.latest)
          }
        } catch {
          // Malformed JSON — ignore
        }
      })
    })
    req.on('error', () => { /* network failure — ignore */ })
    req.on('timeout', () => { req.destroy() })
    // Don't keep the process alive waiting for this response
    req.on('socket', (socket) => { socket.unref() })
  } catch {
    // Spawn/setup failure — ignore
  }
}

// ── Public API ──────────────────────────────────────────────────────────

/** State captured at startup; used later by printUpdateNotification(). */
let cachedLatest: string | null = null

/**
 * Call once at CLI startup. Reads the cache (sync, fast) and fires off
 * a background registry check if the cache is stale. Never throws.
 */
export function checkForUpdates(): void {
  try {
    // Respect opt-out
    if (process.env.NO_UPDATE_NOTIFIER) return

    const cache = readCache()
    if (cache) {
      cachedLatest = cache.latest
    }
    if (isCacheStale(cache)) {
      triggerBackgroundCheck()
    }
  } catch {
    // Absolutely never crash
  }
}

/**
 * Call after the command finishes. Prints a one-line update notice to
 * stderr if a newer version is available. Never throws.
 */
export function printUpdateNotification(): void {
  try {
    if (!cachedLatest) return
    const current = packageJson.version
    if (isNewer(cachedLatest, current)) {
      process.stderr.write(
        `\nUpdate available: v${current} → v${cachedLatest}\n` +
        `Run \`npm update -g @orchagent/cli\` to update\n`
      )
    }
  } catch {
    // Absolutely never crash
  }
}
