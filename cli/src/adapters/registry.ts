import type { FormatAdapter, CanonicalAgent } from './types'

export class AdapterRegistry {
  private adapters: Map<string, FormatAdapter> = new Map()

  /**
   * Register an adapter
   */
  register(adapter: FormatAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Adapter '${adapter.id}' is already registered`)
    }
    this.adapters.set(adapter.id, adapter)
  }

  /**
   * Get adapter by ID
   */
  get(id: string): FormatAdapter | undefined {
    return this.adapters.get(id)
  }

  /**
   * List all registered adapters
   */
  list(): FormatAdapter[] {
    return Array.from(this.adapters.values())
  }

  /**
   * Find adapters compatible with an agent
   */
  findCompatible(agent: CanonicalAgent): FormatAdapter[] {
    return this.list().filter(adapter => {
      const result = adapter.canConvert(agent)
      return result.canConvert
    })
  }

  /**
   * Check if an adapter ID is valid
   */
  has(id: string): boolean {
    return this.adapters.has(id)
  }

  /**
   * Get all adapter IDs
   */
  getIds(): string[] {
    return Array.from(this.adapters.keys())
  }
}

// Global registry instance
export const adapterRegistry = new AdapterRegistry()
