import { PostHog } from 'posthog-node'
import { getResolvedConfig } from './config'

let client: PostHog | null = null

export function initPostHog(): void {
  if (process.env.POSTHOG_API_KEY) {
    client = new PostHog(process.env.POSTHOG_API_KEY, {
      host: 'https://us.i.posthog.com',
    })
  }
}

export async function shutdownPostHog(): Promise<void> {
  if (client) {
    await client.shutdown()
  }
}

export async function track(
  event: string,
  properties?: Record<string, unknown>
): Promise<void> {
  if (!client) return
  const config = await getResolvedConfig()
  const distinctId = config.defaultOrg || 'anonymous'
  client.capture({ distinctId, event, properties })
}
