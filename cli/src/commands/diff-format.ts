/**
 * Formatting and colorized output for `orch diff`.
 *
 * Git-style red/green coloring: removed lines are red, added lines are green,
 * changed fields show old in red and new in green. Structured fields
 * (arrays, dependencies, custom_tools, schemas, models) get item-level diffs.
 */

import chalk from 'chalk'
import type {
  FieldDiff,
  Schema,
  ManifestDependency,
  CustomTool,
} from './diff'

// ── Plain value formatting ────────────────────────────────────

/** Format a value as plain text (no ANSI colors). */
export function formatValuePlain(val: unknown): string {
  if (val === undefined || val === null) return '(none)'
  if (typeof val === 'boolean') return String(val)
  if (typeof val === 'string') {
    if (val.length > 120) return val.slice(0, 117) + '...'
    return val
  }
  if (Array.isArray(val)) {
    if (val.length === 0) return '[]'
    if (typeof val[0] === 'string') return val.join(', ')
    return JSON.stringify(val, null, 2)
  }
  if (typeof val === 'object') return JSON.stringify(val, null, 2)
  return String(val)
}

/** Apply a chalk color function to every line of a string. */
function colorLines(text: string, colorFn: (s: string) => string): string {
  return text.split('\n').map(colorFn).join('\n')
}

// ── Prompt diff ───────────────────────────────────────────────

export function formatPromptDiff(
  oldPrompt: string | undefined,
  newPrompt: string | undefined
): string {
  const oldLines = (oldPrompt || '').split('\n')
  const newLines = (newPrompt || '').split('\n')
  const lines: string[] = []

  const oldSet = new Set(oldLines)
  const newSet = new Set(newLines)

  for (const line of oldLines) {
    if (!newSet.has(line)) {
      lines.push(chalk.red(`  - ${line}`))
    }
  }
  for (const line of newLines) {
    if (!oldSet.has(line)) {
      lines.push(chalk.green(`  + ${line}`))
    }
  }

  if (lines.length === 0) {
    lines.push(chalk.yellow('  (line order changed)'))
  }

  if (lines.length > 40) {
    const shown = lines.slice(0, 40)
    shown.push(chalk.dim(`  ... and ${lines.length - 40} more lines`))
    return shown.join('\n')
  }

  return lines.join('\n')
}

// ── Schema diff ───────────────────────────────────────────────

export function formatSchemaDiff(
  _field: string,
  oldSchema: Schema | undefined,
  newSchema: Schema | undefined
): string {
  const lines: string[] = []
  const oldProps = oldSchema?.properties || {}
  const newProps = newSchema?.properties || {}
  const oldRequired = new Set(oldSchema?.required || [])
  const newRequired = new Set(newSchema?.required || [])
  const allKeys = new Set([...Object.keys(oldProps), ...Object.keys(newProps)])

  for (const key of allKeys) {
    const inOld = key in oldProps
    const inNew = key in newProps
    if (!inOld && inNew) {
      const reqMark = newRequired.has(key) ? '' : '?'
      lines.push(chalk.green(`  + ${key}${reqMark}: ${newProps[key].type || 'any'}`))
    } else if (inOld && !inNew) {
      const reqMark = oldRequired.has(key) ? '' : '?'
      lines.push(chalk.red(`  - ${key}${reqMark}: ${oldProps[key].type || 'any'}`))
    } else if (inOld && inNew) {
      const oldType = oldProps[key].type || 'any'
      const newType = newProps[key].type || 'any'
      const wasReq = oldRequired.has(key)
      const isReq = newRequired.has(key)
      if (oldType !== newType || wasReq !== isReq) {
        const oldMark = wasReq ? '' : '?'
        const newMark = isReq ? '' : '?'
        lines.push(chalk.red(`  - ${key}${oldMark}: ${oldType}`))
        lines.push(chalk.green(`  + ${key}${newMark}: ${newType}`))
      }
    }
  }

  return lines.join('\n')
}

// ── String array diff ─────────────────────────────────────────

/** Item-level diff for simple string arrays (tags, providers, secrets, skills). */
export function formatStringArrayDiff(
  oldArr: string[],
  newArr: string[]
): string {
  const oldSet = new Set(oldArr)
  const newSet = new Set(newArr)
  const lines: string[] = []

  for (const item of oldArr) {
    if (!newSet.has(item)) {
      lines.push(chalk.red(`  - ${item}`))
    }
  }
  for (const item of newArr) {
    if (!oldSet.has(item)) {
      lines.push(chalk.green(`  + ${item}`))
    }
  }
  // Show items present in both (unchanged) for context
  for (const item of newArr) {
    if (oldSet.has(item)) {
      lines.push(chalk.dim(`    ${item}`))
    }
  }

  return lines.join('\n')
}

// ── Dependency diff ───────────────────────────────────────────

/** Item-level diff for ManifestDependency arrays. Shows version changes. */
export function formatDependencyDiff(
  oldDeps: ManifestDependency[],
  newDeps: ManifestDependency[]
): string {
  const oldMap = new Map(oldDeps.map(d => [d.id, d.version]))
  const newMap = new Map(newDeps.map(d => [d.id, d.version]))
  const allIds = new Set([...oldMap.keys(), ...newMap.keys()])
  const lines: string[] = []

  for (const id of allIds) {
    const oldV = oldMap.get(id)
    const newV = newMap.get(id)
    if (oldV && !newV) {
      lines.push(chalk.red(`  - ${id}@${oldV}`))
    } else if (!oldV && newV) {
      lines.push(chalk.green(`  + ${id}@${newV}`))
    } else if (oldV && newV && oldV !== newV) {
      lines.push(`  ${id}: ${chalk.red(oldV)} ${chalk.yellow('\u2192')} ${chalk.green(newV)}`)
    } else {
      lines.push(chalk.dim(`    ${id}@${oldV}`))
    }
  }

  return lines.join('\n')
}

// ── Custom tool diff ──────────────────────────────────────────

/** Item-level diff for CustomTool arrays. */
export function formatCustomToolDiff(
  oldTools: CustomTool[],
  newTools: CustomTool[]
): string {
  const oldMap = new Map(oldTools.map(t => [t.name, t]))
  const newMap = new Map(newTools.map(t => [t.name, t]))
  const allNames = new Set([...oldMap.keys(), ...newMap.keys()])
  const lines: string[] = []

  for (const name of allNames) {
    const oldT = oldMap.get(name)
    const newT = newMap.get(name)
    if (oldT && !newT) {
      lines.push(chalk.red(`  - ${name}`))
    } else if (!oldT && newT) {
      lines.push(chalk.green(`  + ${name}`))
      if (newT.description) lines.push(chalk.green(`      ${newT.description}`))
    } else if (oldT && newT && JSON.stringify(oldT) !== JSON.stringify(newT)) {
      lines.push(`  ~ ${chalk.bold(name)}`)
      if (oldT.description !== newT.description) {
        lines.push(`    desc: ${chalk.red(oldT.description || '(none)')} ${chalk.yellow('\u2192')} ${chalk.green(newT.description || '(none)')}`)
      }
      if (oldT.command !== newT.command) {
        lines.push(`    cmd:  ${chalk.red(oldT.command || '(none)')} ${chalk.yellow('\u2192')} ${chalk.green(newT.command || '(none)')}`)
      }
    } else {
      lines.push(chalk.dim(`    ${name}`))
    }
  }

  return lines.join('\n')
}

// ── Models (key-value object) diff ────────────────────────────

/** Key-level diff for Record<string, string> objects like default_models. */
export function formatModelsDiff(
  oldObj: Record<string, string> | undefined,
  newObj: Record<string, string> | undefined
): string {
  const old = oldObj || {}
  const nw = newObj || {}
  const allKeys = new Set([...Object.keys(old), ...Object.keys(nw)])
  const lines: string[] = []

  for (const key of allKeys) {
    if (key in old && !(key in nw)) {
      lines.push(chalk.red(`  - ${key}: ${old[key]}`))
    } else if (!(key in old) && key in nw) {
      lines.push(chalk.green(`  + ${key}: ${nw[key]}`))
    } else if (old[key] !== nw[key]) {
      lines.push(`  ${key}: ${chalk.red(old[key])} ${chalk.yellow('\u2192')} ${chalk.green(nw[key])}`)
    }
  }

  return lines.join('\n')
}

// ── Main printer ──────────────────────────────────────────────

/** Render a colorized diff to stdout. */
export function printDiffs(
  refA: string,
  refB: string,
  diffs: FieldDiff[]
): void {
  process.stdout.write('\n')
  process.stdout.write(chalk.bold(`${refA}  ${chalk.yellow('\u2192')}  ${refB}`) + '\n')
  process.stdout.write(chalk.dim('\u2500'.repeat(50)) + '\n\n')

  if (diffs.length === 0) {
    process.stdout.write(chalk.green('No differences found.') + '\n')
    return
  }

  process.stdout.write(
    `${chalk.bold(String(diffs.length))} ${diffs.length === 1 ? 'change' : 'changes'}:\n\n`
  )

  // Fields that get item-level diff when changed
  const stringArrayFields = new Set([
    'supported_providers', 'tags', 'default_skills', 'required_secrets',
  ])

  for (const diff of diffs) {
    // ── Schema fields: property-level diff ──
    if (
      (diff.field === 'input_schema' || diff.field === 'output_schema') &&
      diff.kind === 'changed'
    ) {
      process.stdout.write(chalk.cyan(`~ ${diff.field}:`) + '\n')
      process.stdout.write(
        formatSchemaDiff(diff.field, diff.old as Schema, diff.new as Schema) + '\n\n'
      )
      continue
    }

    // ── Prompt: line-level diff ──
    if (diff.field === 'prompt' && diff.kind === 'changed') {
      process.stdout.write(chalk.cyan(`~ prompt:`) + '\n')
      process.stdout.write(
        formatPromptDiff(diff.old as string, diff.new as string) + '\n\n'
      )
      continue
    }

    // ── String arrays: item-level diff ──
    if (stringArrayFields.has(diff.field) && diff.kind === 'changed') {
      process.stdout.write(chalk.cyan(`~ ${diff.field}:`) + '\n')
      process.stdout.write(
        formatStringArrayDiff(
          diff.old as string[],
          diff.new as string[]
        ) + '\n\n'
      )
      continue
    }

    // ── Dependencies: item-level diff ──
    if (diff.field === 'dependencies' && diff.kind === 'changed') {
      process.stdout.write(chalk.cyan(`~ dependencies:`) + '\n')
      process.stdout.write(
        formatDependencyDiff(
          diff.old as ManifestDependency[],
          diff.new as ManifestDependency[]
        ) + '\n\n'
      )
      continue
    }

    // ── Custom tools: item-level diff ──
    if (diff.field === 'custom_tools' && diff.kind === 'changed') {
      process.stdout.write(chalk.cyan(`~ custom_tools:`) + '\n')
      process.stdout.write(
        formatCustomToolDiff(
          diff.old as CustomTool[],
          diff.new as CustomTool[]
        ) + '\n\n'
      )
      continue
    }

    // ── Default models: key-level diff ──
    if (diff.field === 'default_models' && diff.kind === 'changed') {
      process.stdout.write(chalk.cyan(`~ default_models:`) + '\n')
      process.stdout.write(
        formatModelsDiff(
          diff.old as Record<string, string>,
          diff.new as Record<string, string>
        ) + '\n\n'
      )
      continue
    }

    // ── Standard scalar fields ──
    if (diff.kind === 'added') {
      const formatted = formatValuePlain(diff.new)
      if (formatted.includes('\n')) {
        process.stdout.write(chalk.green(`+ ${diff.field}:`) + '\n')
        process.stdout.write(colorLines(formatted, l => chalk.green(`  ${l}`)) + '\n\n')
      } else {
        process.stdout.write(chalk.green(`+ ${diff.field}: ${formatted}`) + '\n')
      }
    } else if (diff.kind === 'removed') {
      const formatted = formatValuePlain(diff.old)
      if (formatted.includes('\n')) {
        process.stdout.write(chalk.red(`- ${diff.field}:`) + '\n')
        process.stdout.write(colorLines(formatted, l => chalk.red(`  ${l}`)) + '\n\n')
      } else {
        process.stdout.write(chalk.red(`- ${diff.field}: ${formatted}`) + '\n')
      }
    } else {
      // changed — old in red, new in green
      const oldFmt = formatValuePlain(diff.old)
      const newFmt = formatValuePlain(diff.new)
      if (!oldFmt.includes('\n') && !newFmt.includes('\n')) {
        process.stdout.write(
          `${chalk.cyan('~')} ${chalk.bold(diff.field)}: ${chalk.red(oldFmt)} ${chalk.yellow('\u2192')} ${chalk.green(newFmt)}\n`
        )
      } else {
        process.stdout.write(chalk.cyan(`~ ${diff.field}:`) + '\n')
        process.stdout.write(colorLines(oldFmt, l => chalk.red(`  - ${l}`)) + '\n')
        process.stdout.write(colorLines(newFmt, l => chalk.green(`  + ${l}`)) + '\n\n')
      }
    }
  }
}
