import { Command } from 'commander'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import yaml from 'yaml'
import chalk from 'chalk'

import { getResolvedConfig } from '../lib/config'
import { createAgent, getOrg, uploadCodeBundle, previewAgentVersion, ApiError, setAgentPricing } from '../lib/api'
import { CliError, ExitCodes } from '../lib/errors'
import { track } from '../lib/analytics'
import { createCodeBundle, detectEntrypoint, validateBundle, previewBundle } from '../lib/bundle'
import type { AgentManifest } from '../types'

/**
 * Type for security flagged response payload
 */
interface ContentFlaggedPayload {
  error?: string
  message?: string
  concerns?: Array<{
    category: string
    description: string
    file_path?: string
    severity: string
  }>
  summary?: string
  confidence?: number
}

/**
 * Handle security flagged error response (422 with error: 'content_flagged')
 * Returns true if the error was handled, false otherwise
 */
function handleSecurityFlaggedError(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 422) {
    return false
  }

  const payload = err.payload as ContentFlaggedPayload

  if (payload?.error !== 'content_flagged') {
    return false
  }

  process.stderr.write('\n')
  process.stderr.write('Error: Skill flagged for security review\n\n')

  if (payload.concerns && payload.concerns.length > 0) {
    process.stderr.write('Concerns found:\n')
    for (const concern of payload.concerns) {
      const severityLabel = concern.severity.toUpperCase()
      const fileInfo = concern.file_path ? ` in ${concern.file_path}` : ''
      process.stderr.write(`  [${severityLabel}] ${concern.category}${fileInfo}\n`)
      process.stderr.write(`    "${concern.description}"\n\n`)
    }
  }

  if (payload.summary) {
    process.stderr.write(`Summary: ${payload.summary}\n\n`)
  }

  process.stderr.write('Please review and remove suspicious patterns before publishing.\n')
  process.stderr.write('If you believe this is a false positive, contact support@orchagent.com\n')

  return true
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
    .option('--public', 'Make agent public')
    .option('--private', 'Make agent private (deprecated: now the default)')
    .option('--profile <name>', 'Use API key from named profile')
    .option('--dry-run', 'Show what would be published without making changes')
    .option('--skills <skills>', 'Default skills (comma-separated, e.g., org/skill@v1,org/other@v1)')
    .option('--skills-locked', 'Lock default skills (callers cannot override via headers)')
    .option('--docker', 'Include Dockerfile for custom environment (builds E2B template)')
    .option('--price <amount>', 'Set price per call in USD (e.g., 0.50 for $0.50/call)')
    .option('--pricing-mode <mode>', 'Pricing mode: free or per_call (default: free)')
    .action(async (options: { url?: string; public?: boolean; private?: boolean; profile?: string; dryRun?: boolean; skills?: string; skillsLocked?: boolean; docker?: boolean; price?: string; pricingMode?: string }) => {
      if (options.private) {
        process.stderr.write('Warning: --private is deprecated (private is now the default). You can safely remove it.\n')
      }
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
          process.stderr.write(`  Visibility:  ${options.public ? 'public' : 'private'}\n`)
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
            is_public: options.public ? true : false,
            supported_providers: ['any'],
            default_skills: skillsFromFlag,
            skills_locked: options.skillsLocked || undefined,
            // SC-05: Include all skill files for UI preview
            skill_files: hasMultipleFiles ? skillFiles : undefined,
          })
          const skillVersion = skillResult.agent?.version || 'v1'
          const skillAgentId = skillResult.agent?.id

          // Handle pricing for skills
          if (skillAgentId && (options.price || options.pricingMode)) {
            let pricingMode: 'free' | 'per_call' = 'free'
            let pricePerCallCents: number | undefined

            if (options.price) {
              const priceFloat = parseFloat(options.price)
              if (isNaN(priceFloat) || priceFloat < 0) {
                throw new CliError('Price must be a positive number', ExitCodes.INVALID_INPUT)
              }

              if (priceFloat === 0) {
                pricingMode = 'free'
              } else if (priceFloat < 0.01) {
                throw new CliError('Price must be at least $0.01 USD', ExitCodes.INVALID_INPUT)
              } else {
                pricingMode = 'per_call'
                pricePerCallCents = Math.round(priceFloat * 100)
              }
            } else if (options.pricingMode) {
              pricingMode = options.pricingMode === 'per_call' ? 'per_call' : 'free'
            }

            // Set pricing
            if (pricingMode === 'per_call' && !pricePerCallCents) {
              throw new CliError('--price required when using per_call mode', ExitCodes.INVALID_INPUT)
            }

            await setAgentPricing(config, skillAgentId, pricingMode, pricePerCallCents)
          }

          await track('cli_publish', { agent_type: 'skill', multi_file: hasMultipleFiles })
          process.stdout.write(`\nPublished skill: ${org.slug}/${skillData.frontmatter.name}@${skillVersion}\n`)
          if (hasMultipleFiles) {
            process.stdout.write(`Files: ${skillFiles.length} files included\n`)
          }
          process.stdout.write(`Public: ${options.public ? 'yes' : 'no'}\n`)

          // Show pricing info
          if (options.price && parseFloat(options.price) > 0) {
            const price = parseFloat(options.price)
            process.stdout.write(`Pricing: $${price.toFixed(2)} USD per call\n`)
          }
        } catch (err) {
          if (handleSecurityFlaggedError(err)) {
            process.exit(1)
          }
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

      // Check for misplaced manifest fields at top level (common user error)
      const manifestFields = ['manifest_version', 'dependencies', 'max_hops', 'timeout_ms', 'per_call_downstream_cap']
      const misplacedFields = manifestFields.filter(f => f in manifest && !manifest.manifest)
      if (misplacedFields.length > 0) {
        throw new CliError(
          `Found manifest fields (${misplacedFields.join(', ')}) at top level of orchagent.json.\n` +
          `These must be nested under a "manifest" key. Example:\n\n` +
          `  {\n` +
          `    "name": "${manifest.name}",\n` +
          `    "type": "${manifest.type || 'code'}",\n` +
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

      // Read prompt (for prompt-based agents and skills)
      let prompt: string | undefined
      if (manifest.type === 'prompt' || manifest.type === 'skill') {
        const promptPath = path.join(cwd, 'prompt.md')
        try {
          prompt = await fs.readFile(promptPath, 'utf-8')
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            const agentTypeName = manifest.type === 'skill' ? 'skill' : 'prompt-based agent'
            throw new CliError(
              `No prompt.md found for ${agentTypeName}.\n\n` +
              'Create a prompt.md file in the current directory with your prompt template.\n' +
              'See: https://orchagent.io/docs/publishing'
            )
          }
          throw err
        }
      }

      // Read schemas
      let inputSchema: object | undefined
      let outputSchema: object | undefined
      const schemaPath = path.join(cwd, 'schema.json')
      try {
        const raw = await fs.readFile(schemaPath, 'utf-8')
        const schemas = JSON.parse(raw)
        inputSchema = schemas.input
        outputSchema = schemas.output
      } catch (err) {
        // Schema is optional
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new CliError(`Failed to read schema.json: ${err}`)
        }
      }

      // For code-based agents, either --url is required OR we bundle the code
      let agentUrl = options.url
      let shouldUploadBundle = false

      if (manifest.type === 'code' && !options.url) {
        // Check if this looks like a Python or JS project that can be bundled
        const entrypoint = manifest.entrypoint || await detectEntrypoint(cwd)
        if (entrypoint) {
          // This is a hosted code agent - we'll bundle and upload
          shouldUploadBundle = true
          // Set a placeholder URL that tells the gateway to use sandbox execution
          agentUrl = 'https://code-agent.internal'
          process.stdout.write(`Detected code project with entrypoint: ${entrypoint}\n`)
        } else {
          throw new CliError(
            'Code agent requires either --url <url> or an entry point file (main.py, app.py, index.js, etc.)'
          )
        }
      }

      // Get org info
      const org = await getOrg(config)

      // Default to 'any' provider if not specified
      const supportedProviders = manifest.supported_providers || ['any']

      // Detect SDK compatibility for code agents
      let sdkCompatible = false
      if (manifest.type === 'code') {
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
          if (inputSchema || outputSchema) {
            const schemaTypes = [inputSchema ? 'input' : null, outputSchema ? 'output' : null].filter(Boolean).join(' + ')
            process.stderr.write(`  ✓ schema.json found (${schemaTypes} schemas)\n`)
          }
        } else if (manifest.type === 'code') {
          // Code agent validations
          const entrypoint = manifest.entrypoint || await detectEntrypoint(cwd)
          process.stderr.write(`  ✓ Entrypoint: ${entrypoint}\n`)
          if (sdkCompatible) {
            process.stderr.write(`  ✓ SDK detected (orchagent-sdk in requirements.txt)\n`)
          }
        }

        process.stderr.write(`  ✓ Authentication valid (org: ${org.slug})\n`)

        // For code agents with bundles, show bundle preview
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
        process.stderr.write(`  Visibility:  ${options.public ? 'public' : 'private'}\n`)
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
          is_public: options.public ? true : false,
          supported_providers: supportedProviders,
          default_models: manifest.default_models,
          // Local run fields for code agents
          source_url: manifest.source_url,
          pip_package: manifest.pip_package,
          run_command: manifest.run_command,
          // SDK compatibility flag
          sdk_compatible: sdkCompatible || undefined,
          // Orchestration manifest (includes dependencies)
          manifest: manifest.manifest,
          default_skills: skillsFromFlag || manifest.default_skills,
          skills_locked: manifest.skills_locked || options.skillsLocked || undefined,
        })
      } catch (err) {
        if (handleSecurityFlaggedError(err)) {
          process.exit(1)
        }
        throw err
      }

      const assignedVersion = result.agent?.version || 'v1'
      const agentId = result.agent?.id

      // Upload code bundle if this is a hosted code agent
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

          const bundleResult = await createCodeBundle(cwd, bundlePath, {
            entrypoint: manifest.entrypoint,
            exclude: manifest.bundle?.exclude,
            include: includePatterns.length > 0 ? includePatterns : undefined,
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
              process.stdout.write(`  ${chalk.gray(`Check status: orch env status ${uploadResult.environment_id}`)}\n`)
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

      // Handle pricing for agents
      if (agentId && (options.price || options.pricingMode)) {
        let pricingMode: 'free' | 'per_call' = 'free'
        let pricePerCallCents: number | undefined

        if (options.price) {
          const priceFloat = parseFloat(options.price)
          if (isNaN(priceFloat) || priceFloat < 0) {
            throw new CliError('Price must be a positive number', ExitCodes.INVALID_INPUT)
          }

          if (priceFloat === 0) {
            pricingMode = 'free'
          } else if (priceFloat < 0.01) {
            throw new CliError('Price must be at least $0.01 USD', ExitCodes.INVALID_INPUT)
          } else {
            pricingMode = 'per_call'
            pricePerCallCents = Math.round(priceFloat * 100)
          }
        } else if (options.pricingMode) {
          pricingMode = options.pricingMode === 'per_call' ? 'per_call' : 'free'
        }

        // Set pricing
        if (pricingMode === 'per_call' && !pricePerCallCents) {
          throw new CliError('--price required when using per_call mode', ExitCodes.INVALID_INPUT)
        }

        await setAgentPricing(config, agentId, pricingMode, pricePerCallCents)
      }

      await track('cli_publish', { agent_type: manifest.type, hosted: shouldUploadBundle })
      process.stdout.write(`\nPublished agent: ${org.slug}/${manifest.name}@${assignedVersion}\n`)
      process.stdout.write(`Type: ${manifest.type}${shouldUploadBundle ? ' (hosted)' : ''}\n`)
      process.stdout.write(`Providers: ${supportedProviders.join(', ')}\n`)
      process.stdout.write(`Public: ${options.public ? 'yes' : 'no'}\n`)

      // Show pricing info
      if (options.price && parseFloat(options.price) > 0) {
        const price = parseFloat(options.price)
        process.stdout.write(`Pricing: $${price.toFixed(2)} USD per call\n`)
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
    })
}
