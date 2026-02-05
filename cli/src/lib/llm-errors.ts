import { CliError } from './errors'

// Provider error response types
interface OpenAIError {
  error?: { message?: string; type?: string; code?: string }
}

interface AnthropicError {
  error?: { type?: string; message?: string }
  type?: string
  message?: string
}

interface GeminiError {
  error?: { code?: number; message?: string; status?: string }
}

// Safe fallback messages by status code
const FALLBACKS: Record<string, Record<number, string>> = {
  openai: {
    401: 'Invalid OpenAI API key. Check your OPENAI_API_KEY.',
    403: 'Access denied. Your API key may not have permission for this model.',
    429: 'Rate limit exceeded. Wait a moment and try again.',
    500: 'OpenAI service error. Try again later.',
    502: 'OpenAI is temporarily unavailable.',
    503: 'OpenAI is overloaded. Try again later.',
  },
  anthropic: {
    401: 'Invalid Anthropic API key. Check your ANTHROPIC_API_KEY.',
    403: 'Access denied. Your API key may not have permission for this model.',
    429: 'Rate limit exceeded. Wait a moment and try again.',
    500: 'Anthropic service error. Try again later.',
    502: 'Anthropic is temporarily unavailable.',
    503: 'Anthropic is overloaded. Try again later.',
  },
  gemini: {
    401: 'Invalid Gemini API key. Check your GEMINI_API_KEY.',
    403: 'Access denied. Your API key may not have permission for this model.',
    429: 'Rate limit exceeded. Wait a moment and try again.',
    500: 'Gemini service error. Try again later.',
    502: 'Gemini is temporarily unavailable.',
    503: 'Gemini is overloaded. Try again later.',
  },
  ollama: {
    401: 'Authentication error (Ollama typically does not require auth)',
    404: 'Model not found. Run: ollama pull <model>',
    500: 'Ollama server error',
    502: 'Cannot connect to Ollama. Is it running?',
  },
}

const DEFAULT = 'LLM provider error. Check your API key and try again.'

function isHtml(text: string): boolean {
  const t = text.trim().toLowerCase()
  return t.startsWith('<!doctype') || t.startsWith('<html')
}

function sanitize(msg: string): string {
  if (msg.length > 200) msg = msg.slice(0, 200) + '...'
  return msg.replace(/https?:\/\/[^\s]+/g, '[URL]').trim()
}

function parseOpenAI(text: string, status: number): string {
  try {
    const p = JSON.parse(text) as OpenAIError
    if (p.error?.message) return sanitize(p.error.message)
  } catch {}
  return FALLBACKS.openai[status] || DEFAULT
}

function parseAnthropic(text: string, status: number): string {
  try {
    const p = JSON.parse(text) as AnthropicError
    const msg = p.error?.message || p.message
    if (msg) return sanitize(msg)
  } catch {}
  return FALLBACKS.anthropic[status] || DEFAULT
}

function parseGemini(text: string, status: number): string {
  try {
    const p = JSON.parse(text) as GeminiError
    if (p.error?.message) return sanitize(p.error.message)
  } catch {}
  return FALLBACKS.gemini[status] || DEFAULT
}

function parseOllama(text: string, status: number): string {
  // Ollama uses OpenAI-compatible error format
  try {
    const p = JSON.parse(text) as OpenAIError
    const msg = p.error?.message || (typeof p.error === 'string' ? p.error : null)
    if (msg) return sanitize(msg)
  } catch {}
  return FALLBACKS.ollama[status] || DEFAULT
}

export function parseLlmError(
  provider: 'openai' | 'anthropic' | 'gemini' | 'ollama',
  text: string,
  status: number
): CliError {
  if (isHtml(text)) {
    return new CliError(`${provider} error: ${FALLBACKS[provider][status] || DEFAULT}`)
  }

  const msg = provider === 'openai' ? parseOpenAI(text, status)
    : provider === 'anthropic' ? parseAnthropic(text, status)
    : provider === 'ollama' ? parseOllama(text, status)
    : parseGemini(text, status)

  const display = provider.charAt(0).toUpperCase() + provider.slice(1)
  return new CliError(`${display} API error: ${msg}`)
}
