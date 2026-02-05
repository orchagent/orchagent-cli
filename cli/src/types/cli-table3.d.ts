declare module 'cli-table3' {
  class Table {
    constructor(options?: Record<string, unknown>)
    push(...rows: unknown[]): void
    toString(): string
  }

  export default Table
}
