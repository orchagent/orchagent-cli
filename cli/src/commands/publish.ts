import { Command } from 'commander'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import yaml from 'yaml'
import chalk from 'chalk'

import { getResolvedConfig } from '../lib/config'
import { createAgent, getOrg, uploadCodeBundle, previewAgentVersion } from '../lib/api'
import { CliError, ExitCodes } from '../lib/errors'
import { ApiError } from '../lib/api'
import { track } from '../lib/analytics'
import { createCodeBundle, detectEntrypoint, validateBundle, previewBundle } from '../lib/bundle'
import type { AgentManifest } from '../types'

/**
 * Extract template placeholders from a prompt template.
 * Matches double-brace patterns like {{variable}}.
 * Returns unique variable names in order of first appearance.
 */
export function extractTemplateVariables(template: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  // Match double-brace template variables: two opening braces, word chars, two closing braces
  const pattern = /\{\{(\w+)\}\}/g
  let match
  while ((match = pattern.exec(template)) !== null) {
    const name = match[1]
    if (!seen.has(name)) {
      seen.add(name)
      result.push(name)
    }
  }
  return result
}

/**
 * Derive a JSON Schema input object from template variable names.
 * Each variable becomes a required string property.
 */
export function deriveInputSchema(variables: string[]): object {
  const properties: Record<string, { type: string; description: string }> = {}
  for (const name of variables) {
    properties[name] = {
      type: 'string',
      description: `Value for the ${name} template variable`,
    }
  }
  return {
    type: 'object',
    properties,
    required: [...variables],
  }
}

interface SkillFrontmatter {
  name: string
  description: string
  license?: string
  metadata?: { author?: string; version?: string }
}

/**
 * Check if orchagent-sdk is listed in requirements.txt or pyproject.toml
 */
async function detectSdkCompatible(agentDir: string): Promise<boolean> {
  // Check requirements.txt
  const requirementsPath = path.join(agentDir, 'requirements.txt')
  try {
    const content = await fs.readFile(requirementsPath, 'utf-8')
    // Match orchagent-sdk with or without version specifier (e.g., orchagent-sdk, orchagent-sdk>=0.1.0)
    if (/^orchagent-sdk\b/m.test(content)) {
      return true
    }
  } catch {
    // File doesn't exist, continue checking pyproject.toml
  }

  // Check pyproject.toml
  const pyprojectPath = path.join(agentDir, 'pyproject.toml')
  try {
    const content = await fs.readFile(pyprojectPath, 'utf-8')
    // Match orchagent-sdk in dependencies (various formats in TOML)
    // e.g., "orchagent-sdk", 'orchagent-sdk>=0.1.0', orchagent-sdk = ">=0.1.0"
    if (/["']?orchagent-sdk["']?\s*[=<>~!]?/m.test(content)) {
      return true
    }
  } catch {
    // File doesn't exist
  }

  return false
}

async function parseSkillMd(filePath: string): Promise<{
  frontmatter: SkillFrontmatter
  body: string
} | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!match) return null
    const frontmatter = yaml.parse(match[1]) as SkillFrontmatter
    const body = match[2].trim()
    if (!frontmatter.name || !frontmatter.description) return null
    return { frontmatter, body }
  } catch {
    return null
  }
}

/**
 * Binary file extensions to skip when collecting skill files (SC-05)
 */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp', '.tiff',
  '.pdf', '.zip', '.tar', '.gz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv',
  '.pyc', '.pyo', '.class', '.o', '.obj',
])

/**
 * Collect all text files in the skill directory for SC-05 multi-file support
 */
async function collectSkillFiles(
  skillDir: string,
  maxFiles = 20,
  maxTotalSize = 500_000
): Promise<{ path: string; content: string; size: number }[]> {
  const files: { path: string; content: string; size: number }[] = []
  let totalSize = 0

  async function walkDir(dir: string, relativePath = ''): Promise<void> {
    if (files.length >= maxFiles || totalSize >= maxTotalSize) return

    const entries = await fs.readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      if (files.length >= maxFiles || totalSize >= maxTotalSize) break

      const fullPath = path.join(dir, entry.name)
      const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name

      // Skip hidden files and common non-content directories
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') {
        continue
      }

      if (entry.isDirectory()) {
        await walkDir(fullPath, relPath)
      } else if (entry.isFile()) {
        // Skip binary files
        const ext = path.extname(entry.name).toLowerCase()
        if (BINARY_EXTENSIONS.has(ext)) continue

        try {
          const stat = await fs.stat(fullPath)
          if (totalSize + stat.size > maxTotalSize) continue

          const content = await fs.readFile(fullPath, 'utf-8')
          files.push({
            path: relPath,
            content,
            size: stat.size,
          })
          totalSize += stat.size
        } catch {
          // Skip files that can't be read (binary, permissions, etc.)
        }
      }
    }
  }

  await walkDir(skillDir)
  return files
}

export function registerPublishCommand(program: Command): void {
  program
    .command('publish')
    .description('Publish agent or skill from local files')
    .option('--url <url>', 'Agent URL (for code-based agents)')
    .option('--profile <name>', 'Use API key from named profile')
    .option('--dry-run', 'Show what would be published without making changes')
    .option('--skills <skills>', 'Default skills (comma-separated, e.g., org/skill@v1,org/other@v1)')
    .option('--skills-locked', 'Lock default skills (callers cannot override via headers)')
    .option('--docker', 'Include Dockerfile for custom environment (builds E2B template)')
    .option('--local-download', 'Allow users to download and run locally (default: server-only)')
    .action(async (options: { url?: string; profile?: string; dryRun?: boolean; skills?: string; skillsLocked?: boolean; docker?: boolean; localDownload?: boolean }) => {
      const skillsFromFlag = options.skills
        ? options.skills.split(',').map(s => s.trim()).filter(Boolean)
        : undefined
      const config = await getResolvedConfig({}, options.profile)
      const cwd = process.cwd()

      // Check for SKILL.md first (skills take precedence)
      const skillMdPath = path.join(cwd, 'SKILL.md')
      const skillData = await parseSkillMd(skillMdPath)

      if (skillData) {
        // Publish as a skill (server auto-assigns version)
        const org = await getOrg(config)

        // SC-05: Collect all files in the skill directory for multi-file support
        const skillFiles = await collectSkillFiles(cwd)
        const hasMultipleFiles = skillFiles.length > 1

        // Handle dry-run for skills
        if (options.dryRun) {
          const preview = await previewAgentVersion(config, skillData.frontmatter.name)
          const skillBodyBytes = Buffer.byteLength(skillData.body, 'utf-8')
          const totalFilesSize = skillFiles.reduce((sum, f) => sum + f.size, 0)
          const versionInfo = preview.existing_versions.length > 0
            ? `${preview.next_version} (new version, ${preview.existing_versions[preview.existing_versions.length - 1]} exists)`
            : `${preview.next_version} (first version)`

          process.stderr.write('\nDRY RUN - No changes will be made\n\n')
          process.stderr.write('Validating...\n')
          process.stderr.write(`  ✓ SKILL.md found and valid\n`)
          process.stderr.write(`  ✓ Skill prompt (${skillBodyBytes.toLocaleString()} bytes)\n`)
          if (hasMultipleFiles) {
            process.stderr.write(`  ✓ Skill files: ${skillFiles.length} files (${(totalFilesSize / 1024).toFixed(1)} KB)\n`)
          }
          process.stderr.write(`  ✓ Authentication valid (org: ${org.slug})\n`)
          process.stderr.write('\nSkill Preview:\n')
          process.stderr.write(`  Name:        ${skillData.frontmatter.name}\n`)
          process.stderr.write(`  Type:        skill\n`)
          process.stderr.write(`  Version:     ${versionInfo}\n`)
          process.stderr.write(`  Visibility:  private\n`)
          process.stderr.write(`  Providers:   any\n`)
          if (hasMultipleFiles) {
            process.stderr.write(`  Files:       ${skillFiles.length} files\n`)
            for (const f of skillFiles.slice(0, 5)) {
              process.stderr.write(`               - ${f.path}\n`)
            }
            if (skillFiles.length > 5) {
              process.stderr.write(`               ... and ${skillFiles.length - 5} more\n`)
            }
          }
          process.stderr.write(`\nWould publish: ${preview.org_slug}/${skillData.frontmatter.name}@${preview.next_version}\n`)
          process.stderr.write(`API endpoint: POST ${config.apiUrl}/${preview.org_slug}/${skillData.frontmatter.name}/${preview.next_version}/run\n\n`)
          process.stderr.write('No changes made (dry run)\n')
          return
        }

        try {
          const skillResult = await createAgent(config, {
            name: skillData.frontmatter.name,
            type: 'skill',
            description: skillData.frontmatter.description,
            prompt: skillData.body,
            is_public: false,
            supported_providers: ['any'],
            default_skills: skillsFromFlag,
            skills_locked: options.skillsLocked || undefined,
            // SC-05: Include all skill files for UI preview
            skill_files: hasMultipleFiles ? skillFiles : undefined,
            allow_local_download: options.localDownload || false,
          })
          const skillVersion = skillResult.agent?.version || 'v1'
          const skillAgentId = skillResult.agent?.id

          await track('cli_publish', { agent_type: 'skill', multi_file: hasMultipleFiles })
          process.stdout.write(`\nPublished skill: ${org.slug}/${skillData.frontmatter.name}@${skillVersion}\n`)
          if (hasMultipleFiles) {
            process.stdout.write(`Files: ${skillFiles.length} files included\n`)
          }
          process.stdout.write(`Visibility: private\n`)

          process.stdout.write(`\nView analytics and usage: https://orchagent.io/dashboard\n`)
        } catch (err) {
          throw err
        }
        return
      }

      // Read manifest
      const manifestPath = path.join(cwd, 'orchagent.json')
      let manifest: AgentManifest
      try {
        const raw = await fs.readFile(manifestPath, 'utf-8')
        manifest = JSON.parse(raw)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new CliError('No orchagent.json found. Run `orchagent init` first.')
        }
        throw new CliError(`Failed to read orchagent.json: ${err}`)
      }

      // Validate manifest
      if (!manifest.name) {
        throw new CliError('orchagent.json must have name')
      }

      // Warn about deprecated fields that are ignored
      if (manifest.prompt) {
        process.stderr.write(chalk.yellow('Warning: "prompt" field in orchagent.json is ignored. Use prompt.md file instead.\n'))
      }
      if (manifest.input_schema) {
        process.stderr.write(chalk.yellow('Warning: "input_schema" field in orchagent.json is ignored. Use schema.json file instead.\n'))
      }
      if (manifest.output_schema) {
        process.stderr.write(chalk.yellow('Warning: "output_schema" field in orchagent.json is ignored. Use schema.json file instead.\n'))
      }

      // Check for misplaced manifest fields at top level (common user error)
      const manifestFields = ['manifest_version', 'dependencies', 'max_hops', 'timeout_ms', 'per_call_downstream_cap']
      const misplacedFields = manifestFields.filter(f => f in manifest && !manifest.manifest)
      if (misplacedFields.length > 0) {
        throw new CliError(
          `Found manifest fields (${misplacedFields.join(', ')}) at top level of orchagent.json.\n` +
          `These must be nested under a "manifest" key. Example:\n\n` +
          `  {\n` +
          `    "name": "${manifest.name}",\n` +
          `    "type": "${manifest.type || 'tool'}",\n` +
          `    "manifest": {\n` +
          `      "manifest_version": 1,\n` +
          `      "dependencies": [...],\n` +
          `      "max_hops": 2,\n` +
          `      "timeout_ms": 60000,\n` +
          `      "per_call_downstream_cap": 50\n` +
          `    }\n` +
          `  }\n\n` +
          `See docs/manifest.md for details.`
        )
      }

      // Read prompt (for prompt-based, agent, and skill agents)
      let prompt: string | undefined
      if (manifest.type === 'prompt' || manifest.type === 'skill' || manifest.type === 'agent') {
        const promptPath = path.join(cwd, 'prompt.md')
        try {
          prompt = await fs.readFile(promptPath, 'utf-8')
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            const agentTypeName = manifest.type === 'skill' ? 'skill' : manifest.type === 'agent' ? 'agent' : 'prompt-based agent'
            throw new CliError(
              `No prompt.md found for ${agentTypeName}.\n\n` +
              'Create a prompt.md file in the current directory with your prompt template.\n' +
              'See: https://orchagent.io/docs/publishing'
            )
          }
          throw err
        }
      }

      // For agent type, validate custom_tools and build manifest
      if (manifest.type === 'agent') {
        // Validate custom_tools format
        if (manifest.custom_tools) {
          const reservedNames = new Set(['bash', 'read_file', 'write_file', 'list_files', 'submit_result'])
          const seenNames = new Set<string>()
          for (const tool of manifest.custom_tools) {
            if (!tool.name || !tool.command) {
              throw new CliError(
                `Invalid custom_tool: each tool must have 'name' and 'command' fields.\n` +
                `Found: ${JSON.stringify(tool)}`
              )
            }
            if (reservedNames.has(tool.name)) {
              throw new CliError(
                `Custom tool '${tool.name}' conflicts with a built-in tool name.\n` +
                `Reserved names: ${[...reservedNames].join(', ')}`
              )
            }
            if (seenNames.has(tool.name)) {
              throw new CliError(`Duplicate custom tool name: '${tool.name}'`)
            }
            seenNames.add(tool.name)
          }
        }

        // Validate max_turns
        if (manifest.max_turns !== undefined) {
          if (typeof manifest.max_turns !== 'number' || manifest.max_turns < 1 || manifest.max_turns > 50) {
            throw new CliError('max_turns must be a number between 1 and 50')
          }
        }

        // Store agent config in manifest field
        const agentManifest: Record<string, unknown> = {
          ...(manifest.manifest || {}),
        }
        if (manifest.custom_tools) {
          agentManifest.custom_tools = manifest.custom_tools
        }
        if (manifest.max_turns) {
          agentManifest.max_turns = manifest.max_turns
        }
        manifest.manifest = agentManifest as any

        // Agent type defaults to anthropic provider
        if (!manifest.supported_providers) {
          manifest.supported_providers = ['anthropic']
        }
      }

      // Read schemas
      let inputSchema: object | undefined
      let outputSchema: object | undefined
      let schemaFromFile = false
      const schemaPath = path.join(cwd, 'schema.json')
      try {
        const raw = await fs.readFile(schemaPath, 'utf-8')
        const schemas = JSON.parse(raw)
        inputSchema = schemas.input
        outputSchema = schemas.output
        schemaFromFile = true
      } catch (err) {
        // Schema is optional
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new CliError(`Failed to read schema.json: ${err}`)
        }
      }

      // For prompt/skill agents, derive input schema from template variables if needed
      // (Agent type uses schema.json directly — no template variable derivation)
      if (prompt && (manifest.type === 'prompt' || manifest.type === 'skill')) {
        const templateVars = extractTemplateVariables(prompt)
        if (templateVars.length > 0) {
          if (!schemaFromFile) {
            // No schema.json provided - auto-generate from template variables
            inputSchema = deriveInputSchema(templateVars)
          } else if (inputSchema && 'properties' in (inputSchema as any)) {
            // schema.json exists - check for mismatches with template variables
            const schemaProps = Object.keys((inputSchema as any).properties || {})
            const missing = templateVars.filter(v => !schemaProps.includes(v))
            const extra = schemaProps.filter(p => !templateVars.includes(p))
            if (missing.length > 0 || extra.length > 0) {
              const parts: string[] = []
              if (missing.length > 0) {
                parts.push(`template uses {{${missing.join('}}, {{')}}} but schema.json doesn't define ${missing.join(', ')}`)
              }
              if (extra.length > 0) {
                parts.push(`schema.json defines ${extra.join(', ')} but template doesn't use {{${extra.join('}}, {{')}}}`)
              }
              process.stderr.write(chalk.yellow(`Warning: Schema mismatch - ${parts.join('; ')}.\n`))
              process.stderr.write(chalk.yellow(`  Consider updating schema.json to match your prompt.md template variables.\n`))
            }
          }
        }
      }

      // For tool-based agents, either --url is required OR we bundle the code
      // For agent type, use internal placeholder (no user code, platform handles execution)
      let agentUrl = options.url
      let shouldUploadBundle = false

      if (manifest.type === 'agent') {
        // Agent type doesn't need a URL or code bundle
        agentUrl = agentUrl || 'https://agent.internal'
        // But they can include a Dockerfile for custom environments
        if (options.docker) {
          const dockerfilePath = path.join(cwd, 'Dockerfile')
          try {
            await fs.access(dockerfilePath)
            shouldUploadBundle = true
            process.stdout.write(`Including Dockerfile for custom environment\n`)
          } catch {
            throw new CliError('--docker flag specified but no Dockerfile found in project directory')
          }
        }
      } else if (manifest.type === 'tool' && !options.url) {
        // Check if this looks like a Python or JS project that can be bundled
        const entrypoint = manifest.entrypoint || await detectEntrypoint(cwd)
        if (entrypoint) {
          // This is a hosted tool - we'll bundle and upload
          shouldUploadBundle = true
          // Set a placeholder URL that tells the gateway to use sandbox execution
          agentUrl = 'https://tool.internal'
          process.stdout.write(`Detected tool project with entrypoint: ${entrypoint}\n`)
        } else {
          throw new CliError(
            'Tool requires either --url <url> or an entry point file (main.py, app.py, index.js, etc.)'
          )
        }
      }

      // Get org info
      const org = await getOrg(config)

      // Default to 'any' provider if not specified
      const supportedProviders = manifest.supported_providers || ['any']

      // Detect SDK compatibility for tool agents
      let sdkCompatible = false
      if (manifest.type === 'tool') {
        sdkCompatible = await detectSdkCompatible(cwd)
        if (sdkCompatible && !options.dryRun) {
          process.stdout.write(`SDK detected - agent will be marked as Local Ready\n`)
        }
      }

      // Handle dry-run for agents
      if (options.dryRun) {
        const preview = await previewAgentVersion(config, manifest.name)
        const versionInfo = preview.existing_versions.length > 0
          ? `${preview.next_version} (new version, ${preview.existing_versions[preview.existing_versions.length - 1]} exists)`
          : `${preview.next_version} (first version)`

        process.stderr.write('\nDRY RUN - No changes will be made\n\n')
        process.stderr.write('Validating...\n')
        process.stderr.write(`  ✓ orchagent.json found and valid\n`)

        if (manifest.type === 'prompt') {
          // Prompt agent validations
          const promptBytes = prompt ? Buffer.byteLength(prompt, 'utf-8') : 0
          process.stderr.write(`  ✓ prompt.md found (${promptBytes.toLocaleString()} bytes)\n`)
          if (schemaFromFile) {
            const schemaTypes = [inputSchema ? 'input' : null, outputSchema ? 'output' : null].filter(Boolean).join(' + ')
            process.stderr.write(`  ✓ schema.json found (${schemaTypes} schemas)\n`)
          } else if (inputSchema) {
            const vars = prompt ? extractTemplateVariables(prompt) : []
            process.stderr.write(`  ✓ Input schema derived from template variables: ${vars.join(', ')}\n`)
          }
        } else if (manifest.type === 'agent') {
          // Agent type validations
          const promptBytes = prompt ? Buffer.byteLength(prompt, 'utf-8') : 0
          process.stderr.write(`  ✓ prompt.md found (${promptBytes.toLocaleString()} bytes)\n`)
          if (schemaFromFile) {
            const schemaTypes = [inputSchema ? 'input' : null, outputSchema ? 'output' : null].filter(Boolean).join(' + ')
            process.stderr.write(`  ✓ schema.json found (${schemaTypes} schemas)\n`)
          }
          const customToolCount = manifest.custom_tools?.length || 0
          process.stderr.write(`  ✓ Custom tools: ${customToolCount}\n`)
          process.stderr.write(`  ✓ Max turns: ${manifest.max_turns || 25}\n`)
        } else if (manifest.type === 'tool') {
          // Tool agent validations
          const entrypoint = manifest.entrypoint || await detectEntrypoint(cwd)
          process.stderr.write(`  ✓ Entrypoint: ${entrypoint}\n`)
          if (sdkCompatible) {
            process.stderr.write(`  ✓ SDK detected (orchagent-sdk in requirements.txt)\n`)
          }
        }

        process.stderr.write(`  ✓ Authentication valid (org: ${org.slug})\n`)

        // For tools with bundles, show bundle preview
        if (shouldUploadBundle) {
          const bundlePreview = await previewBundle(cwd, {
            entrypoint: manifest.entrypoint,
            exclude: manifest.bundle?.exclude,
            include: manifest.bundle?.include,
          })
          process.stderr.write(`\nBundle Preview:\n`)
          process.stderr.write(`  Files:       ${bundlePreview.fileCount} files\n`)
          process.stderr.write(`  Size:        ${(bundlePreview.totalSizeBytes / 1024).toFixed(1)} KB\n`)
          process.stderr.write(`  Entrypoint:  ${bundlePreview.entrypoint}\n`)
        }

        process.stderr.write('\nAgent Preview:\n')
        process.stderr.write(`  Name:        ${manifest.name}\n`)
        process.stderr.write(`  Type:        ${manifest.type}${shouldUploadBundle ? ' (hosted)' : ''}\n`)
        process.stderr.write(`  Version:     ${versionInfo}\n`)
        process.stderr.write(`  Visibility:  private\n`)
        process.stderr.write(`  Providers:   ${supportedProviders.join(', ')}\n`)
        const effectiveSkills = skillsFromFlag || manifest.default_skills
        const effectiveLocked = manifest.skills_locked || options.skillsLocked
        if (effectiveLocked) {
          process.stderr.write(`  Skills:      ${effectiveSkills?.join(', ') || '(none)'} [LOCKED]\n`)
        } else if (effectiveSkills?.length) {
          process.stderr.write(`  Skills:      ${effectiveSkills.join(', ')}\n`)
        }

        process.stderr.write(`\nWould publish: ${preview.org_slug}/${manifest.name}@${preview.next_version}\n`)
        if (shouldUploadBundle) {
          const bundlePreview = await previewBundle(cwd, {
            entrypoint: manifest.entrypoint,
            exclude: manifest.bundle?.exclude,
            include: manifest.bundle?.include,
          })
          process.stderr.write(`Would upload bundle: ${(bundlePreview.totalSizeBytes / 1024).toFixed(1)} KB\n`)
        }
        process.stderr.write(`API endpoint: POST ${config.apiUrl}/${preview.org_slug}/${manifest.name}/${preview.next_version}/run\n\n`)
        process.stderr.write('No changes made (dry run)\n')
        return
      }

      // Create the agent (server auto-assigns version)
      let result: Awaited<ReturnType<typeof createAgent>>
      try {
        result = await createAgent(config, {
          name: manifest.name,
          type: manifest.type,
          description: manifest.description,
          prompt,
          url: agentUrl,
          input_schema: inputSchema,
          output_schema: outputSchema,
          tags: manifest.tags,
          is_public: false,
          supported_providers: supportedProviders,
          default_models: manifest.default_models,
          // Local run fields for tool agents
          source_url: manifest.source_url,
          pip_package: manifest.pip_package,
          run_command: manifest.run_command,
          // SDK compatibility flag
          sdk_compatible: sdkCompatible || undefined,
          // Orchestration manifest (includes dependencies)
          manifest: manifest.manifest,
          default_skills: skillsFromFlag || manifest.default_skills,
          skills_locked: manifest.skills_locked || options.skillsLocked || undefined,
          allow_local_download: options.localDownload || false,
        })
      } catch (err) {
        // Improve SECURITY_BLOCKED error display
        if (err instanceof ApiError && err.status === 422) {
          const payload = err.payload as Record<string, unknown> | undefined
          const errorCode = (payload?.error as Record<string, unknown>)?.code
          if (errorCode === 'SECURITY_BLOCKED') {
            const analysis = payload?.security_analysis as Record<string, unknown> | undefined
            const blockReason = (payload?.error as Record<string, unknown>)?.message || 'Security pattern detected'

            process.stderr.write(chalk.red(`\nPublish blocked: ${blockReason}\n\n`))

            // Show matched patterns with file:line
            const matches = (analysis?.matches || []) as Array<Record<string, unknown>>
            if (matches.length > 0) {
              process.stderr.write(chalk.yellow('Patterns detected:\n'))
              for (const match of matches.slice(0, 5)) {
                const severity = String(match.severity || '').toUpperCase()
                const file = match.file_path || 'unknown'
                const line = match.line_number || '?'
                const desc = match.description || match.pattern_id || ''
                process.stderr.write(`  ${chalk.red(severity)} ${file}:${line} — ${desc}\n`)
              }
              process.stderr.write('\n')
            }

            process.stderr.write(
              'Skills are scanned for patterns that could instruct AI agents to\n' +
              'perform harmful actions (shell injection, data exfiltration, etc.).\n\n' +
              'Code-execution references (eval, subprocess, importlib) are allowed\n' +
              'since the E2B sandbox is the security boundary for code execution.\n'
            )
            throw new CliError('Publish blocked by security scan', ExitCodes.PERMISSION_DENIED)
          }
        }
        throw err
      }

      const assignedVersion = result.agent?.version || 'v1'
      const agentId = result.agent?.id

      // Upload code bundle if this is a hosted tool agent or agent type with --docker
      if (shouldUploadBundle && agentId) {
        process.stdout.write(`\nBundling code...\n`)

        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchagent-bundle-'))
        const bundlePath = path.join(tempDir, 'bundle.zip')

        try {
          // Build include patterns - add Dockerfile if --docker flag is set
          const includePatterns = [...(manifest.bundle?.include || [])]
          if (options.docker) {
            const dockerfilePath = path.join(cwd, 'Dockerfile')
            try {
              await fs.access(dockerfilePath)
              includePatterns.push('Dockerfile')
              process.stdout.write(`  Including Dockerfile for custom environment\n`)
            } catch {
              throw new CliError('--docker flag specified but no Dockerfile found in project directory')
            }
          }

          // For agent type, also include requirements.txt if present
          if (manifest.type === 'agent') {
            const reqPath = path.join(cwd, 'requirements.txt')
            try {
              await fs.access(reqPath)
              includePatterns.push('requirements.txt')
              process.stdout.write(`  Including requirements.txt for sandbox dependencies\n`)
            } catch {
              // Optional
            }
          }

          const bundleResult = await createCodeBundle(cwd, bundlePath, {
            entrypoint: manifest.type === 'agent' ? undefined : manifest.entrypoint,
            exclude: manifest.bundle?.exclude,
            include: includePatterns.length > 0 ? includePatterns : undefined,
            skipEntrypointCheck: manifest.type === 'agent',
          })

          process.stdout.write(`  Created bundle: ${bundleResult.fileCount} files, ${(bundleResult.sizeBytes / 1024).toFixed(1)}KB\n`)

          // Validate bundle size
          const validation = await validateBundle(bundlePath)
          if (!validation.valid) {
            throw new CliError(`Bundle validation failed: ${validation.error}`)
          }

          // Upload the bundle with entrypoint
          process.stdout.write(`  Uploading bundle...\n`)
          const uploadResult = await uploadCodeBundle(config, agentId, bundlePath, manifest.entrypoint)
          process.stdout.write(`  Uploaded: ${uploadResult.code_hash.substring(0, 12)}...\n`)

          // Show environment info if applicable
          if (uploadResult.environment_id) {
            if (uploadResult.environment_source === 'dockerfile_new') {
              process.stdout.write(`  ${chalk.cyan('Custom environment detected (Dockerfile)')}\n`)
              process.stdout.write(`  ${chalk.yellow('Environment building...')} Agent will be ready when build completes.\n`)
              process.stdout.write(`  ${chalk.gray(`Check status: orchagent env status ${uploadResult.environment_id}`)}\n`)
            } else if (uploadResult.environment_source === 'dockerfile_reused') {
              process.stdout.write(`  ${chalk.green('Custom environment (reusing existing build)')}\n`)
            } else if (uploadResult.environment_source === 'workspace_default') {
              process.stdout.write(`  ${chalk.cyan('Using workspace default environment')}\n`)
            }
          }
        } finally {
          // Clean up temp files
          await fs.rm(tempDir, { recursive: true, force: true })
        }
      }

      await track('cli_publish', { agent_type: manifest.type, hosted: shouldUploadBundle })
      process.stdout.write(`\nPublished agent: ${org.slug}/${manifest.name}@${assignedVersion}\n`)
      process.stdout.write(`Type: ${manifest.type}${shouldUploadBundle ? ' (hosted)' : ''}\n`)
      process.stdout.write(`Providers: ${supportedProviders.join(', ')}\n`)
      process.stdout.write(`Visibility: private\n`)

      // Show security review result if available
      const secReview = (result as Record<string, unknown>).security_review as
        { verdict?: string; summary?: string } | undefined
      if (secReview?.verdict) {
        if (secReview.verdict === 'passed') {
          process.stdout.write(`Security: ${chalk.green('passed')}\n`)
        } else if (secReview.verdict === 'flagged') {
          process.stdout.write(`Security: ${chalk.yellow('flagged')} — ${secReview.summary || 'review recommended'}\n`)
        } else {
          process.stdout.write(`Security: ${secReview.verdict}\n`)
        }
      }

      if (result.service_key) {
        process.stdout.write(`\nService key (save this - shown only once):\n`)
        process.stdout.write(`  ${result.service_key}\n`)
      }

      process.stdout.write(`\nAPI endpoint:\n`)
      process.stdout.write(`  POST ${config.apiUrl}/${org.slug}/${manifest.name}/${assignedVersion}/run\n`)

      if (shouldUploadBundle) {
        process.stdout.write(`\nNote: Hosted code execution is in beta. Contact support for full deployment.\n`)
      }

      process.stdout.write(`\nView analytics and usage: https://orchagent.io/dashboard\n`)
    })
}
