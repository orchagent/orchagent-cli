// Export types
export * from './types'

// Export utilities
export { normalizeAgentName, mapModelToAlias } from './utils'

// Export registry
import { adapterRegistry } from './registry'
export { AdapterRegistry, adapterRegistry } from './registry'

// Import and register adapters
import { claudeCodeAdapter } from './claude-code'
export { claudeCodeAdapter } from './claude-code'

import { cursorAdapter } from './cursor'
export { cursorAdapter } from './cursor'

import { agentsMdAdapter } from './agents-md'
export { agentsMdAdapter } from './agents-md'

// Register built-in adapters
adapterRegistry.register(claudeCodeAdapter)
adapterRegistry.register(cursorAdapter)
adapterRegistry.register(agentsMdAdapter)
