import fs from 'fs/promises'
import { CliError, jsonInputError } from './errors'

async function readStdin(): Promise<Buffer | null> {
  if (process.stdin.isTTY) return null
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk))
  }
  if (!chunks.length) return null
  return Buffer.concat(chunks)
}

async function validateFilePath(filePath: string): Promise<void> {
  const stat = await fs.stat(filePath)
  if (stat.isDirectory()) {
    throw new CliError(
      `Expected a file but got a directory: ${filePath}\n\n` +
      `Provide a JSON file path, e.g. --data @input.json`
    )
  }
}

/**
 * Resolve a --data value to a validated JSON string.
 *
 * Supports three input forms:
 *   - Plain JSON string:  '{"key":"value"}'
 *   - File reference:     @input.json
 *   - Stdin pipe:         @-
 */
export async function resolveJsonBody(input: string): Promise<string> {
  let raw = input
  if (input.startsWith('@')) {
    const source = input.slice(1)
    if (!source) {
      throw new CliError('Invalid JSON input. Use a JSON string or @file.')
    }
    if (source === '-') {
      const stdinData = await readStdin()
      if (!stdinData) {
        throw new CliError('No stdin provided for JSON input.')
      }
      raw = stdinData.toString('utf8')
    } else {
      await validateFilePath(source)
      raw = await fs.readFile(source, 'utf8')
    }
  }

  try {
    return JSON.stringify(JSON.parse(raw))
  } catch {
    throw jsonInputError('data')
  }
}
