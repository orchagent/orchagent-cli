import { Command } from 'commander'
import fs from 'fs/promises'
import path from 'path'

import { CliError } from '../lib/errors'

const MANIFEST_TEMPLATE = `{
  "name": "my-agent",
  "description": "A simple AI agent",
  "type": "agent",
  "run_mode": "on_demand",
  "tags": []
}
`

const PROMPT_TEMPLATE = `You are a helpful AI assistant.

Given the following input, provide a clear and concise response.

Input: {{input}}

Respond in a helpful and professional manner.
`

const SCHEMA_TEMPLATE = `{
  "input": {
    "type": "object",
    "properties": {
      "input": {
        "type": "string",
        "description": "The user's input or question"
      }
    },
    "required": ["input"]
  },
  "output": {
    "type": "object",
    "properties": {
      "result": {
        "type": "string",
        "description": "The agent's response"
      }
    },
    "required": ["result"]
  }
}
`

const CODE_TEMPLATE_PY = `"""
orchagent tool entrypoint.

Reads JSON input from stdin, processes it, and writes JSON output to stdout.
This is the standard orchagent tool protocol.

Usage:
  echo '{"input": "hello"}' | python main.py
"""

import json
import sys


def main():
    # Read JSON input from stdin
    raw = sys.stdin.read()
    try:
        data = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        print(json.dumps({"error": "Invalid JSON input"}))
        sys.exit(1)

    user_input = data.get("input", "")

    # --- Your logic here ---
    result = f"Received: {user_input}"
    # --- End your logic ---

    # Write JSON output to stdout
    print(json.dumps({"result": result}))


if __name__ == "__main__":
    main()
`

type InitFlavor = 'direct_llm' | 'managed_loop' | 'code_runtime'

function readmeTemplate(agentName: string, flavor: InitFlavor): string {
  const inputField = flavor === 'managed_loop' ? 'task' : 'input'
  const inputDescription = flavor === 'managed_loop' ? 'The task to perform' : 'The input to process'
  const cloudExample =
    flavor === 'code_runtime'
      ? `orchagent run ${agentName} --data '{"input": "Hello world"}'`
      : `orchagent run ${agentName} --data '{"${inputField}": "Hello world"}'`
  const localExample =
    flavor === 'code_runtime'
      ? `orchagent run ${agentName} --local --data '{"input": "Hello world"}'`
      : `orchagent run ${agentName} --local --data '{"${inputField}": "Hello world"}'`

  return `# ${agentName}

A brief description of what this agent does.

## Usage

### Cloud execution (default)

\`\`\`sh
${cloudExample}
\`\`\`

### Local execution

\`\`\`sh
${localExample}
\`\`\`

## Input

| Field | Type | Description |
|-------|------|-------------|
| \`${inputField}\` | string | ${inputDescription} |

## Output

| Field | Type | Description |
|-------|------|-------------|
| \`result\` | string | The agent's response |
`
}

const AGENT_PROMPT_TEMPLATE = `You are a helpful AI agent.

Given the input, complete the task step by step.
Verify your results before submitting.
`

const AGENT_SCHEMA_TEMPLATE = `{
  "input": {
    "type": "object",
    "properties": {
      "task": {
        "type": "string",
        "description": "The task to complete"
      }
    },
    "required": ["task"]
  },
  "output": {
    "type": "object",
    "properties": {
      "result": {
        "type": "string",
        "description": "The result of the task"
      },
      "success": {
        "type": "boolean",
        "description": "Whether the task completed successfully"
      }
    },
    "required": ["result", "success"]
  }
}
`

const SKILL_TEMPLATE = `---
name: my-skill
description: When to use this skill
license: MIT
---

# My Skill

Instructions and guidance for AI agents...
`

function resolveInitFlavor(typeOption: string): { type: 'agent' | 'skill'; flavor?: InitFlavor } {
  const normalized = (typeOption || 'agent').trim().toLowerCase()
  if (normalized === 'skill') {
    return { type: 'skill' }
  }
  if (normalized === 'agent') {
    return { type: 'agent', flavor: 'direct_llm' }
  }
  if (normalized === 'prompt') {
    return { type: 'agent', flavor: 'direct_llm' }
  }
  if (normalized === 'agentic') {
    return { type: 'agent', flavor: 'managed_loop' }
  }
  if (normalized === 'tool' || normalized === 'code') {
    return { type: 'agent', flavor: 'code_runtime' }
  }

  throw new CliError(
    `Unknown --type '${typeOption}'. Use 'agent' or 'skill' (legacy: prompt, tool, agentic, code).`
  )
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize a new agent project')
    .argument('[name]', 'Agent name (default: current directory name)')
    .option('--type <type>', 'Type: agent or skill (legacy: prompt, tool, agentic, code)', 'agent')
    .option('--run-mode <mode>', 'Run mode for agents: on_demand or always_on', 'on_demand')
    .action(async (name: string | undefined, options: { type: string; runMode: string }) => {
      const cwd = process.cwd()
      const runMode = (options.runMode || 'on_demand').trim().toLowerCase()
      if (!['on_demand', 'always_on'].includes(runMode)) {
        throw new CliError("Invalid --run-mode. Use 'on_demand' or 'always_on'.")
      }
      const initMode = resolveInitFlavor(options.type)

      // When a name is provided, create a subdirectory for the project
      const targetDir = name ? path.join(cwd, name) : cwd
      const agentName = name || path.basename(cwd)

      // Create the subdirectory if a name was provided
      if (name) {
        await fs.mkdir(targetDir, { recursive: true })
      }

      // Handle skill type separately
      if (initMode.type === 'skill') {
        const skillPath = path.join(targetDir, 'SKILL.md')

        // Check if already initialized
        try {
          await fs.access(skillPath)
          throw new CliError(`Already initialized (SKILL.md exists in ${name ? name + '/' : 'current directory'})`)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw err
          }
        }

        const skillContent = SKILL_TEMPLATE.replace('my-skill', agentName)
        await fs.writeFile(skillPath, skillContent)

        process.stdout.write(`Initialized skill "${agentName}" in ${targetDir}\n`)
        process.stdout.write(`\nFiles created:\n`)
        process.stdout.write(`  ${name ? name + '/' : ''}SKILL.md - Skill content with frontmatter\n`)
        process.stdout.write(`\nNext steps:\n`)
        if (name) {
          process.stdout.write(`  1. cd ${name}\n`)
          process.stdout.write(`  2. Edit SKILL.md with your skill content\n`)
          process.stdout.write(`  3. Run: orchagent publish\n`)
        } else {
          process.stdout.write(`  1. Edit SKILL.md with your skill content\n`)
          process.stdout.write(`  2. Run: orchagent publish\n`)
        }
        return
      }

      const manifestPath = path.join(targetDir, 'orchagent.json')
      const promptPath = path.join(targetDir, 'prompt.md')
      const schemaPath = path.join(targetDir, 'schema.json')

      // Check if already initialized
      try {
        await fs.access(manifestPath)
        throw new CliError(`Already initialized (orchagent.json exists in ${name ? name + '/' : 'current directory'})`)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err
        }
      }

      if (initMode.flavor === 'direct_llm' && runMode === 'always_on') {
        throw new CliError(
          "run_mode=always_on requires a non-direct runtime. Use legacy '--type tool' or add runtime.command in orchagent.json."
        )
      }

      // Create manifest and type-specific files
      const manifest = JSON.parse(MANIFEST_TEMPLATE)
      manifest.name = agentName
      manifest.type = 'agent'
      manifest.run_mode = runMode

      if (initMode.flavor === 'managed_loop') {
        manifest.description = 'An AI agent with tool use'
        manifest.supported_providers = ['anthropic']
        manifest.loop = { max_turns: 25 }
      } else if (initMode.flavor === 'code_runtime') {
        manifest.description = 'A code-runtime agent'
        manifest.runtime = { command: 'python main.py' }
      }

      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

      if (initMode.flavor === 'code_runtime') {
        const entrypointPath = path.join(targetDir, 'main.py')
        await fs.writeFile(entrypointPath, CODE_TEMPLATE_PY)
        await fs.writeFile(schemaPath, SCHEMA_TEMPLATE)
      } else if (initMode.flavor === 'managed_loop') {
        await fs.writeFile(promptPath, AGENT_PROMPT_TEMPLATE)
        await fs.writeFile(schemaPath, AGENT_SCHEMA_TEMPLATE)
      } else {
        await fs.writeFile(promptPath, PROMPT_TEMPLATE)
        await fs.writeFile(schemaPath, SCHEMA_TEMPLATE)
      }

      // Create README
      const readmePath = path.join(targetDir, 'README.md')
      await fs.writeFile(readmePath, readmeTemplate(agentName, initMode.flavor || 'direct_llm'))

      process.stdout.write(`Initialized agent "${agentName}" in ${targetDir}\n`)
      process.stdout.write(`\nFiles created:\n`)
      const prefix = name ? name + '/' : ''
      process.stdout.write(`  ${prefix}orchagent.json - Agent configuration\n`)
      if (initMode.flavor === 'code_runtime') {
        process.stdout.write(`  ${prefix}main.py        - Agent entrypoint (stdin/stdout JSON)\n`)
      } else {
        process.stdout.write(`  ${prefix}prompt.md      - Prompt template\n`)
      }
      process.stdout.write(`  ${prefix}schema.json    - Input/output schemas\n`)
      process.stdout.write(`  ${prefix}README.md      - Agent documentation\n`)
      process.stdout.write(`  Run mode: ${runMode}\n`)
      process.stdout.write(`  Execution: ${initMode.flavor}\n`)
      process.stdout.write(`\nNext steps:\n`)
      if (initMode.flavor === 'code_runtime') {
        const stepNum = name ? 2 : 1
        if (name) {
          process.stdout.write(`  1. cd ${name}\n`)
        }
        process.stdout.write(`  ${stepNum}. Edit main.py with your agent logic\n`)
        process.stdout.write(`  ${stepNum + 1}. Edit schema.json with your input/output schemas\n`)
        process.stdout.write(`  ${stepNum + 2}. Test: echo '{"input": "test"}' | python main.py\n`)
        process.stdout.write(`  ${stepNum + 3}. Run: orchagent publish\n`)
      } else {
        const stepNum = name ? 2 : 1
        if (name) {
          process.stdout.write(`  1. cd ${name}\n`)
        }
        process.stdout.write(`  ${stepNum}. Edit prompt.md with your agent instructions\n`)
        process.stdout.write(`  ${stepNum + 1}. Edit schema.json with your input/output schemas\n`)
        process.stdout.write(`  ${stepNum + 2}. Run: orchagent publish\n`)
      }
    })
}
