export function isPaidAgent(agent: {
  pricing_mode?: string | null
  price_per_call_cents?: number | null
}): boolean {
  // Fail-closed: per_call mode with missing or >0 price is paid
  if (agent.pricing_mode === 'per_call') {
    const price = agent.price_per_call_cents
    return price === null || price === undefined || price > 0
  }
  return false
}

export function formatPrice(agent: {
  pricing_mode?: string | null
  price_per_call_cents?: number | null
}): string {
  if (!isPaidAgent(agent)) {
    return 'FREE'
  }
  const price = agent.price_per_call_cents
  if (!price) {
    return 'PAID (server-only)'  // Fail-closed message
  }
  return `$${(price / 100).toFixed(2)}/call`
}
