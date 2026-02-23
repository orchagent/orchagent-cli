import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
import {
  extractCommands,
  generateBash,
  generateZsh,
  generateFish,
  generateCompletion,
  registerCompletionCommand,
} from './completion'

/** Build a small program with representative commands for testing */
function createTestProgram(): Command {
  const program = new Command()
  program.name('orch')
  program.option('--no-progress', 'Disable progress spinners')
  program.version('1.0.0')

  program
    .command('login')
    .description('Log in to orchagent')
    .option('-k, --key <api-key>', 'Use API key directly')
    .option('--browser', 'Force browser-based login')

  program
    .command('run')
    .description('Run an agent')
    .option('--json', 'Output as JSON')
    .option('--local', 'Run locally')
    .option('--cloud', 'Run in cloud')
    .option('-d, --data <path>', 'Input data')

  program.command('whoami').description('Show current user info')

  const config = program.command('config').description('Manage CLI configuration')
  config.command('set').description('Set a configuration value')
  config
    .command('get')
    .description('Get a configuration value')
    .option('--json', 'Output as JSON')
  config.command('unset').description('Remove a configuration value')
  config
    .command('list')
    .description('List all configuration values')
    .option('--json', 'Output as JSON')

  const workspace = program.command('workspace').description('Manage workspaces')
  workspace.command('list').description('List workspaces')
  workspace.command('use').description('Set active workspace')

  registerCompletionCommand(program)

  return program
}

describe('extractCommands', () => {
  it('extracts top-level commands with names and descriptions', () => {
    const program = createTestProgram()
    const commands = extractCommands(program)

    const login = commands.find((c) => c.name === 'login')
    expect(login).toBeDefined()
    expect(login!.description).toBe('Log in to orchagent')
    expect(login!.subcommands).toHaveLength(0)

    const run = commands.find((c) => c.name === 'run')
    expect(run).toBeDefined()
    expect(run!.description).toBe('Run an agent')
  })

  it('extracts command options', () => {
    const program = createTestProgram()
    const commands = extractCommands(program)

    const run = commands.find((c) => c.name === 'run')!
    const longFlags = run.options.filter((o) => o.long).map((o) => o.long)
    expect(longFlags).toContain('--json')
    expect(longFlags).toContain('--local')
    expect(longFlags).toContain('--cloud')
    expect(longFlags).toContain('--data')
  })

  it('extracts short flags', () => {
    const program = createTestProgram()
    const commands = extractCommands(program)

    const login = commands.find((c) => c.name === 'login')!
    const shortFlags = login.options.filter((o) => o.short).map((o) => o.short)
    expect(shortFlags).toContain('-k')
  })

  it('extracts subcommands for command groups', () => {
    const program = createTestProgram()
    const commands = extractCommands(program)

    const config = commands.find((c) => c.name === 'config')!
    expect(config.subcommands).toHaveLength(4)
    const subNames = config.subcommands.map((s) => s.name)
    expect(subNames).toEqual(['set', 'get', 'unset', 'list'])
  })

  it('extracts subcommand options', () => {
    const program = createTestProgram()
    const commands = extractCommands(program)

    const config = commands.find((c) => c.name === 'config')!
    const getSub = config.subcommands.find((s) => s.name === 'get')!
    expect(getSub.options.some((o) => o.long === '--json')).toBe(true)
  })

  it('excludes the completion command itself', () => {
    const program = createTestProgram()
    const commands = extractCommands(program)

    const completion = commands.find((c) => c.name === 'completion')
    expect(completion).toBeUndefined()
  })

  it('includes all non-completion commands', () => {
    const program = createTestProgram()
    const commands = extractCommands(program)

    const names = commands.map((c) => c.name)
    expect(names).toContain('login')
    expect(names).toContain('run')
    expect(names).toContain('whoami')
    expect(names).toContain('config')
    expect(names).toContain('workspace')
    expect(names).toHaveLength(5)
  })
})

describe('generateBash', () => {
  const program = createTestProgram()
  const commands = extractCommands(program)
  const globalOptions = program.options.map((o) => ({
    long: o.long ?? null,
    short: o.short ?? null,
    description: o.description,
  }))

  it('generates a valid bash script with function and complete calls', () => {
    const script = generateBash(commands, globalOptions)
    expect(script).toContain('_orch()')
    expect(script).toContain('complete -o default -F _orch orch')
    expect(script).toContain('complete -o default -F _orch orchagent')
  })

  it('includes all top-level command names', () => {
    const script = generateBash(commands, globalOptions)
    expect(script).toContain('login')
    expect(script).toContain('run')
    expect(script).toContain('whoami')
    expect(script).toContain('config')
    expect(script).toContain('workspace')
  })

  it('includes subcommands for command groups', () => {
    const script = generateBash(commands, globalOptions)
    expect(script).toContain('set get unset list')
    expect(script).toContain('list use')
  })

  it('includes options for simple commands', () => {
    const script = generateBash(commands, globalOptions)
    expect(script).toContain('--json')
    expect(script).toContain('--local')
    expect(script).toContain('--cloud')
  })

  it('includes global options', () => {
    const script = generateBash(commands, globalOptions)
    expect(script).toContain('--no-progress')
    expect(script).toContain('--version')
    expect(script).toContain('--help')
  })

  it('includes setup instructions in comments', () => {
    const script = generateBash(commands, globalOptions)
    expect(script).toContain('eval "$(orch completion bash)"')
    expect(script).toContain('~/.bashrc')
  })

  it('handles subcommand option completion via nested case', () => {
    const script = generateBash(commands, globalOptions)
    // config command should have subcmd case
    expect(script).toContain('case "$subcmd" in')
    // get subcommand should offer --json
    expect(script).toMatch(/get\).*--json/s)
  })
})

describe('generateZsh', () => {
  const program = createTestProgram()
  const commands = extractCommands(program)
  const globalOptions = program.options.map((o) => ({
    long: o.long ?? null,
    short: o.short ?? null,
    description: o.description,
  }))

  it('generates a zsh completion with compdef header', () => {
    const script = generateZsh(commands, globalOptions)
    expect(script).toContain('#compdef orch orchagent')
    expect(script).toContain('_orch()')
    expect(script).toContain('_orch "$@"')
  })

  it('includes command descriptions for _describe', () => {
    const script = generateZsh(commands, globalOptions)
    expect(script).toContain("'login:Log in to orchagent'")
    expect(script).toContain("'run:Run an agent'")
    expect(script).toContain("'whoami:Show current user info'")
  })

  it('includes subcommand descriptions', () => {
    const script = generateZsh(commands, globalOptions)
    expect(script).toContain("'set:Set a configuration value'")
    expect(script).toContain("'get:Get a configuration value'")
  })

  it('includes option descriptions in brackets', () => {
    const script = generateZsh(commands, globalOptions)
    expect(script).toContain('--json[Output as JSON]')
    expect(script).toContain('--local[Run locally]')
  })

  it('includes global options', () => {
    const script = generateZsh(commands, globalOptions)
    expect(script).toContain('--no-progress[Disable progress spinners]')
  })

  it('includes setup instructions', () => {
    const script = generateZsh(commands, globalOptions)
    expect(script).toContain('eval "$(orch completion zsh)"')
    expect(script).toContain('~/.zshrc')
  })

  it('uses _arguments and _describe properly', () => {
    const script = generateZsh(commands, globalOptions)
    expect(script).toContain('_arguments -C')
    expect(script).toContain("_describe -t commands 'orch command' commands")
    expect(script).toContain("_describe -t subcommands 'subcommand' subcmds")
  })
})

describe('generateFish', () => {
  const program = createTestProgram()
  const commands = extractCommands(program)
  const globalOptions = program.options.map((o) => ({
    long: o.long ?? null,
    short: o.short ?? null,
    description: o.description,
  }))

  it('generates fish completions with correct format', () => {
    const script = generateFish(commands, globalOptions)
    expect(script).toContain('complete -c orch -f')
    expect(script).toContain('complete -c orchagent -f')
  })

  it('includes all commands with __fish_use_subcommand', () => {
    const script = generateFish(commands, globalOptions)
    expect(script).toContain(
      "complete -c orch -n '__fish_use_subcommand' -a login -d 'Log in to orchagent'"
    )
    expect(script).toContain(
      "complete -c orch -n '__fish_use_subcommand' -a run -d 'Run an agent'"
    )
  })

  it('duplicates completions for orchagent binary', () => {
    const script = generateFish(commands, globalOptions)
    expect(script).toContain(
      "complete -c orchagent -n '__fish_use_subcommand' -a login -d 'Log in to orchagent'"
    )
  })

  it('includes subcommand completions', () => {
    const script = generateFish(commands, globalOptions)
    expect(script).toContain("__fish_seen_subcommand_from config")
    expect(script).toContain("-a set -d 'Set a configuration value'")
    expect(script).toContain("-a get -d 'Get a configuration value'")
  })

  it('includes command options', () => {
    const script = generateFish(commands, globalOptions)
    expect(script).toContain("__fish_seen_subcommand_from run")
    expect(script).toContain("-l json -d 'Output as JSON'")
    expect(script).toContain("-l local -d 'Run locally'")
  })

  it('includes subcommand options', () => {
    const script = generateFish(commands, globalOptions)
    // config get --json
    expect(script).toContain(
      "__fish_seen_subcommand_from config; and __fish_seen_subcommand_from get"
    )
  })

  it('includes global options', () => {
    const script = generateFish(commands, globalOptions)
    expect(script).toContain("-l no-progress -d 'Disable progress spinners'")
    expect(script).toContain("-l help -d 'Show help'")
    expect(script).toContain("-l version -d 'Show version'")
  })

  it('includes setup instructions', () => {
    const script = generateFish(commands, globalOptions)
    expect(script).toContain('orch completion fish | source')
    expect(script).toContain('~/.config/fish/completions/orch.fish')
  })
})

describe('generateCompletion', () => {
  it('dispatches to bash generator', () => {
    const program = createTestProgram()
    const script = generateCompletion('bash', program)
    expect(script).toContain('_orch()')
    expect(script).toContain('complete -o default -F _orch orch')
  })

  it('dispatches to zsh generator', () => {
    const program = createTestProgram()
    const script = generateCompletion('zsh', program)
    expect(script).toContain('#compdef orch orchagent')
  })

  it('dispatches to fish generator', () => {
    const program = createTestProgram()
    const script = generateCompletion('fish', program)
    expect(script).toContain('complete -c orch -f')
  })

  it('throws for unsupported shell', () => {
    const program = createTestProgram()
    expect(() => generateCompletion('powershell', program)).toThrow(
      'Unsupported shell: powershell'
    )
    expect(() => generateCompletion('powershell', program)).toThrow(
      'bash, zsh, fish'
    )
  })
})

describe('registerCompletionCommand (integration)', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
  })

  it('writes bash completion to stdout', async () => {
    const program = createTestProgram()
    program.exitOverride()

    await program.parseAsync(['node', 'test', 'completion', 'bash'])

    expect(stdoutSpy).toHaveBeenCalled()
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join('')
    expect(output).toContain('_orch()')
    expect(output).toContain('complete -o default -F _orch orch')
  })

  it('writes zsh completion to stdout', async () => {
    const program = createTestProgram()
    program.exitOverride()

    await program.parseAsync(['node', 'test', 'completion', 'zsh'])

    const output = stdoutSpy.mock.calls.map((c) => c[0]).join('')
    expect(output).toContain('#compdef orch orchagent')
  })

  it('writes fish completion to stdout', async () => {
    const program = createTestProgram()
    program.exitOverride()

    await program.parseAsync(['node', 'test', 'completion', 'fish'])

    const output = stdoutSpy.mock.calls.map((c) => c[0]).join('')
    expect(output).toContain('complete -c orch -f')
  })

  it('shows help text with setup examples', async () => {
    const program = createTestProgram()
    program.exitOverride()

    let helpOutput = ''
    stdoutSpy.mockImplementation((chunk) => {
      helpOutput += chunk
      return true
    })

    try {
      await program.parseAsync(['node', 'test', 'completion', '--help'])
    } catch {
      // Commander throws on --help with exitOverride
    }

    expect(helpOutput).toContain('eval "$(orch completion bash)"')
    expect(helpOutput).toContain('eval "$(orch completion zsh)"')
    expect(helpOutput).toContain('orch completion fish | source')
  })

  it('rejects missing shell argument', async () => {
    const program = createTestProgram()
    program.exitOverride()
    program.configureOutput({ writeErr: () => {} })

    await expect(
      program.parseAsync(['node', 'test', 'completion'])
    ).rejects.toThrow()
  })
})

describe('edge cases', () => {
  it('handles commands with no options', () => {
    const program = new Command()
    program.command('simple').description('A simple command')
    registerCompletionCommand(program)

    const script = generateCompletion('bash', program)
    expect(script).toContain('simple')
  })

  it('handles empty program gracefully', () => {
    const program = new Command()
    registerCompletionCommand(program)

    const bashScript = generateCompletion('bash', program)
    expect(bashScript).toContain('_orch()')

    const zshScript = generateCompletion('zsh', program)
    expect(zshScript).toContain('#compdef orch orchagent')

    const fishScript = generateCompletion('fish', program)
    expect(fishScript).toContain('complete -c orch -f')
  })

  it('escapes single quotes in descriptions', () => {
    const program = new Command()
    program.command('test-cmd').description("Show user's info")
    registerCompletionCommand(program)

    const fishScript = generateCompletion('fish', program)
    // Single quote should be escaped
    expect(fishScript).toContain("Show user'\\''s info")

    const zshScript = generateCompletion('zsh', program)
    expect(zshScript).toContain("Show user'\\''s info")
  })

  it('handles deeply nested subcommand options', () => {
    const program = new Command()
    const group = program.command('group').description('A group command')
    group
      .command('sub1')
      .description('First sub')
      .option('--verbose', 'Show details')
      .option('--format <type>', 'Output format')
    group.command('sub2').description('Second sub')
    registerCompletionCommand(program)

    const bashScript = generateCompletion('bash', program)
    expect(bashScript).toContain('sub1) opts="--verbose --format --help"')

    const fishScript = generateCompletion('fish', program)
    expect(fishScript).toContain(
      "__fish_seen_subcommand_from group; and __fish_seen_subcommand_from sub1"
    )
    expect(fishScript).toContain("-l verbose -d 'Show details'")
  })
})
