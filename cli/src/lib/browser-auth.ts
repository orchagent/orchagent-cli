import http from 'http'
import open from 'open'
import { CliError } from './errors'
import { parseAuthError } from './auth-errors'

const DEFAULT_PORT = 8374
const AUTH_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

interface InitResponse {
  state: string
  auth_url: string
}

interface ExchangeResponse {
  org_id: string
  org_slug: string
  org_name: string
  api_key: string
  api_key_prefix: string
}

export interface BrowserAuthResult {
  apiKey: string
  orgSlug: string
  orgName: string
}

/**
 * Perform browser-based OAuth authentication.
 *
 * 1. Starts a local HTTP server to receive the callback
 * 2. Opens the browser to the auth URL
 * 3. Waits for the callback with the one-time token
 * 4. Exchanges the token for an API key
 */
export async function browserAuthFlow(
  apiUrl: string,
  port: number = DEFAULT_PORT
): Promise<BrowserAuthResult> {
  // Step 1: Initialize the auth flow
  const initResponse = await fetch(`${apiUrl}/auth/cli-init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_port: port }),
  })

  if (!initResponse.ok) {
    throw await parseAuthError(initResponse, 'init')
  }

  const { auth_url }: InitResponse = await initResponse.json()

  // Step 2: Start local server and wait for callback
  const token = await waitForCallback(port, AUTH_TIMEOUT_MS)

  // Step 3: Exchange token for API key
  const exchangeResponse = await fetch(`${apiUrl}/auth/cli-exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })

  if (!exchangeResponse.ok) {
    throw await parseAuthError(exchangeResponse, 'exchange')
  }

  const result: ExchangeResponse = await exchangeResponse.json()

  // Step 4: Open browser (do this after server is ready but before waiting)
  // Actually we need to open browser earlier, let's restructure

  return {
    apiKey: result.api_key,
    orgSlug: result.org_slug,
    orgName: result.org_name,
  }
}

/**
 * Start a local HTTP server, open the browser, and wait for the callback.
 */
async function waitForCallback(port: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let resolved = false
    let server: http.Server | null = null

    const cleanup = () => {
      if (server) {
        server.closeAllConnections()
        server.close()
        server = null
      }
    }

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        cleanup()
        reject(new CliError('Authentication timed out. Please try again.'))
      }
    }, timeoutMs)

    server = http.createServer((req, res) => {
      // Only handle GET /callback
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`)

      if (url.pathname !== '/callback') {
        res.writeHead(404)
        res.end('Not Found')
        return
      }

      const token = url.searchParams.get('token')

      if (!token) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(errorHtml('Missing token parameter'))
        return
      }

      // Success!
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(successHtml())

      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        cleanup()
        resolve(token)
      }
    })

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        cleanup()
        if (err.code === 'EADDRINUSE') {
          reject(new CliError(`Port ${port} is already in use. Try a different port with --port.`))
        } else {
          reject(new CliError(`Failed to start auth server: ${err.message}`))
        }
      }
    })

    // Bind to localhost only for security
    server.listen(port, '127.0.0.1', () => {
      // Server is ready
    })
  })
}

/**
 * Open browser and wait for callback token.
 */
export async function startBrowserAuth(
  apiUrl: string,
  port: number = DEFAULT_PORT
): Promise<BrowserAuthResult> {
  // Step 1: Initialize the auth flow
  const initResponse = await fetch(`${apiUrl}/auth/cli-init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_port: port }),
  })

  if (!initResponse.ok) {
    throw await parseAuthError(initResponse, 'init')
  }

  const { auth_url }: InitResponse = await initResponse.json()

  // Step 2: Start local server to receive callback
  const tokenPromise = waitForCallback(port, AUTH_TIMEOUT_MS)

  // Step 3: Open browser
  try {
    await open(auth_url)
  } catch {
    // If browser fails to open, show the URL for manual opening
    process.stdout.write(`\nPlease open this URL in your browser:\n${auth_url}\n\n`)
  }

  // Step 4: Wait for callback
  const token = await tokenPromise

  // Step 5: Exchange token for API key
  const exchangeResponse = await fetch(`${apiUrl}/auth/cli-exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })

  if (!exchangeResponse.ok) {
    throw await parseAuthError(exchangeResponse, 'exchange')
  }

  const result: ExchangeResponse = await exchangeResponse.json()

  return {
    apiKey: result.api_key,
    orgSlug: result.org_slug,
    orgName: result.org_name,
  }
}

function successHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>orchagent CLI - Authentication Successful</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: #0a0a0a;
      color: #fafafa;
    }
    .container {
      text-align: center;
      padding: 2rem;
    }
    .icon {
      width: 64px;
      height: 64px;
      background: rgba(34, 197, 94, 0.1);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 1.5rem;
    }
    .icon svg {
      width: 32px;
      height: 32px;
      color: #22c55e;
    }
    h1 {
      font-size: 1.5rem;
      margin: 0 0 0.5rem;
    }
    p {
      color: #a1a1aa;
      margin: 0;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
      </svg>
    </div>
    <h1>Authentication Successful</h1>
    <p>You can close this tab and return to your terminal.</p>
  </div>
</body>
</html>`
}

function errorHtml(message: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>orchagent CLI - Authentication Error</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: #0a0a0a;
      color: #fafafa;
    }
    .container {
      text-align: center;
      padding: 2rem;
    }
    .icon {
      width: 64px;
      height: 64px;
      background: rgba(239, 68, 68, 0.1);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 1.5rem;
    }
    .icon svg {
      width: 32px;
      height: 32px;
      color: #ef4444;
    }
    h1 {
      font-size: 1.5rem;
      margin: 0 0 0.5rem;
    }
    p {
      color: #a1a1aa;
      margin: 0;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
      </svg>
    </div>
    <h1>Authentication Error</h1>
    <p>${message}</p>
  </div>
</body>
</html>`
}
