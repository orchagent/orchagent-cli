import { Command } from 'commander'
import open from 'open'

import { getResolvedConfig } from '../lib/config'
import { request } from '../lib/api'

export function registerBillingCommand(program: Command): void {
  program
    .command('billing')
    .description('Open billing portal in your browser')
    .action(async () => {
      const resolved = await getResolvedConfig()

      if (!resolved.apiKey) {
        process.stderr.write('Not logged in. Run: orch login\n')
        process.exit(1)
      }

      // Get the billing portal URL from the gateway
      try {
        const data = await request<{ url: string }>(resolved, 'GET', '/billing/portal')
        process.stdout.write('Opening billing portal...\n')
        await open(data.url)
        process.stdout.write(`If browser doesn't open, visit:\n${data.url}\n`)
      } catch {
        // Fallback to direct web URL
        const webUrl = resolved.apiUrl.replace('api.', '').replace('/v1', '')
        const url = `${webUrl}/settings/billing`
        process.stdout.write('Opening billing page...\n')
        await open(url)
        process.stdout.write(`If browser doesn't open, visit:\n${url}\n`)
      }
    })
}
