/**
 * Input hardening utilities (DX-29).
 *
 * Central sanitization for:
 *   4a — Control character rejection
 *   4b — Path traversal bounds checking
 *   4c — Resource ID validation (no query-param chars, no double-encoding)
 */

import path from 'path'
import { CliError, ExitCodes, ErrorCodes } from './errors'

// ASCII control chars (0x00-0x1F) minus allowed whitespace (\t=0x09, \n=0x0A, \r=0x0D).
// Also includes DEL (0x7F).
// eslint-disable-next-line no-control-regex
const DANGEROUS_CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/

// Characters that must never appear in resource identifiers (agent names, org names, versions).
// These could inject query params, fragments, or URL-encoded path traversals.
const RESOURCE_ID_UNSAFE_RE = /[?#%&=]/

/**
 * Reject ASCII control characters in a string (except \n, \r, \t).
 * Throws CliError with INVALID_INPUT if found.
 */
export function rejectControlChars(value: string, fieldName: string): void {
  if (DANGEROUS_CONTROL_RE.test(value)) {
    const err = new CliError(
      `${fieldName} contains an invalid control character. ` +
        'Remove non-printable characters and try again.',
      ExitCodes.INVALID_INPUT
    )
    err.code = ErrorCodes.INVALID_INPUT
    throw err
  }
}

/**
 * Reject characters that could inject query params, fragments, or URL encoding
 * into resource identifiers (agent names, org names, version strings).
 *
 * Blocked: ? # % & =
 * Also delegates to rejectControlChars.
 */
export function rejectResourceIdChars(value: string, fieldName: string): void {
  rejectControlChars(value, fieldName)

  const match = value.match(RESOURCE_ID_UNSAFE_RE)
  if (match) {
    const err = new CliError(
      `${fieldName} contains '${match[0]}' which is not allowed. ` +
        'Resource identifiers must not contain ?, #, %, &, or = characters.',
      ExitCodes.INVALID_INPUT
    )
    err.code = ErrorCodes.INVALID_INPUT
    throw err
  }
}

/**
 * Verify that a resolved (absolute) path stays within an allowed base directory.
 * Both paths must be absolute. The resolved path is checked after normalization.
 */
export function ensurePathInBounds(resolvedPath: string, basePath: string): void {
  const normalizedBase = path.resolve(basePath) + path.sep
  const normalizedTarget = path.resolve(resolvedPath)

  // Allow exact match (target IS the base) or target is inside base
  if (normalizedTarget !== path.resolve(basePath) && !normalizedTarget.startsWith(normalizedBase)) {
    const err = new CliError(
      `Path '${resolvedPath}' is outside the allowed directory '${basePath}'. ` +
        'File references must not escape the project root.',
      ExitCodes.INVALID_INPUT
    )
    err.code = ErrorCodes.INVALID_INPUT
    throw err
  }
}

/**
 * Reject path traversal sequences in a raw file path argument.
 *
 * Blocks `../` (and `..\` on Windows) in the raw input string. Absolute paths
 * are allowed — the user explicitly chose them. This catches accidental or
 * malicious relative traversal while still permitting `/home/user/file.json`.
 */
export function rejectPathTraversal(rawPath: string, fieldName: string): void {
  // Normalize to forward slashes for cross-platform check
  const normalized = rawPath.replace(/\\/g, '/')
  if (normalized.includes('../') || normalized === '..' || normalized.endsWith('/..')) {
    const err = new CliError(
      `${fieldName} contains a path traversal sequence ('../'). ` +
        'Use a direct path instead.',
      ExitCodes.INVALID_INPUT
    )
    err.code = ErrorCodes.INVALID_INPUT
    throw err
  }
}

/**
 * Sanitize a secret value: strip dangerous control chars but keep \n, \r, \t
 * (which appear in PEM keys, multi-line tokens, etc.).
 *
 * Returns the cleaned value. Does NOT throw — secrets may legitimately contain
 * special characters, so we strip silently per the DX-29 spec.
 */
export function sanitizeSecretValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
}
