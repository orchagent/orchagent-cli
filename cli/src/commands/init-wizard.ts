/**
 * Interactive wizard for `orch init`.
 *
 * Runs when `orch init` is invoked without arguments in a TTY.
 * Uses Node.js built-in readline/promises — no extra dependencies.
 *
 * The wizard leads with "What do you want to build?" to directly address
 * the most common new-user friction — not knowing which type/flavor to pick.
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
  { name: 'cron-job',              description: 'Scheduled task — daily reports, syncs, cleanups',          type: 'tool',  language: 'both',       runMode: 'on_demand' },
  { name: 'discord',               description: 'Discord bot powered by Claude (Python)',                   type: 'agent', language: 'python',     runMode: 'always_on' },
  { name: 'discord-js',            description: 'Discord bot powered by Claude (JavaScript)',               type: 'agent', language: 'javascript', runMode: 'always_on' },
  { name: 'support-agent',         description: 'Multi-platform support agent (Discord/Telegram/Slack)',    type: 'agent', language: 'python',     runMode: 'always_on' },
  { name: 'fan-out',               description: 'Parallel orchestration — call agents concurrently',        type: 'agent', language: 'both',       runMode: 'on_demand' },
  { name: 'pipeline',              description: 'Sequential orchestration — chain agents in series',        type: 'agent', language: 'both',       runMode: 'on_demand' },
  { name: 'map-reduce',            description: 'Map-reduce orchestration — split, process, aggregate',     type: 'agent', language: 'both',       runMode: 'on_demand' },
  { name: 'github-weekly-summary', description: 'GitHub activity analyser with Discord delivery',           type: 'agent', language: 'python',     runMode: 'on_demand' },
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
// Language follow-up (shared by several use cases)
// ---------------------------------------------------------------------------

async function promptLanguage(rl: readline.Interface): Promise<string> {
  return promptSelect(rl, 'Language?', [
    { value: 'python',     label: 'Python',     description: 'Recommended — broadest library support' },
    { value: 'javascript', label: 'JavaScript',  description: 'Node.js runtime' },
  ])
}

// ---------------------------------------------------------------------------
// "More templates" sub-flow
// ---------------------------------------------------------------------------

async function handleMoreTemplates(
  rl: readline.Interface,
  nameForResult: string | undefined,
): Promise<WizardResult> {
  const language = await promptLanguage(rl)

  const applicableTemplates = TEMPLATE_REGISTRY.filter(t =>
    t.language === 'both' || t.language === language
  )

  const templateOptions: SelectOption[] = [
    { value: 'none', label: 'No template', description: 'Start from scratch (choose type manually)' },
    ...applicableTemplates.map(t => ({
      value: t.name,
      label: t.name,
      description: t.description,
    })),
  ]

  const template = await promptSelect(rl, 'Pick a template:', templateOptions)

  if (template !== 'none') {
    const info = TEMPLATE_REGISTRY.find(t => t.name === template)!
    rl.close()
    return {
      name: nameForResult,
      type: info.type,
      language,
      template,
      runMode: info.runMode,
      orchestrator: false,
      loop: false,
    }
  }

  // No template — fall back to manual type selection
  const type = await promptSelect(rl, 'Agent type?', [
    { value: 'prompt', label: 'prompt',  description: 'Single LLM call with structured I/O' },
    { value: 'tool',   label: 'tool',    description: 'Your own code (API calls, file processing)' },
    { value: 'agent',  label: 'agent',   description: 'Multi-step LLM reasoning with tool use' },
  ])

  let runMode = 'on_demand'
  let orchestrator = false
  let loop = false

  if (type === 'tool') {
    runMode = await promptSelect(rl, 'Run mode?', [
      { value: 'on_demand', label: 'on_demand',  description: 'Run per invocation (default)' },
      { value: 'always_on', label: 'always_on',  description: 'Long-lived HTTP service' },
    ])
  }

  if (type === 'agent') {
    runMode = await promptSelect(rl, 'Run mode?', [
      { value: 'on_demand', label: 'on_demand',  description: 'Run per invocation (default)' },
      { value: 'always_on', label: 'always_on',  description: 'Long-lived HTTP service' },
    ])
    const subtypeOptions: SelectOption[] = [
      { value: 'code',        label: 'Code runtime',  description: 'You write the logic (call any LLM provider)' },
      { value: 'orchestrator', label: 'Orchestrator',  description: 'Coordinate other agents via SDK' },
    ]
    if (language === 'python') {
      subtypeOptions.push(
        { value: 'loop', label: 'Managed loop', description: 'Platform-managed LLM loop with tool use' },
      )
    }
    const agentSubtype = await promptSelect(rl, 'Agent execution mode?', subtypeOptions)
    orchestrator = agentSubtype === 'orchestrator'
    loop = agentSubtype === 'loop'
  }

  rl.close()
  return { name: nameForResult, type, language, template: undefined, runMode, orchestrator, loop }
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
    const nameForResult = name !== dirName ? name : undefined

    // 2. What do you want to build? (use-case-driven — replaces type/template questions)
    const useCase = await promptSelect(rl, 'What do you want to build?', [
      { value: 'prompt',       label: 'Prompt agent',         description: 'Single LLM call with structured I/O (simplest)' },
      { value: 'tool-py',      label: 'Tool (Python)',        description: 'Your code processes data (stdin/stdout JSON)' },
      { value: 'tool-js',      label: 'Tool (JavaScript)',    description: 'Your code processes data (Node.js)' },
      { value: 'cron-job',     label: 'Scheduled job',        description: 'Runs on a cron schedule (reports, syncs, cleanups)' },
      { value: 'discord-bot',  label: 'Discord bot',          description: 'Always-on chatbot in Discord channels' },
      { value: 'orchestrator', label: 'Orchestrator',         description: 'Coordinate multiple agents via SDK' },
      { value: 'agent-loop',   label: 'AI agent (LLM loop)',  description: 'Multi-step reasoning with tool use' },
      { value: 'skill',        label: 'Knowledge skill',      description: 'Reusable knowledge module for other agents' },
      { value: 'more',         label: 'More templates...',    description: 'Fan-out, pipeline, map-reduce, support agent, etc.' },
    ])

    // --- Direct-resolution use cases (no follow-up needed) ---

    if (useCase === 'prompt') {
      rl.close()
      return { name: nameForResult, type: 'prompt', language: 'python', template: undefined, runMode: 'on_demand', orchestrator: false, loop: false }
    }

    if (useCase === 'skill') {
      rl.close()
      return { name: nameForResult, type: 'skill', language: 'python', template: undefined, runMode: 'on_demand', orchestrator: false, loop: false }
    }

    if (useCase === 'tool-py') {
      rl.close()
      return { name: nameForResult, type: 'tool', language: 'python', template: undefined, runMode: 'on_demand', orchestrator: false, loop: false }
    }

    if (useCase === 'tool-js') {
      rl.close()
      return { name: nameForResult, type: 'tool', language: 'javascript', template: undefined, runMode: 'on_demand', orchestrator: false, loop: false }
    }

    if (useCase === 'agent-loop') {
      rl.close()
      return { name: nameForResult, type: 'agent', language: 'python', template: undefined, runMode: 'on_demand', orchestrator: false, loop: true }
    }

    // --- Use cases that need a language follow-up ---

    if (useCase === 'cron-job') {
      const lang = await promptLanguage(rl)
      rl.close()
      return { name: nameForResult, type: 'tool', language: lang, template: 'cron-job', runMode: 'on_demand', orchestrator: false, loop: false }
    }

    if (useCase === 'discord-bot') {
      const lang = await promptSelect(rl, 'Language?', [
        { value: 'python',     label: 'Python',     description: 'Recommended — discord.py + anthropic' },
        { value: 'javascript', label: 'JavaScript',  description: 'discord.js + @anthropic-ai/sdk' },
      ])
      const template = lang === 'javascript' ? 'discord-js' : 'discord'
      rl.close()
      return { name: nameForResult, type: 'agent', language: lang, template, runMode: 'always_on', orchestrator: false, loop: false }
    }

    if (useCase === 'orchestrator') {
      const lang = await promptLanguage(rl)
      rl.close()
      return { name: nameForResult, type: 'agent', language: lang, template: undefined, runMode: 'on_demand', orchestrator: true, loop: false }
    }

    // --- "More templates..." sub-flow ---

    if (useCase === 'more') {
      return handleMoreTemplates(rl, nameForResult)
    }

    // Shouldn't reach here, but handle gracefully
    rl.close()
    return { name: nameForResult, type: 'prompt', language: 'python', template: undefined, runMode: 'on_demand', orchestrator: false, loop: false }
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
