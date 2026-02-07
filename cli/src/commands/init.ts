import { Command } from 'commander'
import fs from 'fs/promises'
import path from 'path'

import { CliError } from '../lib/errors'

const MANIFEST_TEMPLATE = `{
  "name": "my-agent",
  "description": "A simple AI agent",
  "type": "prompt",
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

function readmeTemplate(agentName: string, type: string): string {
  const callExample = type === 'tool'
    ? `orchagent call ${agentName} input-file.txt`
    : `orchagent call ${agentName} --data '{"${type === 'agent' ? 'task' : 'input'}": "Hello world"}'`
  const runExample = type === 'tool'
    ? `orchagent run ${agentName} --input '{"file_path": "src/app.py"}'`
    : `orchagent run ${agentName} --input '{"${type === 'agent' ? 'task' : 'input'}": "Hello world"}'`

  return `# ${agentName}

A brief description of what this agent does.

## Usage

### Server execution

\`\`\`sh
${callExample}
\`\`\`

### Local execution

\`\`\`sh
${runExample}
\`\`\`

## Input

| Field | Type | Description |
|-------|------|-------------|
| \`${type === 'agent' ? 'task' : 'input'}\` | string | ${type === 'agent' ? 'The task to perform' : 'The input to process'} |

## Output

| Field | Type | Description |
|-------|------|-------------|
| \`result\` | string | The agent's response |
`
}

const AGENT_MANIFEST_TEMPLATE = `{
  "name": "my-agent",
  "description": "An AI agent with tool use",
  "type": "agent",
  "supported_providers": ["anthropic"],
  "max_turns": 25,
  "custom_tools": [
    {
      "name": "run_tests",
      "description": "Run the test suite",
      "command": "pytest"
    }
  ]
}
`

const AGENT_PROMPT_TEMPLATE = `You are a helpful AI agent with access to a sandboxed environment.

Given the input, complete the task using the available tools:
- Use bash to run commands
- Use read_file and write_file to work with files
- Use custom tools defined by the agent author
- Call submit_result when you're done

Input: The caller's input will be provided as JSON.

Work step by step, verify your results, and submit the final output.
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

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize a new agent project')
    .argument('[name]', 'Agent name (default: current directory name)')
    .option('--type <type>', 'Type: prompt, tool, agent, or skill (default: prompt)', 'prompt')
    .action(async (name: string | undefined, options: { type: string }) => {
      const cwd = process.cwd()

      // When a name is provided, create a subdirectory for the project
      const targetDir = name ? path.join(cwd, name) : cwd
      const agentName = name || path.basename(cwd)

      // Create the subdirectory if a name was provided
      if (name) {
        await fs.mkdir(targetDir, { recursive: true })
      }

      // Handle skill type separately
      if (options.type === 'skill') {
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

      // Create manifest and type-specific files
      if (options.type === 'agent') {
        const manifest = JSON.parse(AGENT_MANIFEST_TEMPLATE)
        manifest.name = agentName
        await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
        await fs.writeFile(promptPath, AGENT_PROMPT_TEMPLATE)
        await fs.writeFile(schemaPath, AGENT_SCHEMA_TEMPLATE)
      } else {
        const manifest = JSON.parse(MANIFEST_TEMPLATE)
        manifest.name = agentName
        manifest.type = ['tool', 'skill'].includes(options.type) ? options.type : 'prompt'
        await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

        // Create prompt template (for prompt-based agents) or entrypoint (for tool agents)
        if (options.type === 'tool') {
          const entrypointPath = path.join(targetDir, 'main.py')
          await fs.writeFile(entrypointPath, CODE_TEMPLATE_PY)
        } else {
          await fs.writeFile(promptPath, PROMPT_TEMPLATE)
        }

        // Create schema template
        await fs.writeFile(schemaPath, SCHEMA_TEMPLATE)
      }

      // Create README
      const readmePath = path.join(targetDir, 'README.md')
      await fs.writeFile(readmePath, readmeTemplate(agentName, options.type))

      process.stdout.write(`Initialized agent "${agentName}" in ${targetDir}\n`)
      process.stdout.write(`\nFiles created:\n`)
      const prefix = name ? name + '/' : ''
      process.stdout.write(`  ${prefix}orchagent.json - Agent configuration\n`)
      if (options.type === 'tool') {
        process.stdout.write(`  ${prefix}main.py        - Agent entrypoint (stdin/stdout JSON)\n`)
      } else {
        process.stdout.write(`  ${prefix}prompt.md      - Prompt template\n`)
      }
      process.stdout.write(`  ${prefix}schema.json    - Input/output schemas\n`)
      process.stdout.write(`  ${prefix}README.md      - Agent documentation\n`)
      process.stdout.write(`\nNext steps:\n`)
      if (options.type === 'agent') {
        const stepNum = name ? 2 : 1
        if (name) {
          process.stdout.write(`  1. cd ${name}\n`)
        }
        process.stdout.write(`  ${stepNum}. Edit prompt.md with your agent instructions\n`)
        process.stdout.write(`  ${stepNum + 1}. Edit custom_tools in orchagent.json for your environment\n`)
        process.stdout.write(`  ${stepNum + 2}. Edit schema.json with your input/output schemas\n`)
        process.stdout.write(`  ${stepNum + 3}. Run: orchagent publish\n`)
      } else if (options.type !== 'tool') {
        const stepNum = name ? 2 : 1
        if (name) {
          process.stdout.write(`  1. cd ${name}\n`)
        }
        process.stdout.write(`  ${stepNum}. Edit prompt.md with your prompt template\n`)
        process.stdout.write(`  ${stepNum + 1}. Edit schema.json with your input/output schemas\n`)
        process.stdout.write(`  ${stepNum + 2}. Run: orchagent publish\n`)
      } else {
        const stepNum = name ? 2 : 1
        if (name) {
          process.stdout.write(`  1. cd ${name}\n`)
        }
        process.stdout.write(`  ${stepNum}. Edit main.py with your agent logic\n`)
        process.stdout.write(`  ${stepNum + 1}. Test: echo '{"input": "test"}' | python main.py\n`)
        process.stdout.write(`  ${stepNum + 2}. Run: orchagent publish\n`)
      }
    })
}
