/**
 * Enhanced unknown-option suggestions for the CLI.
 *
 * Extends commander's built-in suggestion logic with:
 * - Negation-aware matching (--strem → --no-stream)
 * - Context-aware hints for common misconceptions (--cloud → "cloud is the default")
 */
import { Command } from 'commander'

// ---------------------------------------------------------------------------
// Hints for flags that aren't typos but semantic misunderstandings.
// Keyed by command name → flag → helpful message.
// ---------------------------------------------------------------------------
const COMMAND_HINTS: Record<string, Record<string, string>> = {
  run: {
    '--cloud': 'Cloud execution is the default. Use --local for local execution.',
  },
}

// ---------------------------------------------------------------------------
// Damerau-Levenshtein distance (same algorithm commander uses internally)
// ---------------------------------------------------------------------------
export function editDistance(a: string, b: string): number {
  const MAX = Math.max(a.length, b.length)
  if (Math.abs(a.length - b.length) > MAX) return MAX

  const d: number[][] = []
  for (let i = 0; i <= a.length; i++) d[i] = [i]
  for (let j = 0; j <= b.length; j++) d[0][j] = j

  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(
        d[i - 1][j] + 1,       // deletion
        d[i][j - 1] + 1,       // insertion
        d[i - 1][j - 1] + cost  // substitution
      )
      // transposition
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
      }
    }
  }
  return d[a.length][b.length]
}

// ---------------------------------------------------------------------------
// Find the best matching option flag for an unknown flag.
//
// Enhancements over commander's built-in:
// - For --no-X options, also compares the unknown against the bare X name.
//   This lets --strem match --no-stream (comparing "strem" vs "stream").
// ---------------------------------------------------------------------------
const MIN_SIMILARITY = 0.4
const MAX_DISTANCE = 3

function isSimilarEnough(dist: number, wordLen: number, candidateLen: number): boolean {
  if (dist > MAX_DISTANCE) return false
  const len = Math.max(wordLen, candidateLen)
  return (len - dist) / len > MIN_SIMILARITY
}

export function findBestMatch(
  unknownFlag: string,
  candidateFlags: string[]
): string | null {
  if (!candidateFlags.length) return null

  const unknown = unknownFlag.replace(/^--?/, '')
  let bestFlag: string | null = null
  let bestDist = MAX_DISTANCE + 1

  for (const candidate of candidateFlags) {
    const name = candidate.replace(/^--?/, '')
    if (name.length <= 1) continue

    // Standard comparison
    const dist = editDistance(unknown, name)
    if (dist < bestDist && isSimilarEnough(dist, unknown.length, name.length)) {
      bestDist = dist
      bestFlag = candidate
    }

    // Negation-aware: for --no-X, also compare unknown against X
    if (name.startsWith('no-')) {
      const baseName = name.slice(3)
      if (baseName.length <= 1) continue
      const baseDist = editDistance(unknown, baseName)
      if (baseDist < bestDist && isSimilarEnough(baseDist, unknown.length, baseName.length)) {
        bestDist = baseDist
        bestFlag = candidate
      }
    }
  }

  return bestFlag
}

// ---------------------------------------------------------------------------
// Override unknownOption on a command tree to provide enhanced suggestions.
// ---------------------------------------------------------------------------
function getHint(commandName: string, flag: string): string | null {
  return COMMAND_HINTS[commandName]?.[flag] ?? null
}

function gatherCandidateFlags(cmd: Command): string[] {
  const flags: string[] = []
  let current: Command | null = cmd
  do {
    const moreFlags = current
      .createHelp()
      .visibleOptions(current)
      .filter((opt: any) => opt.long)
      .map((opt: any) => opt.long as string)
    flags.push(...moreFlags)
    current = current.parent
  } while (current && !(current as any)._enablePositionalOptions)
  return [...new Set(flags)]
}

function overrideUnknownOption(cmd: Command): void {
  ;(cmd as any).unknownOption = function (flag: string) {
    if ((this as any)._allowUnknownOption) return

    // 1. Check for a context-aware hint
    const hint = getHint(this.name(), flag)
    if (hint) {
      this.error(`error: unknown option '${flag}'\n${hint}`, {
        code: 'commander.unknownOption',
      })
      return
    }

    // 2. Gather candidate flags and find best match (enhanced)
    let suggestion = ''
    if (flag.startsWith('--')) {
      const candidates = gatherCandidateFlags(this)
      const match = findBestMatch(flag, candidates)
      if (match) {
        suggestion = `\n(Did you mean ${match}?)`
      }
    }

    this.error(`error: unknown option '${flag}'${suggestion}`, {
      code: 'commander.unknownOption',
    })
  }
}

/**
 * Walk the full command tree and override unknownOption on every command.
 * Call this after all commands have been registered.
 */
export function enhanceUnknownOptionSuggestions(program: Command): void {
  function walk(cmd: Command) {
    overrideUnknownOption(cmd)
    for (const sub of cmd.commands) {
      walk(sub)
    }
  }
  walk(program)
}
