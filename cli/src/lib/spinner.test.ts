/**
 * Tests for spinner utilities — elapsed spinner and formatElapsed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock ora before importing spinner module
vi.mock('ora', () => {
  const createMockSpinner = (opts: { text: string }) => {
    const spinner: Record<string, unknown> = {
      text: opts.text,
      isSpinning: false,
      start(newText?: string) {
        if (newText) spinner.text = newText
        spinner.isSpinning = true
        return spinner
      },
      stop() {
        spinner.isSpinning = false
        return spinner
      },
      succeed(msg?: string) {
        if (msg) spinner.text = msg
        spinner.isSpinning = false
        return spinner
      },
      fail(msg?: string) {
        if (msg) spinner.text = msg
        spinner.isSpinning = false
        return spinner
      },
      warn(msg?: string) {
        if (msg) spinner.text = msg
        spinner.isSpinning = false
        return spinner
      },
      info(msg?: string) {
        if (msg) spinner.text = msg
        spinner.isSpinning = false
        return spinner
      },
    }
    return spinner
  }
  return { default: createMockSpinner }
})

import {
  formatElapsed,
  createElapsedSpinner,
  withSpinner,
  setProgressEnabled,
} from './spinner'
import { CliError } from './errors'

describe('withSpinner', () => {
  beforeEach(() => {
    setProgressEnabled(true)
  })

  it('sets displayed=true on CliError so exitWithError deduplicates', async () => {
    const cliErr = new CliError('Something went wrong')

    await expect(
      withSpinner('Working...', async () => { throw cliErr })
    ).rejects.toThrow(cliErr)

    // exitWithError checks err.displayed for CliError instances
    expect(cliErr.displayed).toBe(true)
  })

  it('sets _displayed=true on generic Error for deduplication', async () => {
    const genericErr = new Error('generic failure')

    await expect(
      withSpinner('Working...', async () => { throw genericErr })
    ).rejects.toThrow(genericErr)

    expect((genericErr as Error & { _displayed?: boolean })._displayed).toBe(true)
  })
})

describe('formatElapsed', () => {
  it('formats sub-minute times with one decimal', () => {
    expect(formatElapsed(0)).toBe('0.0s')
    expect(formatElapsed(1.2)).toBe('1.2s')
    expect(formatElapsed(5)).toBe('5.0s')
    expect(formatElapsed(59.9)).toBe('59.9s')
  })

  it('formats times at 60s+ as minutes and seconds', () => {
    expect(formatElapsed(60)).toBe('1m 00s')
    expect(formatElapsed(61)).toBe('1m 01s')
    expect(formatElapsed(90)).toBe('1m 30s')
    expect(formatElapsed(125)).toBe('2m 05s')
    expect(formatElapsed(3600)).toBe('60m 00s')
  })

  it('pads seconds with leading zero in minute format', () => {
    expect(formatElapsed(63)).toBe('1m 03s')
    expect(formatElapsed(121)).toBe('2m 01s')
  })
})

describe('createElapsedSpinner', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setProgressEnabled(true)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('creates a spinner with the given text', () => {
    const { spinner, dispose } = createElapsedSpinner('Loading...')
    expect(spinner.text).toBe('Loading...')
    dispose()
  })

  it('starts the spinner and begins updating elapsed time', () => {
    const { spinner, dispose } = createElapsedSpinner('Running agent...')
    spinner.start()

    expect(spinner.isSpinning).toBe(true)

    // After 1 second, text should include elapsed time
    vi.advanceTimersByTime(1000)
    expect(spinner.text).toMatch(/Running agent\.\.\. \(1\.0s\)/)

    // After another second
    vi.advanceTimersByTime(1000)
    expect(spinner.text).toMatch(/Running agent\.\.\. \(2\.0s\)/)

    dispose()
  })

  it('shows minute format after 60 seconds', () => {
    const { spinner, dispose } = createElapsedSpinner('Processing...')
    spinner.start()

    vi.advanceTimersByTime(65000)
    expect(spinner.text).toMatch(/Processing\.\.\. \(1m 05s\)/)

    dispose()
  })

  it('stops the timer when dispose is called', () => {
    const { spinner, dispose } = createElapsedSpinner('Test...')
    spinner.start()

    vi.advanceTimersByTime(2000)
    expect(spinner.text).toMatch(/2\.0s/)

    dispose()

    // Text should not update after dispose
    const frozenText = spinner.text
    vi.advanceTimersByTime(5000)
    expect(spinner.text).toBe(frozenText)
  })

  it('auto-disposes timer on spinner.stop()', () => {
    const { spinner } = createElapsedSpinner('Test...')
    spinner.start()

    vi.advanceTimersByTime(2000)
    spinner.stop()

    const frozenText = spinner.text
    vi.advanceTimersByTime(5000)
    expect(spinner.text).toBe(frozenText)
  })

  it('auto-disposes timer on spinner.succeed()', () => {
    const { spinner } = createElapsedSpinner('Test...')
    spinner.start()

    vi.advanceTimersByTime(2000)
    spinner.succeed('Done!')

    vi.advanceTimersByTime(5000)
    expect(spinner.text).toBe('Done!')
  })

  it('auto-disposes timer on spinner.fail()', () => {
    const { spinner } = createElapsedSpinner('Test...')
    spinner.start()

    vi.advanceTimersByTime(2000)
    spinner.fail('Failed!')

    vi.advanceTimersByTime(5000)
    expect(spinner.text).toBe('Failed!')
  })

  it('is safe to call dispose multiple times', () => {
    const { spinner, dispose } = createElapsedSpinner('Test...')
    spinner.start()

    dispose()
    dispose()
    dispose()
    // No error thrown
  })

  it('works with --no-progress (noop spinner)', () => {
    setProgressEnabled(false)

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const { spinner, dispose } = createElapsedSpinner('Loading...')
    spinner.start()

    // Noop spinner writes to stderr once and that's it
    expect(stderrSpy).toHaveBeenCalledWith('Loading...\n')

    dispose()
    stderrSpy.mockRestore()
    setProgressEnabled(true)
  })

  it('handles start called with custom text', () => {
    const { spinner, dispose } = createElapsedSpinner('Original...')
    spinner.start('Override...')

    // The timer still uses the original base text for updates
    vi.advanceTimersByTime(1000)
    expect(spinner.text).toMatch(/Original\.\.\. \(1\.0s\)/)

    dispose()
  })
})
