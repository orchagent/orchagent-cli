/**
 * Agent project validation engine.
 *
 * Runs all pre-publish checks on an agent project directory without
 * actually publishing. Used by `orch validate` and reusable by other
 * commands that need project validation.
 */

import fs from 'fs/promises'
import path from 'path'
import yaml from 'yaml'
import type { AgentManifest } from '../types'
import {
  extractTemplateVariables,
  scanUndeclaredEnvVars,
  scanReservedPort,
  detectSdkCompatible,
} from '../commands/publish'
import { detectEntrypoint, previewBundle } from './bundle'
import { validateModelIds } from './llm'
import { rejectControlChars } from './sanitize'

// ── Types ──────────────────────────────────────────────────────────────

export type CanonicalType = 'prompt' | 'tool' | 'agent' | 'skill'
export type ExecutionEngine = 'direct_llm' | 'managed_loop' | 'code_runtime'

export interface ValidationIssue {
  level: 'error' | 'warning' | 'info'
  message: string
  file?: string
}

export interface ValidationMetadata {
  isSkill: boolean
  agentName?: string
  agentType?: CanonicalType
  executionEngine?: ExecutionEngine
  runMode?: 'on_demand' | 'always_on'
  callable?: boolean
  hasPrompt: boolean
  hasSchema: boolean
  templateVariables: string[]
  bundleEntrypoint?: string | null
  sdkCompatible: boolean
  supportedProviders: string[]
  customToolCount: number
  maxTurns?: number
  requiredSecrets: string[]
  bundleSizeBytes?: number
  bundleFileCount?: number
  manifest?: AgentManifest
}

export interface ValidationResult {
  valid: boolean
  issues: ValidationIssue[]
  metadata: ValidationMetadata
}

export interface ValidateOptions {
  /** External URL (for code-based agents) */
  url?: string
  /** Validate with Dockerfile */
  docker?: boolean
}

// ── Helpers ────────────────────────────────────────────────────────────

export function canonicalizeManifestType(
  typeValue: string | undefined
): { canonicalType: CanonicalType; rawType: string; valid: boolean } {
  const rawType = (typeValue || 'agent').trim().toLowerCase()
  if (['prompt', 'tool', 'agent', 'skill'].includes(rawType)) {
    return { canonicalType: rawType as CanonicalType, rawType, valid: true }
  }
  if (rawType === 'agentic') return { canonicalType: 'agent', rawType, valid: true }
  if (rawType === 'code') return { canonicalType: 'tool', rawType, valid: true }
  return { canonicalType: 'agent', rawType, valid: false }
}

export function normalizeRunMode(
  runMode: string | undefined
): { value: 'on_demand' | 'always_on'; valid: boolean } {
  const normalized = (runMode || 'on_demand').trim().toLowerCase()
  if (normalized === 'on_demand' || normalized === 'always_on') {
    return { value: normalized, valid: true }
  }
  return { value: 'on_demand', valid: false }
}

export function inferExecutionEngine(
  manifest: AgentManifest,
  rawType: string
): { engine: ExecutionEngine | null; conflict: boolean } {
  const runtimeCommand = manifest.runtime?.command?.trim()
  const hasLoop = Boolean(manifest.loop && Object.keys(manifest.loop).length > 0)
  if (runtimeCommand && hasLoop) return { engine: null, conflict: true }
  if (runtimeCommand) return { engine: 'code_runtime', conflict: false }
  if (hasLoop) return { engine: 'managed_loop', conflict: false }
  if (rawType === 'tool' || rawType === 'code') return { engine: 'code_runtime', conflict: false }
  if (rawType === 'agentic' || rawType === 'agent') return { engine: 'managed_loop', conflict: false }
  return { engine: 'direct_llm', conflict: false }
}

function validateNameFormat(name: string, issues: ValidationIssue[], file: string): void {
  // DX-29: reject control chars in agent names
  try {
    rejectControlChars(name, 'agent name')
  } catch (err) {
    issues.push({ level: 'error', message: (err as Error).message, file })
    return // no point checking format if control chars present
  }

  const nameRegex = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/
  if (name.length < 2 || name.length > 50) {
    issues.push({ level: 'error', message: 'Agent name must be 2-50 characters', file })
  }
  if (name !== name.toLowerCase()) {
    issues.push({ level: 'error', message: 'Agent name must be lowercase', file })
  }
  if (name.length > 1 && !nameRegex.test(name)) {
    issues.push({
      level: 'error',
      message: 'Agent name must contain only lowercase letters, numbers, and hyphens, and must start/end with a letter or number',
      file,
    })
  }
  if (name.includes('--')) {
    issues.push({ level: 'error', message: 'Agent name must not contain consecutive hyphens', file })
  }
}

// ── Skill validation ───────────────────────────────────────────────────

function validateSkill(
  content: string,
  issues: ValidationIssue[],
  metadata: ValidationMetadata
): void {
  metadata.isSkill = true
  metadata.agentType = 'skill'

  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) {
    issues.push({
      level: 'error',
      message: 'SKILL.md must start with YAML frontmatter (--- block)',
      file: 'SKILL.md',
    })
    return
  }

  let frontmatter: Record<string, unknown>
  try {
    frontmatter = yaml.parse(match[1])
    if (!frontmatter || typeof frontmatter !== 'object') {
      issues.push({ level: 'error', message: 'SKILL.md frontmatter is empty or invalid YAML', file: 'SKILL.md' })
      return
    }
  } catch (err) {
    issues.push({ level: 'error', message: `SKILL.md frontmatter has invalid YAML: ${(err as Error).message}`, file: 'SKILL.md' })
    return
  }

  const body = match[2].trim()

  if (!frontmatter.name) {
    issues.push({ level: 'error', message: 'SKILL.md frontmatter must have a "name" field', file: 'SKILL.md' })
  } else {
    metadata.agentName = String(frontmatter.name)
    validateNameFormat(String(frontmatter.name), issues, 'SKILL.md')
  }

  if (!frontmatter.description) {
    issues.push({ level: 'error', message: 'SKILL.md frontmatter must have a "description" field', file: 'SKILL.md' })
  }

  if (!body) {
    issues.push({ level: 'error', message: 'SKILL.md has no content after frontmatter', file: 'SKILL.md' })
  }
}

// ── Agent validation ───────────────────────────────────────────────────

async function validateManifest(
  projectDir: string,
  manifest: AgentManifest,
  issues: ValidationIssue[],
  metadata: ValidationMetadata,
  options: ValidateOptions
): Promise<void> {
  metadata.manifest = manifest

  // ── Name ──
  if (!manifest.name) {
    issues.push({ level: 'error', message: 'orchagent.json must have a "name" field', file: 'orchagent.json' })
  } else {
    metadata.agentName = manifest.name
    validateNameFormat(manifest.name, issues, 'orchagent.json')
  }

  // ── Type ──
  const { canonicalType, rawType, valid: typeValid } = canonicalizeManifestType(manifest.type)
  if (!typeValid) {
    issues.push({
      level: 'error',
      message: `Invalid type '${manifest.type}'. Use 'prompt', 'tool', 'agent', or 'skill' (legacy: agentic, code).`,
      file: 'orchagent.json',
    })
  }
  metadata.agentType = canonicalType

  if (canonicalType === 'skill') {
    issues.push({
      level: 'error',
      message: `Skills use SKILL.md format. Run \`orch skill create ${manifest.name || '<name>'}\` to set up the correct structure.`,
      file: 'orchagent.json',
    })
    return
  }

  // ── Run mode ──
  const { value: runMode, valid: runModeValid } = normalizeRunMode(manifest.run_mode)
  if (!runModeValid) {
    issues.push({ level: 'error', message: "run_mode must be 'on_demand' or 'always_on'", file: 'orchagent.json' })
  }
  metadata.runMode = runMode

  // ── Execution engine ──
  const { engine: executionEngine, conflict } = inferExecutionEngine(manifest, rawType)
  if (conflict) {
    issues.push({ level: 'error', message: 'runtime.command and loop cannot both be set', file: 'orchagent.json' })
  }
  metadata.executionEngine = executionEngine || undefined
  metadata.callable = manifest.callable !== undefined ? Boolean(manifest.callable) : true

  // ── Timeout ──
  if (manifest.timeout_seconds !== undefined) {
    if (!Number.isInteger(manifest.timeout_seconds) || manifest.timeout_seconds <= 0) {
      issues.push({ level: 'error', message: 'timeout_seconds must be a positive integer', file: 'orchagent.json' })
    }
  }

  // ── Always-on + direct_llm incompatibility ──
  if (runMode === 'always_on' && executionEngine === 'direct_llm') {
    issues.push({ level: 'error', message: 'run_mode=always_on requires runtime.command or loop configuration', file: 'orchagent.json' })
  }

  // ── Deprecated/misused fields ──
  if (manifest.prompt) {
    issues.push({ level: 'warning', message: '"prompt" field in orchagent.json is ignored. Use prompt.md file instead.', file: 'orchagent.json' })
  }
  if ((manifest as Record<string, unknown>).model && !manifest.default_models) {
    issues.push({
      level: 'warning',
      message: '"model" field is not recognized. Use "default_models": {"anthropic": "...", "openai": "..."}',
      file: 'orchagent.json',
    })
  }

  // ── Model ID validation (DX-17) ──
  if (manifest.default_models && typeof manifest.default_models === 'object') {
    const modelWarnings = validateModelIds(manifest.default_models as Record<string, string>)
    for (const w of modelWarnings) {
      issues.push({ level: 'warning', message: w.message, file: 'orchagent.json' })
    }
  }

  // ── Misplaced manifest fields ──
  const manifestFields = ['manifest_version', 'dependencies', 'max_hops', 'timeout_ms', 'per_call_downstream_cap']
  const misplacedFields = manifestFields.filter(f => f in manifest && !manifest.manifest)
  if (misplacedFields.length > 0) {
    issues.push({
      level: 'error',
      message: `Found manifest fields (${misplacedFields.join(', ')}) at top level. These must be nested under a "manifest" key.`,
      file: 'orchagent.json',
    })
  }

  // ── Prompt file ──
  if (executionEngine === 'direct_llm' || executionEngine === 'managed_loop') {
    await validatePrompt(projectDir, manifest, executionEngine, issues, metadata)
  }

  // ── Managed loop ──
  if (executionEngine === 'managed_loop') {
    validateManagedLoop(manifest, issues, metadata)
    metadata.supportedProviders = manifest.supported_providers || ['anthropic']
  } else {
    metadata.supportedProviders = manifest.supported_providers || ['any']
  }

  // ── Schemas ──
  await validateSchemas(projectDir, manifest, executionEngine, issues, metadata)

  // ── Code runtime ──
  if (executionEngine === 'code_runtime') {
    await validateCodeRuntime(projectDir, manifest, options, issues, metadata)
  }

  // ── Docker flag ──
  if (options.docker && executionEngine !== 'code_runtime') {
    issues.push({ level: 'error', message: '--docker is only supported for code runtime agents', file: 'orchagent.json' })
  }
  if (options.docker) {
    try {
      await fs.access(path.join(projectDir, 'Dockerfile'))
    } catch {
      issues.push({ level: 'error', message: '--docker flag specified but no Dockerfile found', file: 'Dockerfile' })
    }
  }

  // ── Required secrets ──
  if ((canonicalType === 'tool' || canonicalType === 'agent') && manifest.required_secrets === undefined) {
    metadata.requiredSecrets = []
    issues.push({ level: 'info', message: 'No required_secrets declared — defaulting to [] (no secrets needed)', file: 'orchagent.json' })
  } else {
    metadata.requiredSecrets = manifest.required_secrets || []
  }
  if (manifest.required_secrets?.includes('ORCHAGENT_SERVICE_KEY')) {
    issues.push({
      level: 'warning',
      message: 'ORCHAGENT_SERVICE_KEY in required_secrets is auto-injected by the gateway. Remove it to avoid overriding the auto-injected key.',
      file: 'orchagent.json',
    })
  }

  // ── Env var scanning (code runtime) ──
  if (executionEngine === 'code_runtime') {
    try {
      const undeclared = await scanUndeclaredEnvVars(projectDir, manifest.required_secrets || [])
      if (undeclared.length > 0) {
        issues.push({
          level: 'warning',
          message: `Code references undeclared environment variables: ${undeclared.join(', ')}. Add them to required_secrets if needed.`,
        })
      }
    } catch { /* non-critical */ }
  }

  // ── Reserved port scanning (always-on code runtime) ──
  if (runMode === 'always_on' && executionEngine === 'code_runtime') {
    try {
      if (await scanReservedPort(projectDir)) {
        issues.push({
          level: 'warning',
          message: 'Code appears to bind to port 8080, which is reserved by the platform health server. Use a different port.',
        })
      }
    } catch { /* non-critical */ }
  }

  // ── Bundle size estimation (code runtime with local code) ──
  if (executionEngine === 'code_runtime' && metadata.bundleEntrypoint && !options.url) {
    try {
      const preview = await previewBundle(projectDir, {
        entrypoint: metadata.bundleEntrypoint,
        exclude: manifest.bundle?.exclude,
        include: manifest.bundle?.include,
      })
      metadata.bundleSizeBytes = preview.totalSizeBytes
      metadata.bundleFileCount = preview.fileCount
      const maxSize = 50 * 1024 * 1024 // 50MB
      if (preview.totalSizeBytes > maxSize) {
        issues.push({
          level: 'error',
          message: `Estimated bundle size (${(preview.totalSizeBytes / 1024 / 1024).toFixed(1)}MB) exceeds 50MB limit. Add exclusions to bundle.exclude in orchagent.json.`,
        })
      }
    } catch { /* non-critical — bundle preview failed */ }
  }
}

async function validatePrompt(
  projectDir: string,
  manifest: AgentManifest,
  executionEngine: ExecutionEngine,
  issues: ValidationIssue[],
  metadata: ValidationMetadata
): Promise<void> {
  const promptPath = path.join(projectDir, 'prompt.md')
  try {
    const prompt = await fs.readFile(promptPath, 'utf-8')
    metadata.hasPrompt = true

    if (prompt.trim().length === 0) {
      issues.push({ level: 'warning', message: 'prompt.md is empty', file: 'prompt.md' })
    }

    // Extract template variables for schema matching
    const templateVars = extractTemplateVariables(prompt)
    metadata.templateVariables = Array.isArray(templateVars) ? templateVars : []
  } catch (err) {
    metadata.templateVariables = metadata.templateVariables || []
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      issues.push({
        level: 'error',
        message: 'No prompt.md found. Create a prompt.md file with your prompt template.',
        file: 'prompt.md',
      })
    }
  }
}

function validateManagedLoop(
  manifest: AgentManifest,
  issues: ValidationIssue[],
  metadata: ValidationMetadata
): void {
  if (manifest.max_turns !== undefined) {
    if (typeof manifest.max_turns !== 'number' || manifest.max_turns < 1 || manifest.max_turns > 50) {
      issues.push({ level: 'error', message: 'max_turns must be a number between 1 and 50', file: 'orchagent.json' })
    }
  }

  // Merge loop config (same logic as publish.ts)
  const providedLoop =
    manifest.loop && typeof manifest.loop === 'object' ? { ...manifest.loop } : {}
  if (!('max_turns' in providedLoop) && manifest.max_turns !== undefined) {
    providedLoop.max_turns = manifest.max_turns
  }
  if (!('custom_tools' in providedLoop) && manifest.custom_tools?.length) {
    providedLoop.custom_tools = manifest.custom_tools
  }
  metadata.maxTurns = (providedLoop.max_turns as number) || manifest.max_turns || 25

  // Validate custom_tools
  const mergedTools = Array.isArray(providedLoop.custom_tools)
    ? (providedLoop.custom_tools as Array<{ name?: string; command?: string }>)
    : []
  metadata.customToolCount = mergedTools.length

  if (mergedTools.length > 0) {
    const reservedNames = new Set(['bash', 'read_file', 'write_file', 'list_files', 'submit_result'])
    const seenNames = new Set<string>()
    for (const tool of mergedTools) {
      if (!tool.name || !tool.command) {
        issues.push({
          level: 'error',
          message: `Invalid custom_tool: each tool must have 'name' and 'command' fields. Found: ${JSON.stringify(tool)}`,
          file: 'orchagent.json',
        })
      } else {
        if (reservedNames.has(tool.name)) {
          issues.push({
            level: 'error',
            message: `Custom tool '${tool.name}' conflicts with built-in tool name. Reserved: ${[...reservedNames].join(', ')}`,
            file: 'orchagent.json',
          })
        }
        if (seenNames.has(tool.name)) {
          issues.push({ level: 'error', message: `Duplicate custom tool name: '${tool.name}'`, file: 'orchagent.json' })
        }
        seenNames.add(tool.name)
      }
    }
  }
}

async function validateSchemas(
  projectDir: string,
  manifest: AgentManifest,
  executionEngine: ExecutionEngine | null,
  issues: ValidationIssue[],
  metadata: ValidationMetadata
): Promise<void> {
  const schemaPath = path.join(projectDir, 'schema.json')
  let schemaFromFile = false

  try {
    const raw = await fs.readFile(schemaPath, 'utf-8')
    JSON.parse(raw) // validate JSON
    schemaFromFile = true
    metadata.hasSchema = true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      issues.push({ level: 'error', message: `Failed to parse schema.json: ${(err as Error).message}`, file: 'schema.json' })
    }
  }

  // Warn about inline schemas when schema.json exists
  if ((manifest.input_schema || manifest.output_schema) && schemaFromFile) {
    issues.push({
      level: 'warning',
      message: 'Inline schemas in orchagent.json are ignored (schema.json takes priority).',
      file: 'orchagent.json',
    })
  }

  // Template variable / schema cross-check
  const tvars = metadata.templateVariables || []
  if (
    tvars.length > 0 &&
    (executionEngine === 'direct_llm' || executionEngine === 'managed_loop')
  ) {
    if (!schemaFromFile) {
      issues.push({
        level: 'info',
        message: `Input schema will be auto-derived from template variables: ${tvars.join(', ')}`,
        file: 'prompt.md',
      })
    } else {
      // Read schema.json to cross-check
      try {
        const raw = await fs.readFile(schemaPath, 'utf-8')
        const schemas = JSON.parse(raw)
        const inputSchema = schemas.input
        if (inputSchema && typeof inputSchema === 'object' && 'properties' in inputSchema) {
          const schemaProps = Object.keys((inputSchema as Record<string, unknown>).properties as Record<string, unknown> || {})
          const missing = tvars.filter(v => !schemaProps.includes(v))
          const extra = schemaProps.filter(p => !tvars.includes(p))
          if (missing.length > 0 || extra.length > 0) {
            const parts: string[] = []
            if (missing.length > 0) parts.push(`template uses {{${missing.join('}}, {{')}}} but schema.json doesn't define them`)
            if (extra.length > 0) parts.push(`schema.json defines ${extra.join(', ')} but template doesn't use them`)
            issues.push({ level: 'warning', message: `Schema mismatch: ${parts.join('; ')}`, file: 'schema.json' })
          }
        }
      } catch { /* already reported above */ }
    }
  }
}

async function validateCodeRuntime(
  projectDir: string,
  manifest: AgentManifest,
  options: ValidateOptions,
  issues: ValidationIssue[],
  metadata: ValidationMetadata
): Promise<void> {
  const entrypoint = manifest.entrypoint || (await detectEntrypoint(projectDir)) || null
  metadata.bundleEntrypoint = entrypoint

  if (!options.url && !entrypoint) {
    issues.push({
      level: 'error',
      message: 'Tool requires either --url or an entry point file (main.py, app.py, index.js, etc.)',
      file: 'orchagent.json',
    })
  }

  // SDK detection
  metadata.sdkCompatible = await detectSdkCompatible(projectDir)
  if (metadata.sdkCompatible) {
    issues.push({ level: 'info', message: 'orchagent-sdk detected — agent will be marked as Local Ready' })
  }
}

// ── Main entry point ───────────────────────────────────────────────────

export async function validateAgentProject(
  projectDir: string,
  options: ValidateOptions = {}
): Promise<ValidationResult> {
  const issues: ValidationIssue[] = []
  const metadata: ValidationMetadata = {
    isSkill: false,
    hasPrompt: false,
    hasSchema: false,
    templateVariables: [],
    sdkCompatible: false,
    supportedProviders: [],
    customToolCount: 0,
    requiredSecrets: [],
  }

  // Check for SKILL.md first (takes priority, matching publish behavior)
  const skillMdPath = path.join(projectDir, 'SKILL.md')
  try {
    const content = await fs.readFile(skillMdPath, 'utf-8')
    validateSkill(content, issues, metadata)
    return {
      valid: issues.filter(i => i.level === 'error').length === 0,
      issues,
      metadata,
    }
  } catch {
    // No SKILL.md — continue to orchagent.json
  }

  // Read orchagent.json
  const manifestPath = path.join(projectDir, 'orchagent.json')
  let manifest: AgentManifest
  try {
    const raw = await fs.readFile(manifestPath, 'utf-8')
    manifest = JSON.parse(raw)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      issues.push({
        level: 'error',
        message: 'No orchagent.json or SKILL.md found. Run `orch init` first.',
      })
    } else {
      issues.push({
        level: 'error',
        message: `Failed to parse orchagent.json: ${(err as Error).message}`,
        file: 'orchagent.json',
      })
    }
    return { valid: false, issues, metadata }
  }

  await validateManifest(projectDir, manifest, issues, metadata, options)

  return {
    valid: issues.filter(i => i.level === 'error').length === 0,
    issues,
    metadata,
  }
}
