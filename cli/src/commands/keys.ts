import { Command } from 'commander'
import * as readline from 'readline'

import { getResolvedConfig } from '../lib/config'
import { request } from '../lib/api'
import { CliError } from '../lib/errors'
import type { ResolvedConfig } from '../types'

const VALID_PROVIDERS = ['openai', 'anthropic', 'gemini', 'ollama'] as const
type Provider = (typeof VALID_PROVIDERS)[number]

type UserLlmKey = {
  provider: string
  has_custom_endpoint: boolean
  created_at: string
  updated_at: string
}

async function promptForKey(provider: string): Promise<string> {
  // Use hidden input to avoid exposing keys in terminal history/logs
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    // Mask input by not echoing characters
    process.stdout.write(`Enter API key for ${provider}: `)

    if (process.stdin.isTTY) {
      // For TTY, read without echo
      const stdin = process.stdin
      stdin.setRawMode(true)
      stdin.resume()
      stdin.setEncoding('utf8')

      let key = ''
      const onData = (char: string) => {
        if (char === '\n' || char === '\r') {
          stdin.setRawMode(false)
          stdin.removeListener('data', onData)
          rl.close()
          process.stdout.write('\n')
          resolve(key.trim())
        } else if (char === '\u0003') {
          // Ctrl+C
          stdin.setRawMode(false)
          rl.close()
          reject(new CliError('Cancelled'))
        } else if (char === '\u007F' || char === '\b') {
          // Backspace
          if (key.length > 0) {
            key = key.slice(0, -1)
          }
        } else {
          key += char
        }
      }
      stdin.on('data', onData)
    } else {
      // Non-TTY (piped input), just read normally
      rl.question('', (answer) => {
        rl.close()
        resolve(answer.trim())
      })
    }
  })
}

async function addKey(
  config: ResolvedConfig,
  provider: Provider,
  options: { key?: string; endpoint?: string }
): Promise<void> {
  let apiKey = options.key

  if (!apiKey) {
    apiKey = await promptForKey(provider)
  }

  if (!apiKey) {
    throw new CliError('API key is required')
  }

  await request(config, 'POST', '/llm-keys', {
    body: JSON.stringify({
      provider,
      api_key: apiKey,
      endpoint_url: options.endpoint,
    }),
    headers: { 'Content-Type': 'application/json' },
  })

  process.stdout.write(`Saved ${provider} API key.\n`)
}

async function listKeys(config: ResolvedConfig): Promise<void> {
  const keys = await request<UserLlmKey[]>(config, 'GET', '/llm-keys')

  if (keys.length === 0) {
    process.stdout.write('No LLM keys configured.\n')
    process.stdout.write('\nAdd a key with: orchagent keys add <provider>\n')
    process.stdout.write('Providers: openai, anthropic, gemini, ollama\n')
    return
  }

  process.stdout.write('Configured LLM keys:\n\n')
  for (const key of keys) {
    const endpoint = key.has_custom_endpoint ? ' (custom endpoint)' : ''
    process.stdout.write(`  ${key.provider}${endpoint}\n`)
  }
  process.stdout.write('\n')
}

async function removeKey(config: ResolvedConfig, provider: Provider): Promise<void> {
  await request(config, 'DELETE', `/llm-keys/${provider}`)
  process.stdout.write(`Removed ${provider} API key.\n`)
}

export function registerKeysCommand(program: Command): void {
  const keys = program
    .command('keys')
    .description('Manage LLM API keys for calling agents')

  keys
    .command('add <provider>')
    .description('Add or update an LLM API key')
    .option('--key <key>', 'API key (will prompt if not provided)')
    .option('--endpoint <url>', 'Custom endpoint URL (enterprise proxy or self-hosted model)')
    .action(async (provider: string, options: { key?: string; endpoint?: string }) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orchagent login` first.')
      }

      if (!VALID_PROVIDERS.includes(provider as Provider)) {
        throw new CliError(
          `Invalid provider: ${provider}. Valid providers: ${VALID_PROVIDERS.join(', ')}`
        )
      }

      await addKey(config, provider as Provider, options)
    })

  keys
    .command('list')
    .description('List configured LLM API keys')
    .action(async () => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orchagent login` first.')
      }

      await listKeys(config)
    })

  keys
    .command('remove <provider>')
    .description('Remove an LLM API key')
    .action(async (provider: string) => {
      const config = await getResolvedConfig()
      if (!config.apiKey) {
        throw new CliError('Missing API key. Run `orchagent login` first.')
      }

      if (!VALID_PROVIDERS.includes(provider as Provider)) {
        throw new CliError(
          `Invalid provider: ${provider}. Valid providers: ${VALID_PROVIDERS.join(', ')}`
        )
      }

      await removeKey(config, provider as Provider)
    })
}
