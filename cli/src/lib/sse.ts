/**
 * Minimal SSE (Server-Sent Events) parser for ReadableStream<Uint8Array>.
 *
 * Parses an SSE byte stream into typed event objects. No external dependencies.
 * Works with Node 18+ native fetch ReadableStream.
 */

export interface SSEEvent {
  event: string
  data: string
}

export async function* parseSSE(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const parts = buffer.split('\n\n')
      buffer = parts.pop()!

      for (const part of parts) {
        if (!part.trim()) continue
        let event = 'message'
        let data = ''
        for (const line of part.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7)
          else if (line.startsWith('data: ')) data += (data ? '\n' : '') + line.slice(6)
        }
        if (data) yield { event, data }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
