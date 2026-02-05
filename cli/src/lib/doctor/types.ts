/**
 * Result of a single diagnostic check.
 */
export interface CheckResult {
  /** Category grouping for display (e.g., 'environment', 'auth') */
  category: string
  /** Unique identifier for this check */
  name: string
  /** Check outcome */
  status: 'success' | 'warning' | 'error' | 'info'
  /** Human-readable description of the result */
  message: string
  /** Suggested fix command/action (displayed when status is warning or error) */
  fix?: string
  /** Additional details for verbose/JSON output */
  details?: Record<string, unknown>
}

/**
 * Aggregated summary of all check results.
 */
export interface DoctorSummary {
  passed: number
  warnings: number
  errors: number
}

/**
 * JSON output format for --json flag.
 */
export interface DoctorJsonOutput {
  summary: DoctorSummary
  checks: CheckResult[]
}

/**
 * Options passed to the doctor command.
 */
export interface DoctorOptions {
  verbose?: boolean
  json?: boolean
}

/**
 * A check function that returns one or more CheckResults.
 */
export type CheckFunction = () => Promise<CheckResult[]>
