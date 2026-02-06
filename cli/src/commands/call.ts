import { Command } from 'commander'
import fs from 'fs/promises'
import path from 'path'

import { getResolvedConfig, loadConfig, getDefaultProvider } from '../lib/config'
import { getAgentWithFallback, safeFetchWithRetryForCalls, getCreditsBalance, getOrg } from '../lib/api'
import { CliError, jsonInputError, ExitCodes } from '../lib/errors'
import { printJson } from '../lib/output'
import { createSpinner, withSpinner } from '../lib/spinner'
import { detectLlmKey, validateProvider, type LlmProvider } from '../lib/llm'
import { track } from '../lib/analytics'
import { isPaidAgent, formatPrice } from '../lib/pricing'

const DEFAULT_VERSION = 'latest'

// Well-known field names for file content in prompt agent schemas (priority order)
const CONTENT_FIELD_NAMES = ['code', 'content', 'text', 'source', 'input', 'file_content', 'body']

// Keys that might indicate local file path references in JSON payloads
const LOCAL_PATH_KEYS = ['path', 'directory', 'file', 'filepath', 'dir', 'folder', 'local']

/**
 * Check if a parsed JSON object contains keys that might reference local filesystem paths.
 * Returns the first matching key found, or undefined if none found.
 */
function findLocalPathKey(obj: unknown): string | undefined {
  if (typeof obj !== 'object' || obj === null) {
    return undefined
  }
  const keys = Object.keys(obj as Record<string, unknown>)
  for (const key of keys) {
    if (LOCAL_PATH_KEYS.includes(key.toLowerCase())) {
      return key
    }
  }
  return undefined
}

/**
 * Emit a warning to stderr if the payload contains local path references.
 */
function warnIfLocalPathReference(jsonBody: string): void {
  try {
    const parsed = JSON.parse(jsonBody)
    const pathKey = findLocalPathKey(parsed)
    if (pathKey) {
      process.stderr.write(
        `Warning: Your payload contains a local path reference ('${pathKey}').\n` +
        `Remote agents cannot access your local filesystem. The path will be interpreted\n` +
        `by the server, not your local machine.\n\n` +
        `Tip: Use 'orchagent run <agent>' instead to execute locally with filesystem access.\n\n`
      )
    }
  } catch {
    // If parsing fails, skip the warning (the actual error will be thrown later)
  }
}

/**
 * Infer the best JSON field name for file content based on the agent's input schema.
 * Returns the field name to use, or 'content' as a safe default.
 */
function inferFileField(inputSchema?: object): string {
  if (!inputSchema || typeof inputSchema !== 'object') return 'content'
  const props = (inputSchema as Record<string, unknown>).properties
  if (!props || typeof props !== 'object') return 'content'

  const properties = props as Record<string, { type?: string }>

  // Check for well-known field names in priority order
  for (const field of CONTENT_FIELD_NAMES) {
    if (properties[field] && properties[field].type === 'string') return field
  }

  // If there's exactly one required string property, use that
  const required = ((inputSchema as Record<string, unknown>).required ?? []) as string[]
  const stringProps = Object.entries(properties)
    .filter(([, v]) => v.type === 'string')
    .map(([k]) => k)

  if (stringProps.length === 1) return stringProps[0]

  const requiredStrings = stringProps.filter(k => required.includes(k))
  if (requiredStrings.length === 1) return requiredStrings[0]

  return 'content'
}

type AgentRef = {
  org?: string
  agent: string
  version: string
}

function parseAgentRef(value: string): AgentRef {
  const [ref, versionPart] = value.split('@')
  const version = versionPart?.trim() || DEFAULT_VERSION
  const segments = ref.split('/')
  if (segments.length === 1) {
    return { agent: segments[0], version }
  }
  if (segments.length === 2) {
    return { org: segments[0], agent: segments[1], version }
  }
  throw new CliError('Invalid agent reference. Use org/agent or agent format.')
}

async function readStdin(): Promise<Buffer | null> {
  if (process.stdin.isTTY) return null
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk))
  }
  if (!chunks.length) return null
  return Buffer.concat(chunks)
}

async function buildMultipartBody(
  filePaths: string[] | undefined,
  metadata?: string
): Promise<{ body?: FormData; sourceLabel?: string }> {
  if (!filePaths || filePaths.length === 0) {
    const stdinData = await readStdin()
    if (stdinData) {
      const form = new FormData()
      form.append('files[]', new Blob([new Uint8Array(stdinData)]), 'stdin')
      if (metadata) {
        form.append('metadata', metadata)
      }
      return { body: form, sourceLabel: 'stdin' }
    }
    if (metadata) {
      const form = new FormData()
      form.append('metadata', metadata)
      return { body: form, sourceLabel: 'metadata' }
    }
    return {}
  }

  const form = new FormData()
  for (const filePath of filePaths) {
    const buffer = await fs.readFile(filePath)
    const filename = path.basename(filePath)
    form.append('files[]', new Blob([new Uint8Array(buffer)]), filename)
  }

  if (metadata) {
    form.append('metadata', metadata)
  }

  return {
    body: form,
    sourceLabel: filePaths.length === 1 ? filePaths[0] : `${filePaths.length} files`,
  }
}

async function resolveJsonBody(input: string): Promise<string> {
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
      raw = await fs.readFile(source, 'utf8')
    }
  }

  try {
    return JSON.stringify(JSON.parse(raw))
  } catch {
    throw jsonInputError('data')
  }
}

export function registerCallCommand(program: Command): void {
  program
    .command('call <agent> [file]')
    .description('Call an agent on the server (may incur charges for paid agents)')
    .option('--endpoint <endpoint>', 'Override agent endpoint')
    .option('--tenant <tenant>', 'Tenant identifier for multi-tenant callers')
    .option('--data <json>', 'JSON payload (string or @file, @- for stdin)')
    .option('--input <json>', 'Alias for --data')
    .option('--key <key>', 'LLM API key (overrides env vars)')
    .option('--provider <provider>', 'LLM provider (openai, anthropic, gemini)')
    .option('--model <model>', 'LLM model to use (overrides agent default)')
    .option('--json', 'Output raw JSON')
    .option('--output <file>', 'Save response body to a file')
    .option('--skills <skills>', 'Add skills (comma-separated)')
    .option('--skills-only <skills>', 'Use only these skills')
    .option('--no-skills', 'Ignore default skills')
    .option('--file <path...>', 'File(s) to upload (can specify multiple)')
    .option('--file-field <field>', 'Schema field name for file content (prompt agents)')
    .option('--metadata <json>', 'JSON metadata to send with files')
    .addHelpText('after', `
Examples:
  orch call orchagent/invoice-scanner invoice.pdf
  orch call orchagent/useeffect-checker --file src/App.tsx
  orch call orchagent/useeffect-checker --file src/App.tsx --file-field code
  orch call orchagent/leak-finder --data '{"repo_url": "https://github.com/org/repo"}'
  cat input.json | orch call acme/agent --data @-
  orch call acme/image-processor photo.jpg --output result.png

Note: Use 'call' for server-side execution (requires login), 'run' for local execution.

File handling:
  For prompt agents, file content is read and sent as JSON mapped to the agent's
  input schema. Use --file-field to specify the field name (auto-detected by default).
  For code agents, files are uploaded as multipart form data.

Important: Remote agents cannot access your local filesystem. If your --data payload
contains keys like 'path', 'directory', 'file', etc., those values will be interpreted
by the server, not your local machine. To send local files, use the positional file
argument or --file option instead.

Paid Agents:
  Paid agents charge per call and deduct from your prepaid credits.
  Check your balance: orch billing balance
  Add credits: orch billing add 5

  Same-author calls are FREE - you won't be charged for calling your own agents.
`)
    .action(
      async (
        agentRef: string,
        file: string | undefined,
        options: {
          endpoint?: string
          tenant?: string
          data?: string
          input?: string
          key?: string
          provider?: string
          model?: string
          json?: boolean
          output?: string
          skills?: string
          skillsOnly?: string
          noSkills?: boolean
          file?: string[]
          fileField?: string
          metadata?: string
        }
      ) => {
        // Merge --input alias into --data
        const dataValue = options.data || options.input
        options.data = dataValue

        const resolved = await getResolvedConfig()
        if (!resolved.apiKey) {
          throw new CliError('Missing API key. Run `orchagent login` first.')
        }

        const parsed = parseAgentRef(agentRef)
        const configFile = await loadConfig()
        const org = parsed.org ?? configFile.workspace ?? resolved.defaultOrg
        if (!org) {
          throw new CliError('Missing org. Use org/agent or set default org.')
        }

        const agentMeta = await getAgentWithFallback(
          resolved,
          org,
          parsed.agent,
          parsed.version
        )

        // Part 1: Pre-call balance check for paid agents
        let pricingInfo: { price_cents: number | null } | undefined
        if (isPaidAgent(agentMeta)) {
          // Detect ownership: compare agent's org with caller's org
          let isOwner = false
          try {
            const callerOrg = await getOrg(resolved)
            // Use org_id when available (preferred), org_slug as fallback
            const agentOrgId = agentMeta.org_id
            const agentOrgSlug = agentMeta.org_slug
            if (agentOrgId && callerOrg.id === agentOrgId) {
              isOwner = true
            } else if (agentOrgSlug && callerOrg.slug === agentOrgSlug) {
              isOwner = true
            }
          } catch {
            // If we can't determine ownership, treat as non-owner (fail-safe)
            isOwner = false
          }

          if (isOwner) {
            // Owner: show free message, no balance check needed
            if (!options.json) process.stderr.write(`Cost: FREE (author)\n\n`)
          } else {
            // Non-owner: check balance
            const price = agentMeta.price_per_call_cents
            pricingInfo = { price_cents: price ?? null }

            if (!price || price <= 0) {
              // Price missing or invalid - warn but proceed (server will enforce)
              if (!options.json) process.stderr.write(`Warning: Pricing data unavailable. The server will verify payment.\n\n`)
            } else {
              // Valid price - check balance
              try {
                const balanceData = await getCreditsBalance(resolved)
                const balance = balanceData.balance_cents

                if (balance < price) {
                  // Insufficient balance
                  process.stderr.write(
                    `Insufficient credits:\n` +
                    `  Balance:  $${(balance / 100).toFixed(2)}\n` +
                    `  Required: $${(price / 100).toFixed(2)}\n\n` +
                    `Add credits:\n` +
                    `  orch billing add 5\n` +
                    `  orch billing balance  # check current balance\n`
                  )
                  process.exit(ExitCodes.PERMISSION_DENIED)
                }

                // Sufficient balance - show cost preview
                if (!options.json) process.stderr.write(`Cost: $${(price / 100).toFixed(2)}/call\n\n`)
              } catch (err) {
                // Balance check failed - warn but proceed (server will enforce)
                if (!options.json) process.stderr.write(`Warning: Could not verify balance. The server will check payment.\n\n`)
              }
            }
          }
        }

        const endpoint =
          options.endpoint?.trim() || agentMeta.default_endpoint || 'analyze'

        const headers: Record<string, string> = {
          Authorization: `Bearer ${resolved.apiKey}`,
        }
        if (options.tenant) {
          headers['X-OrchAgent-Tenant'] = options.tenant
        }

        const supportedProviders = agentMeta.supported_providers || ['any']
        let llmKey: string | undefined
        let llmProvider: string | undefined

        // Resolve effective provider: CLI flag > config default
        const configDefaultProvider = await getDefaultProvider()
        const effectiveProvider = options.provider ?? configDefaultProvider

        if (options.key) {
          // Explicit key provided - require provider
          if (!effectiveProvider) {
            throw new CliError(
              'When using --key, you must also specify --provider (openai, anthropic, or gemini)'
            )
          }
          validateProvider(effectiveProvider)
          // Warn on potential model/provider mismatch
          if (options.model && effectiveProvider) {
            const modelLower = options.model.toLowerCase()
            const providerPatterns: Record<string, RegExp> = {
              openai: /^(gpt-|o1-|o3-|davinci|text-)/,
              anthropic: /^claude-/,
              gemini: /^gemini-/,
              ollama: /^(llama|mistral|deepseek|phi|qwen)/,
            }
            const expectedPattern = providerPatterns[effectiveProvider]
            if (expectedPattern && !expectedPattern.test(modelLower)) {
              process.stderr.write(
                `Warning: Model '${options.model}' may not be a ${effectiveProvider} model.\n\n`
              )
            }
          }
          llmKey = options.key
          llmProvider = effectiveProvider
        } else {
          // Try to detect from environment or server
          // If provider specified (flag or config default), prioritize that provider
          let providersToCheck = supportedProviders as LlmProvider[]
          if (effectiveProvider) {
            validateProvider(effectiveProvider)
            providersToCheck = [effectiveProvider as LlmProvider]
            // Warn on potential model/provider mismatch
            if (options.model) {
              const modelLower = options.model.toLowerCase()
              const providerPatterns: Record<string, RegExp> = {
                openai: /^(gpt-|o1-|o3-|davinci|text-)/,
                anthropic: /^claude-/,
                gemini: /^gemini-/,
                ollama: /^(llama|mistral|deepseek|phi|qwen)/,
              }
              const expectedPattern = providerPatterns[effectiveProvider]
              if (expectedPattern && !expectedPattern.test(modelLower)) {
                process.stderr.write(
                  `Warning: Model '${options.model}' may not be a ${effectiveProvider} model.\n\n`
                )
              }
            }
          }
          const detected = await detectLlmKey(providersToCheck, resolved)
          if (detected) {
            llmKey = detected.key
            llmProvider = detected.provider
          }
        }

        // LLM credentials will be added to request body (not headers) for security
        // Headers can be logged by proxies/load balancers, body is not logged by default
        let llmCredentials: { api_key: string; provider: string; model?: string } | undefined
        if (llmKey && llmProvider) {
          llmCredentials = {
            api_key: llmKey,
            provider: llmProvider,
            ...(options.model && { model: options.model }),
          }
        } else if (agentMeta.type === 'prompt') {
          // Warn if no key found for prompt-based agent
          const searchedProviders = effectiveProvider ? [effectiveProvider] : supportedProviders
          const providerList = searchedProviders.join(', ')
          process.stderr.write(
            `Warning: No LLM key found for provider(s): ${providerList}\n` +
            `Set an env var (e.g., OPENAI_API_KEY), run 'orchagent keys add <provider>', use --key, or configure in web dashboard\n\n`
          )
        }

        // Add skill headers
        if (options.skills) {
          headers['X-OrchAgent-Skills'] = options.skills
        }
        if (options.skillsOnly) {
          headers['X-OrchAgent-Skills-Only'] = options.skillsOnly
        }
        if (options.noSkills) {
          headers['X-OrchAgent-No-Skills'] = 'true'
        }

        let body: BodyInit | undefined
        let sourceLabel: string | undefined
        const filePaths = [
          ...(options.file ?? []),
          ...(file ? [file] : []),
        ]
        if (options.data) {
          if (filePaths.length > 0 || options.metadata) {
            throw new CliError('Cannot use --data with file uploads or --metadata.')
          }
          // Parse JSON and inject llm_credentials if available
          const resolvedBody = await resolveJsonBody(options.data)
          // Warn if payload contains local path references
          warnIfLocalPathReference(resolvedBody)
          if (llmCredentials) {
            const bodyObj = JSON.parse(resolvedBody)
            bodyObj.llm_credentials = llmCredentials
            body = JSON.stringify(bodyObj)
          } else {
            body = resolvedBody
          }
          headers['Content-Type'] = 'application/json'
        } else if ((filePaths.length > 0 || options.metadata) && agentMeta.type === 'prompt') {
          // Prompt agent + files/metadata: read content and send as JSON
          const fieldName = options.fileField || inferFileField(agentMeta.input_schema as object | undefined)
          let bodyObj: Record<string, unknown> = {}

          // Include metadata if provided
          if (options.metadata) {
            try {
              bodyObj = JSON.parse(options.metadata)
            } catch {
              throw new CliError('--metadata must be valid JSON.')
            }
          }

          if (filePaths.length === 1) {
            // Single file: map content to the inferred/specified schema field
            const fileContent = await fs.readFile(filePaths[0], 'utf-8')
            bodyObj[fieldName] = fileContent
            sourceLabel = filePaths[0]
          } else if (filePaths.length > 1) {
            // Multiple files: map first to the schema field, add all as files object
            const allContents: Record<string, string> = {}
            for (const fp of filePaths) {
              allContents[path.basename(fp)] = await fs.readFile(fp, 'utf-8')
            }
            // Set the primary field to the first file's content
            const firstContent = await fs.readFile(filePaths[0], 'utf-8')
            bodyObj[fieldName] = firstContent
            bodyObj.files = allContents
            sourceLabel = `${filePaths.length} files`
          }

          if (llmCredentials) {
            bodyObj.llm_credentials = llmCredentials
          }
          body = JSON.stringify(bodyObj)
          headers['Content-Type'] = 'application/json'
        } else if (filePaths.length > 0 || options.metadata) {
          // Code agent: handle multipart file uploads
          // Inject llm_credentials into metadata if available
          let metadata = options.metadata
          if (llmCredentials) {
            const metaObj = metadata ? JSON.parse(metadata) : {}
            metaObj.llm_credentials = llmCredentials
            metadata = JSON.stringify(metaObj)
          }
          const multipart = await buildMultipartBody(filePaths, metadata)
          body = multipart.body
          sourceLabel = multipart.sourceLabel
        } else if (llmCredentials) {
          // No data or files, but we have LLM credentials - send as JSON body
          body = JSON.stringify({ llm_credentials: llmCredentials })
          headers['Content-Type'] = 'application/json'
        } else {
          // No data, files, or credentials - check for stdin
          const multipart = await buildMultipartBody(undefined, options.metadata)
          body = multipart.body
          sourceLabel = multipart.sourceLabel
        }

        const url = `${resolved.apiUrl.replace(/\/$/, '')}/${org}/${parsed.agent}/${parsed.version}/${endpoint}`

        // Make the API call with a spinner (suppress in --json mode for clean machine-readable output)
        const spinner = options.json ? null : createSpinner(`Calling ${org}/${parsed.agent}@${parsed.version}...`)
        spinner?.start()

        let response: Response
        try {
          response = await safeFetchWithRetryForCalls(url, {
            method: 'POST',
            headers,
            body,
          })
        } catch (err) {
          spinner?.fail(`Call failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
          throw err
        }

        if (!response.ok) {
          const text = await response.text()
          let payload: unknown
          try {
            payload = JSON.parse(text)
          } catch {
            payload = text
          }

          // Handle specific error codes with helpful messages
          const errorCode =
            typeof payload === 'object' && payload
              ? (payload as { error?: { code?: string } }).error?.code
              : undefined

          // Part 2: Handle 402 Payment Required
          if (response.status === 402 || errorCode === 'INSUFFICIENT_CREDITS') {
            spinner?.fail('Insufficient credits')
            let errorMessage = 'Insufficient credits to call this agent.\n\n'

            // Use pricing info from pre-call check if available
            if (pricingInfo?.price_cents) {
              errorMessage += `This agent costs $${(pricingInfo.price_cents / 100).toFixed(2)} per call.\n\n`
            }

            errorMessage +=
              'Add credits:\n' +
              '  orch billing add 5\n' +
              '  orch billing balance  # check current balance\n'

            throw new CliError(errorMessage, ExitCodes.PERMISSION_DENIED)
          }

          if (errorCode === 'LLM_KEY_REQUIRED') {
            spinner?.fail('LLM key required')
            throw new CliError(
              'This public agent requires you to provide an LLM key.\n' +
                'Use --key <key> --provider <provider> or set OPENAI_API_KEY/ANTHROPIC_API_KEY env var.'
            )
          }

          if (errorCode === 'LLM_RATE_LIMITED') {
            const rateLimitMsg =
              typeof payload === 'object' && payload
                ? (payload as { error?: { message?: string } }).error?.message || 'Rate limit exceeded'
                : 'Rate limit exceeded'
            spinner?.fail('Rate limited by LLM provider')
            throw new CliError(
              rateLimitMsg + '\n\n' +
                'This is the LLM provider\'s rate limit on your API key, not an OrchAgent limit.\n' +
                'To switch providers: orch call <agent> --provider <gemini|anthropic|openai>',
              ExitCodes.RATE_LIMITED
            )
          }

          const message =
            typeof payload === 'object' && payload
              ? (payload as { error?: { message?: string }; message?: string }).error
                  ?.message ||
                (payload as { message?: string }).message ||
                response.statusText
              : response.statusText
          spinner?.fail(`Call failed: ${message}`)
          throw new CliError(message)
        }

        spinner?.succeed(`Called ${org}/${parsed.agent}@${parsed.version}`)

        // After successful call, if it was a paid agent, show cost (suppress in --json mode)
        if (!options.json && isPaidAgent(agentMeta) && pricingInfo?.price_cents && pricingInfo.price_cents > 0) {
          process.stderr.write(`\nCost: $${(pricingInfo.price_cents / 100).toFixed(2)} USD\n`)
        }

        // Track successful call
        const inputType =
          filePaths.length > 0
            ? 'file'
            : options.data
              ? 'json'
              : sourceLabel === 'stdin'
                ? 'stdin'
                : sourceLabel === 'metadata'
                  ? 'metadata'
                  : 'empty'
        await track('cli_call', {
          agent: `${org}/${parsed.agent}@${parsed.version}`,
          input_type: inputType,
        })

        if (options.output) {
          const buffer = Buffer.from(await response.arrayBuffer())
          await fs.writeFile(options.output, buffer)
          process.stdout.write(`Saved response to ${options.output}\n`)
          return
        }

        const text = await response.text()
        let payload: unknown
        try {
          payload = JSON.parse(text)
        } catch {
          payload = text
        }

        if (options.json) {
          if (typeof payload === 'string') {
            process.stdout.write(`${payload}\n`)
            return
          }
          printJson(payload)
          return
        }

        if (typeof payload === 'string') {
          process.stdout.write(`${payload}\n`)
          return
        }

        printJson(payload)
      }
    )
}
