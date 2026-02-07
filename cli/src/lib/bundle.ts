/**
 * Code bundling utilities for hosted code agents.
 *
 * Creates zip bundles from project directories for upload to orchagent.
 */

import fs from 'fs/promises'
import path from 'path'
import archiver from 'archiver'
import { createWriteStream } from 'fs'
import { glob } from 'glob'

export interface BundleOptions {
  /** Additional patterns to exclude (glob patterns) */
  exclude?: string[]
  /** Patterns to explicitly include (overrides excludes) */
  include?: string[]
  /** Entry point file (default: main.py) */
  entrypoint?: string
  /** Skip entrypoint file check (for agentic agents that have no code) */
  skipEntrypointCheck?: boolean
}

export interface BundlePreview {
  fileCount: number
  totalSizeBytes: number
  entrypoint: string
  excludePatterns: string[]
}

/** Default patterns to exclude from bundles */
const DEFAULT_EXCLUDES = [
  // Python
  '**/__pycache__/**',
  '**/*.pyc',
  '**/*.pyo',
  '**/*.pyd',
  '.Python',
  'venv/**',
  '.venv/**',
  'env/**',
  '.env',
  '**/*.egg-info/**',
  'dist/**',
  'build/**',
  '.eggs/**',
  '.mypy_cache/**',
  '.pytest_cache/**',
  '.ruff_cache/**',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',

  // Node.js
  'node_modules/**',
  'npm-debug.log',
  'yarn-error.log',
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'tsconfig.json',

  // Git
  '.git/**',
  '.gitignore',
  '.gitattributes',

  // IDE
  '.idea/**',
  '.vscode/**',
  '*.swp',
  '*.swo',
  '.DS_Store',

  // Documentation
  'README.md',
  'README.rst',
  'README.txt',
  'CHANGELOG.md',
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'docs/**',

  // Docker
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  '.dockerignore',

  // CI/CD
  '.github/**',
  '.gitlab-ci.yml',
  '.travis.yml',
  '.circleci/**',

  // Test files
  'tests/**',
  'test/**',
  '*_test.py',
  'test_*.py',
  '*.test.js',
  '*.test.ts',
  '*.spec.js',
  '*.spec.ts',
  '__tests__/**',
  'conftest.py',
  'pytest.ini',
  '.coveragerc',
  'coverage/**',

  // orchagent
  'orchagent.json',
  'bundle.zip',
  '*.zip',

  // Scripts and misc
  'scripts/**',
  'Makefile',
  '.editorconfig',
  '.pre-commit-config.yaml',
]

/**
 * Create a code bundle from a project directory.
 *
 * @param sourceDir - The directory to bundle
 * @param outputPath - Path for the output zip file
 * @param options - Bundle options
 * @returns Promise that resolves with bundle metadata
 */
export async function createCodeBundle(
  sourceDir: string,
  outputPath: string,
  options: BundleOptions = {}
): Promise<{ path: string; sizeBytes: number; fileCount: number }> {
  // Build exclude patterns, but remove any that are in the include list
  const includeSet = new Set(options.include || [])
  const excludePatterns = [...DEFAULT_EXCLUDES, ...(options.exclude || [])]
    .filter(pattern => !includeSet.has(pattern))

  // Verify source directory exists
  const stat = await fs.stat(sourceDir)
  if (!stat.isDirectory()) {
    throw new Error(`Source path is not a directory: ${sourceDir}`)
  }

  // Verify entrypoint exists if specified (skip for agentic agents that have no code)
  if (!options.skipEntrypointCheck) {
    const entrypoint = options.entrypoint || 'main.py'
    const entrypointPath = path.join(sourceDir, entrypoint)
    try {
      await fs.access(entrypointPath)
    } catch {
      throw new Error(`Entrypoint file not found: ${entrypoint}`)
    }
  }

  // Create output directory if needed
  const outputDir = path.dirname(outputPath)
  await fs.mkdir(outputDir, { recursive: true })

  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath)
    const archive = archiver('zip', { zlib: { level: 9 } })

    let fileCount = 0

    output.on('close', () => {
      resolve({
        path: outputPath,
        sizeBytes: archive.pointer(),
        fileCount,
      })
    })

    archive.on('error', (err: Error) => {
      reject(err)
    })

    archive.on('entry', () => {
      fileCount++
    })

    archive.pipe(output)

    // Add directory contents with exclusions
    archive.glob('**/*', {
      cwd: sourceDir,
      ignore: excludePatterns,
      dot: false,
    })

    archive.finalize()
  })
}

/**
 * Detect the project type and suggest an entrypoint.
 *
 * @param projectDir - The project directory to analyze
 * @returns Detected entrypoint or null if not found
 */
export async function detectEntrypoint(projectDir: string): Promise<string | null> {
  // Check common Python entrypoints
  const pythonEntrypoints = ['main.py', 'app.py', 'agent.py', 'run.py', '__main__.py']
  for (const entry of pythonEntrypoints) {
    try {
      await fs.access(path.join(projectDir, entry))
      return entry
    } catch {
      // Continue checking
    }
  }

  // Check common JS/TS entrypoints
  const jsEntrypoints = ['main.js', 'index.js', 'agent.js', 'main.ts', 'index.ts', 'agent.ts']
  for (const entry of jsEntrypoints) {
    try {
      await fs.access(path.join(projectDir, entry))
      return entry
    } catch {
      // Continue checking
    }
  }

  return null
}

/**
 * Preview what would be bundled without creating the actual bundle.
 *
 * @param sourceDir - The directory to analyze
 * @param options - Bundle options
 * @returns Preview information about the bundle
 */
export async function previewBundle(
  sourceDir: string,
  options: BundleOptions = {}
): Promise<BundlePreview> {
  const excludePatterns = [...DEFAULT_EXCLUDES, ...(options.exclude || [])]

  // Verify source directory exists
  const stat = await fs.stat(sourceDir)
  if (!stat.isDirectory()) {
    throw new Error(`Source path is not a directory: ${sourceDir}`)
  }

  // Detect or use provided entrypoint
  let entrypoint = options.entrypoint
  if (!entrypoint) {
    const detected = await detectEntrypoint(sourceDir)
    entrypoint = detected || 'main.py'
  }

  // Find all files that would be included (matching createCodeBundle's glob pattern)
  const files = await glob('**/*', {
    cwd: sourceDir,
    ignore: excludePatterns,
    dot: false,
    nodir: true,
  })

  // Calculate total size by reading file stats
  let totalSizeBytes = 0
  for (const file of files) {
    const filePath = path.join(sourceDir, file)
    try {
      const fileStat = await fs.stat(filePath)
      totalSizeBytes += fileStat.size
    } catch {
      // Skip files that can't be stat'd (e.g., broken symlinks)
    }
  }

  return {
    fileCount: files.length,
    totalSizeBytes,
    entrypoint,
    excludePatterns,
  }
}

/**
 * Validate a bundle before upload.
 *
 * @param bundlePath - Path to the zip file
 * @param maxSizeBytes - Maximum allowed size
 * @returns Validation result
 */
export async function validateBundle(
  bundlePath: string,
  maxSizeBytes: number = 50 * 1024 * 1024
): Promise<{ valid: boolean; error?: string; sizeBytes: number }> {
  try {
    const stat = await fs.stat(bundlePath)

    if (stat.size > maxSizeBytes) {
      return {
        valid: false,
        error: `Bundle exceeds maximum size of ${maxSizeBytes / (1024 * 1024)}MB`,
        sizeBytes: stat.size,
      }
    }

    return { valid: true, sizeBytes: stat.size }
  } catch (err) {
    return {
      valid: false,
      error: `Failed to read bundle: ${err}`,
      sizeBytes: 0,
    }
  }
}
