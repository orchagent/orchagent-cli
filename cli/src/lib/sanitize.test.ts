import { describe, it, expect } from 'vitest'
import path from 'path'
import {
  rejectControlChars,
  rejectResourceIdChars,
  ensurePathInBounds,
  rejectPathTraversal,
  sanitizeSecretValue,
} from './sanitize'

describe('rejectControlChars', () => {
  it('accepts normal ASCII text', () => {
    expect(() => rejectControlChars('hello-world', 'test')).not.toThrow()
  })

  it('accepts text with allowed whitespace (newline, carriage return, tab)', () => {
    expect(() => rejectControlChars('line1\nline2', 'test')).not.toThrow()
    expect(() => rejectControlChars('col1\tcol2', 'test')).not.toThrow()
    expect(() => rejectControlChars('line\r\n', 'test')).not.toThrow()
  })

  it('accepts unicode text', () => {
    expect(() => rejectControlChars('café-agent', 'test')).not.toThrow()
    expect(() => rejectControlChars('日本語テスト', 'test')).not.toThrow()
  })

  it('rejects null byte', () => {
    expect(() => rejectControlChars('hello\x00world', 'test')).toThrow(/control character/)
  })

  it('rejects bell character', () => {
    expect(() => rejectControlChars('hello\x07world', 'test')).toThrow(/control character/)
  })

  it('rejects backspace', () => {
    expect(() => rejectControlChars('hello\x08world', 'test')).toThrow(/control character/)
  })

  it('rejects form feed', () => {
    expect(() => rejectControlChars('hello\x0Cworld', 'test')).toThrow(/control character/)
  })

  it('rejects escape character', () => {
    expect(() => rejectControlChars('hello\x1Bworld', 'test')).toThrow(/control character/)
  })

  it('rejects unit separator', () => {
    expect(() => rejectControlChars('hello\x1Fworld', 'test')).toThrow(/control character/)
  })

  it('includes field name in error message', () => {
    expect(() => rejectControlChars('bad\x00input', 'agent name')).toThrow(/agent name/)
  })

  it('rejects DEL character (0x7F)', () => {
    expect(() => rejectControlChars('hello\x7Fworld', 'test')).toThrow(/control character/)
  })
})

describe('rejectResourceIdChars', () => {
  it('accepts valid resource identifiers', () => {
    expect(() => rejectResourceIdChars('my-agent', 'agent name')).not.toThrow()
    expect(() => rejectResourceIdChars('joe', 'org name')).not.toThrow()
    expect(() => rejectResourceIdChars('v2', 'version')).not.toThrow()
    expect(() => rejectResourceIdChars('latest', 'version')).not.toThrow()
  })

  it('rejects question mark', () => {
    expect(() => rejectResourceIdChars('agent?foo=bar', 'agent name')).toThrow(/\?/)
  })

  it('rejects hash', () => {
    expect(() => rejectResourceIdChars('agent#section', 'agent name')).toThrow(/#/)
  })

  it('rejects percent (URL encoding)', () => {
    expect(() => rejectResourceIdChars('agent%2Fname', 'agent name')).toThrow(/%/)
  })

  it('rejects double-encoded slash (%252F)', () => {
    expect(() => rejectResourceIdChars('agent%252Fname', 'agent name')).toThrow(/%/)
  })

  it('rejects ampersand (query params)', () => {
    expect(() => rejectResourceIdChars('agent&key=val', 'agent name')).toThrow(/&/)
  })

  it('rejects equals sign (query params)', () => {
    expect(() => rejectResourceIdChars('agent=value', 'agent name')).toThrow(/=/)
  })

  it('includes the field name in error message', () => {
    expect(() => rejectResourceIdChars('bad?ref', 'version')).toThrow(/version/)
  })

  it('rejects control chars via delegation', () => {
    expect(() => rejectResourceIdChars('bad\x00ref', 'org name')).toThrow(/control character/)
  })
})

describe('ensurePathInBounds', () => {
  it('accepts paths within base directory', () => {
    expect(() => ensurePathInBounds('/project/src/file.ts', '/project')).not.toThrow()
    expect(() => ensurePathInBounds('/project/file.json', '/project')).not.toThrow()
  })

  it('accepts the base directory itself', () => {
    expect(() => ensurePathInBounds('/project', '/project')).not.toThrow()
  })

  it('rejects paths that escape via ../', () => {
    expect(() => ensurePathInBounds('/etc/passwd', '/project')).toThrow(/outside.*allowed/)
  })

  it('rejects paths in sibling directories', () => {
    expect(() => ensurePathInBounds('/other-project/secrets.json', '/project')).toThrow(/outside.*allowed/)
  })

  it('rejects raw ../ in path argument', () => {
    expect(() => ensurePathInBounds(path.resolve('/project', '../etc/passwd'), '/project')).toThrow(/outside.*allowed/)
  })

  it('handles trailing slashes correctly', () => {
    expect(() => ensurePathInBounds('/project/sub/', '/project/')).not.toThrow()
    expect(() => ensurePathInBounds('/project/sub', '/project/')).not.toThrow()
  })
})

describe('rejectPathTraversal', () => {
  it('accepts normal relative paths', () => {
    expect(() => rejectPathTraversal('src/file.ts', 'file path')).not.toThrow()
    expect(() => rejectPathTraversal('./file.ts', 'file path')).not.toThrow()
    expect(() => rejectPathTraversal('file.json', 'file path')).not.toThrow()
  })

  it('accepts absolute paths', () => {
    expect(() => rejectPathTraversal('/tmp/test.ts', 'file path')).not.toThrow()
    expect(() => rejectPathTraversal('/home/user/project/file.json', 'file path')).not.toThrow()
  })

  it('rejects ../ traversal', () => {
    expect(() => rejectPathTraversal('../etc/passwd', 'file path')).toThrow(/path traversal/)
  })

  it('rejects nested ../ traversal', () => {
    expect(() => rejectPathTraversal('src/../../etc/passwd', 'file path')).toThrow(/path traversal/)
  })

  it('rejects bare ..', () => {
    expect(() => rejectPathTraversal('..', 'file path')).toThrow(/path traversal/)
  })

  it('rejects trailing /..', () => {
    expect(() => rejectPathTraversal('src/..', 'file path')).toThrow(/path traversal/)
  })

  it('rejects backslash traversal (Windows-style)', () => {
    expect(() => rejectPathTraversal('..\\etc\\passwd', 'mount path')).toThrow(/path traversal/)
  })

  it('includes field name in error message', () => {
    expect(() => rejectPathTraversal('../secret', 'mount path')).toThrow(/mount path/)
  })
})

describe('sanitizeSecretValue', () => {
  it('returns the value unchanged for normal text', () => {
    expect(sanitizeSecretValue('sk-abc123xyz')).toBe('sk-abc123xyz')
  })

  it('allows newlines in secret values', () => {
    expect(sanitizeSecretValue('-----BEGIN KEY-----\nbase64data\n-----END KEY-----')).toBe(
      '-----BEGIN KEY-----\nbase64data\n-----END KEY-----'
    )
  })

  it('allows tabs in secret values', () => {
    expect(sanitizeSecretValue('col1\tcol2')).toBe('col1\tcol2')
  })

  it('strips null bytes from secret values', () => {
    expect(sanitizeSecretValue('key\x00value')).toBe('keyvalue')
  })

  it('strips other dangerous control chars', () => {
    expect(sanitizeSecretValue('key\x07\x08\x1Bvalue')).toBe('keyvalue')
  })

  it('returns cleaned value without throwing', () => {
    const result = sanitizeSecretValue('test\x00value')
    expect(result).toBe('testvalue')
  })
})
