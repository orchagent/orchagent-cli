import ora, { type Ora } from 'ora'

// Global flag to control spinner visibility (set via --no-progress)
let progressEnabled = true

/**
 * Set whether progress spinners are enabled.
 * Disable for CI/scripts with --no-progress flag.
 */
export function setProgressEnabled(enabled: boolean): void {
  progressEnabled = enabled
}

/**
 * Check if progress spinners are enabled.
 */
export function isProgressEnabled(): boolean {
  return progressEnabled
}

/**
 * Create a spinner with the given text.
 * Returns a spinner that auto-disables in non-TTY environments.
 * If progress is disabled (--no-progress), returns a no-op spinner.
 */
export function createSpinner(text: string): Ora {
  if (!progressEnabled) {
    // Return a no-op spinner that writes to stderr instead
    const noopSpinner: Partial<Ora> = {
      text,
      isSpinning: false,
      start() {
        process.stderr.write(`${text}\n`)
        return noopSpinner as Ora
      },
      stop() {
        return noopSpinner as Ora
      },
      succeed(msg?: string) {
        if (msg) process.stderr.write(`${msg}\n`)
        return noopSpinner as Ora
      },
      fail(msg?: string) {
        if (msg) process.stderr.write(`${msg}\n`)
        return noopSpinner as Ora
      },
      warn(msg?: string) {
        if (msg) process.stderr.write(`${msg}\n`)
        return noopSpinner as Ora
      },
      info(msg?: string) {
        if (msg) process.stderr.write(`${msg}\n`)
        return noopSpinner as Ora
      },
    }
    return noopSpinner as Ora
  }

  // ora automatically handles non-TTY by falling back to text output
  return ora({
    text,
    stream: process.stderr, // Use stderr so it doesn't interfere with JSON output
  })
}

/**
 * Execute an async function with a spinner.
 * Automatically handles success/failure states.
 *
 * @param text - Text to show while operation is running
 * @param fn - Async function to execute
 * @param options - Optional success/fail message overrides
 * @returns Result of the async function
 */
export async function withSpinner<T>(
  text: string,
  fn: () => Promise<T>,
  options?: {
    successText?: string | ((result: T) => string)
    failText?: string | ((error: Error) => string)
  }
): Promise<T> {
  const spinner = createSpinner(text)
  spinner.start()

  try {
    const result = await fn()
    const successMsg = typeof options?.successText === 'function'
      ? options.successText(result)
      : options?.successText
    spinner.succeed(successMsg)
    return result
  } catch (err) {
    const failMsg = typeof options?.failText === 'function'
      ? options.failText(err as Error)
      : options?.failText || (err instanceof Error ? err.message : 'Failed')
    spinner.fail(failMsg)
    // Mark as already displayed so exitWithError doesn't print again
    if (err instanceof Error) {
      ;(err as Error & { _displayed?: boolean })._displayed = true
    }
    throw err
  }
}

/**
 * Create a spinner that can be updated with progress info.
 * Useful for operations like downloads where you want to show progress.
 */
export function createProgressSpinner(initialText: string): {
  spinner: Ora
  updateProgress: (current: number, total: number, unit?: string) => void
} {
  const spinner = createSpinner(initialText)

  const updateProgress = (current: number, total: number, unit = 'bytes') => {
    if (progressEnabled && spinner.isSpinning) {
      const percent = total > 0 ? Math.round((current / total) * 100) : 0
      spinner.text = `${initialText} (${percent}% - ${current}/${total} ${unit})`
    }
  }

  return { spinner, updateProgress }
}
