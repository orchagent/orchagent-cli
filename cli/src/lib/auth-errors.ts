import { CliError } from './errors'

const AUTH_MESSAGES: Record<number, string> = {
  400: 'Invalid authentication request. Please try again.',
  401: 'Authentication failed. Run `orchagent login` again.',
  403: 'Access denied. You may not have permission for this organization.',
  429: 'Too many attempts. Wait a moment and try again.',
  500: 'Server error. Please try again later.',
  502: 'Server temporarily unavailable. Try again later.',
}

export async function parseAuthError(
  response: Response,
  context: 'init' | 'exchange'
): Promise<CliError> {
  try {
    const json = await response.json()
    const msg = json?.error?.message || json?.message
    if (msg && typeof msg === 'string' && msg.length < 200) {
      return new CliError(msg)
    }
  } catch {}

  const ctx = context === 'init'
    ? 'Failed to start authentication'
    : 'Failed to complete authentication'
  const action = AUTH_MESSAGES[response.status] || 'Please try again.'

  return new CliError(`${ctx}: ${action}`)
}
