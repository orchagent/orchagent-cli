/**
 * Interactive wizard for `orch init`.
 *
 * Runs when `orch init` is invoked without arguments in a TTY.
 * Uses Node.js built-in readline/promises — no extra dependencies.
 */

import readline from 'readline/promises'
import path from 'path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WizardResult {
  name: string | undefined
  type: string
  language: string
  template: string | undefined
  runMode: string
  orchestrator: boolean
  loop: boolean
}

interface SelectOption {
  value: string
  label: string
  description: string
}

// ---------------------------------------------------------------------------
// Template registry — single source of truth for --list-templates and wizard
// ---------------------------------------------------------------------------

export interface TemplateInfo {
  name: string
  description: string
  type: string
  language: string
  runMode: string
}

export const TEMPLATE_REGISTRY: TemplateInfo[] = [
  { name: 'discord',                description: 'Discord bot powered by Claude (Python)',         type: 'agent', language: 'python',     runMode: 'always_on' },
  { name: 'discord-js',            description: 'Discord bot powered by Claude (JavaScript)',      type: 'agent', language: 'javascript', runMode: 'always_on' },
  { name: 'support-agent',         description: 'Multi-platform support agent (Discord/Telegram/Slack)', type: 'agent', language: 'python', runMode: 'always_on' },
  { name: 'fan-out',               description: 'Parallel orchestration — call agents concurrently',     type: 'agent', language: 'both',   runMode: 'on_demand' },
  { name: 'pipeline',              description: 'Sequential orchestration — chain agents in series',     type: 'agent', language: 'both',   runMode: 'on_demand' },
  { name: 'map-reduce',            description: 'Map-reduce orchestration — split, process, aggregate',  type: 'agent', language: 'both',   runMode: 'on_demand' },
  { name: 'github-weekly-summary', description: 'GitHub activity analyser with Discord delivery',        type: 'agent', language: 'python', runMode: 'on_demand' },
]

// ---------------------------------------------------------------------------
// Prompt helpers (readline-based, no dependencies)
// ---------------------------------------------------------------------------

function createInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stderr, // prompts on stderr so stdout stays clean for piping
  })
}

async function promptText(
  rl: readline.Interface,
  question: string,
  defaultValue?: string,
): Promise<string> {
  const suffix = defaultValue ? ` (${defaultValue})` : ''
  const answer = await rl.question(`  ${question}${suffix}: `)
  return answer.trim() || defaultValue || ''
}

async function promptSelect(
  rl: readline.Interface,
  question: string,
  options: SelectOption[],
): Promise<string> {
  process.stderr.write(`\n  ${question}\n`)
  for (let i = 0; i < options.length; i++) {
    const opt = options[i]
    process.stderr.write(`    ${i + 1}) ${opt.label}  — ${opt.description}\n`)
  }
  process.stderr.write('\n')

  while (true) {
    const answer = await rl.question(`  Choice [1-${options.length}]: `)
    const num = parseInt(answer.trim(), 10)
    if (num >= 1 && num <= options.length) {
      return options[num - 1].value
    }
    process.stderr.write(`  Please enter a number between 1 and ${options.length}.\n`)
  }
}

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------

export async function runInitWizard(): Promise<WizardResult> {
  const rl = createInterface()

  try {
    process.stderr.write('\n  orch init — interactive setup\n')
    process.stderr.write('  ─────────────────────────────\n\n')

    // 1. Agent name
    const dirName = path.basename(process.cwd())
    const name = await promptText(rl, 'Agent name', dirName)
    const createSubdir = name !== dirName

    // 2. Agent type
    const type = await promptSelect(rl, 'What type of agent?', [
      { value: 'prompt', label: 'prompt',  description: 'Single LLM call with structured I/O' },
      { value: 'tool',   label: 'tool',    description: 'Your own code (API calls, file processing)' },
      { value: 'agent',  label: 'agent',   description: 'Multi-step LLM reasoning with tool use' },
      { value: 'skill',  label: 'skill',   description: 'Knowledge module for other agents' },
    ])

    // Skill and prompt don't need language/template
    if (type === 'skill' || type === 'prompt') {
      rl.close()
      return {
        name: createSubdir ? name : undefined,
        type,
        language: 'python',
        template: undefined,
        runMode: 'on_demand',
        orchestrator: false,
        loop: false,
      }
    }

    // 3. Language (tool/agent only)
    const language = await promptSelect(rl, 'Language?', [
      { value: 'python',     label: 'Python',     description: 'Recommended — broadest library support' },
      { value: 'javascript', label: 'JavaScript',  description: 'Node.js runtime' },
    ])

    // 4. Template (optional)
    const applicableTemplates = TEMPLATE_REGISTRY.filter(t => {
      if (t.language !== 'both' && t.language !== language) return false
      return true
    })

    const templateOptions: SelectOption[] = [
      { value: 'none', label: 'No template', description: 'Start from scratch' },
      ...applicableTemplates.map(t => ({
        value: t.name,
        label: t.name,
        description: t.description,
      })),
    ]

    const template = await promptSelect(rl, 'Start from a template?', templateOptions)

    // 5. Run mode (only if no template selected — templates set their own)
    let runMode = 'on_demand'
    if (template === 'none') {
      runMode = await promptSelect(rl, 'Run mode?', [
        { value: 'on_demand', label: 'on_demand',  description: 'Run per invocation (default)' },
        { value: 'always_on', label: 'always_on',  description: 'Long-lived HTTP service' },
      ])
    }

    // 6. Agent subtype (only for agent type, no template)
    let orchestrator = false
    let loop = false
    if (type === 'agent' && template === 'none') {
      const agentSubtype = await promptSelect(rl, 'Agent execution mode?', [
        { value: 'code',        label: 'Code runtime',   description: 'You write the logic (call any LLM provider)' },
        { value: 'orchestrator', label: 'Orchestrator',   description: 'Coordinate other agents via SDK' },
        ...(language === 'python' ? [{ value: 'loop', label: 'Managed loop', description: 'Platform-managed LLM loop with tool use' }] : []),
      ])
      orchestrator = agentSubtype === 'orchestrator'
      loop = agentSubtype === 'loop'
    }

    rl.close()

    return {
      name: createSubdir ? name : undefined,
      type,
      language,
      template: template === 'none' ? undefined : template,
      runMode,
      orchestrator,
      loop,
    }
  } catch (err) {
    rl.close()
    throw err
  }
}

// ---------------------------------------------------------------------------
// List templates (for --list-templates flag)
// ---------------------------------------------------------------------------

export function printTemplateList(): void {
  process.stdout.write('\nAvailable templates:\n\n')

  const nameWidth = Math.max(...TEMPLATE_REGISTRY.map(t => t.name.length)) + 2
  const langWidth = 12

  process.stdout.write(
    `  ${'TEMPLATE'.padEnd(nameWidth)}${'LANGUAGE'.padEnd(langWidth)}${'RUN MODE'.padEnd(12)}DESCRIPTION\n`,
  )
  process.stdout.write(
    `  ${'─'.repeat(nameWidth)}${'─'.repeat(langWidth)}${'─'.repeat(12)}${'─'.repeat(40)}\n`,
  )

  for (const t of TEMPLATE_REGISTRY) {
    const lang = t.language === 'both' ? 'py / js' : t.language === 'python' ? 'python' : 'javascript'
    process.stdout.write(
      `  ${t.name.padEnd(nameWidth)}${lang.padEnd(langWidth)}${t.runMode.padEnd(12)}${t.description}\n`,
    )
  }

  process.stdout.write('\nUsage:\n')
  process.stdout.write('  orch init my-agent --template <name>\n')
  process.stdout.write('  orch init my-agent --template <name> --language javascript\n\n')
}
