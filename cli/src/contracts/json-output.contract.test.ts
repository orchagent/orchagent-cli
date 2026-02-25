import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const COMMANDS_EXPECTING_JSON = [
  'estimate.ts',
  'tree.ts',
  'pull.ts',
  'fork.ts',
  'diff.ts',
  'info.ts',
  'logs.ts',
  'trace.ts',
  'dag.ts',
  'replay.ts',
]

describe('json-output contract', () => {
  it('keeps --json support on high-automation commands', () => {
    const commandsDir = path.resolve(__dirname, '../commands')

    for (const file of COMMANDS_EXPECTING_JSON) {
      const content = fs.readFileSync(path.join(commandsDir, file), 'utf8')
      expect(content, `${file} should expose --json`).toContain('--json')
    }
  })
})
