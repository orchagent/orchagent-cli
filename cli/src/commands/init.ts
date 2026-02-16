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
    # To use workspace secrets, add them to "required_secrets" in orchagent.json:
    #   "required_secrets": ["MY_API_KEY"]
    # Then access via: os.environ["MY_API_KEY"]
    result = f"Received: {user_input}"
    # --- End your logic ---

    # Write JSON output to stdout
    print(json.dumps({"result": result}))


if __name__ == "__main__":
    main()
`

type InitFlavor = 'direct_llm' | 'managed_loop' | 'code_runtime' | 'orchestrator'

function readmeTemplate(agentName: string, flavor: InitFlavor): string {
  const inputField = flavor === 'managed_loop' || flavor === 'orchestrator' ? 'task' : 'input'
  const inputDescription = flavor === 'managed_loop' || flavor === 'orchestrator' ? 'The task to perform' : 'The input to process'
  const cloudExample =
    flavor === 'code_runtime'
      ? `orchagent run ${agentName} --data '{"input": "Hello world"}'`
      : `orchagent run ${agentName} --data '{"${inputField}": "Hello world"}'`
  const localExample =
    flavor === 'code_runtime'
      ? `orchagent run ${agentName} --local --data '{"input": "Hello world"}'`
      : `orchagent run ${agentName} --local --data '{"${inputField}": "Hello world"}'`

  let readme = `# ${agentName}

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

  if (flavor === 'orchestrator') {
    readme += `
## Dependencies

This orchestrator calls other agents. Update \`manifest.dependencies\` in \`orchagent.json\` with your actual dependencies.

**Publish order:** Publish dependency agents first, then this orchestrator.

| Dependency | Version | Description |
|------------|---------|-------------|
| \`org/agent-name\` | v1 | TODO: describe what this agent does |
`
  }

  return readme
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

const ORCHESTRATOR_MAIN_PY = `"""
orchagent orchestrator entrypoint.

Reads JSON input from stdin, calls dependency agents via the orchagent SDK,
and writes JSON output to stdout.

Usage:
  echo '{"task": "do something"}' | python main.py
"""

import asyncio
import json
import sys

from orchagent import AgentClient


def main():
    # Read JSON input from stdin
    raw = sys.stdin.read()
    try:
        data = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        print(json.dumps({"error": "Invalid JSON input"}))
        sys.exit(1)

    task = data.get("task", "")

    # --- Your orchestration logic here ---
    # The AgentClient reads ORCHAGENT_SERVICE_KEY from the environment automatically.
    # Do NOT add ORCHAGENT_SERVICE_KEY to required_secrets — the gateway injects it.
    client = AgentClient()

    # Call a dependency agent (must be listed in manifest.dependencies)
    result = asyncio.run(
        client.call("org/agent-name@v1", {"input": task})
    )

    # You can chain multiple calls, run them in parallel, or add conditional logic:
    #
    # Sequential:
    #   result2 = asyncio.run(client.call("org/another-agent@v1", {"input": result}))
    #
    # Parallel:
    #   r1, r2 = asyncio.run(asyncio.gather(
    #       client.call("org/agent-a@v1", {"input": task}),
    #       client.call("org/agent-b@v1", {"input": task}),
    #   ))
    # --- End orchestration logic ---

    # Write JSON output to stdout
    print(json.dumps({"result": result, "success": True}))


if __name__ == "__main__":
    main()
`

const ORCHESTRATOR_REQUIREMENTS = `orchagent-sdk>=0.1.0
`

const SKILL_TEMPLATE = `---
name: my-skill
description: When to use this skill
license: MIT
---

# My Skill

Instructions and guidance for AI agents...
`

function resolveInitFlavor(typeOption: string): { type: 'prompt' | 'tool' | 'agent' | 'skill'; flavor?: InitFlavor } {
  const normalized = (typeOption || 'prompt').trim().toLowerCase()
  if (normalized === 'skill') {
    return { type: 'skill' }
  }
  if (normalized === 'prompt') {
    return { type: 'prompt', flavor: 'direct_llm' }
  }
  if (normalized === 'agent' || normalized === 'agentic') {
    return { type: 'agent', flavor: 'managed_loop' }
  }
  if (normalized === 'tool' || normalized === 'code') {
    return { type: 'tool', flavor: 'code_runtime' }
  }

  throw new CliError(
    `Unknown --type '${typeOption}'. Use 'prompt', 'tool', 'agent', or 'skill' (legacy aliases: agentic, code).`
  )
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize a new agent project')
    .argument('[name]', 'Agent name (default: current directory name)')
    .option('--type <type>', 'Type: prompt, tool, agent, or skill (legacy aliases: agentic, code)', 'prompt')
    .option('--orchestrator', 'Create an orchestrator agent with dependency scaffolding and SDK boilerplate')
    .option('--run-mode <mode>', 'Run mode for agents: on_demand or always_on', 'on_demand')
    .action(async (name: string | undefined, options: { type: string; orchestrator?: boolean; runMode: string }) => {
      const cwd = process.cwd()
      const runMode = (options.runMode || 'on_demand').trim().toLowerCase()
      if (!['on_demand', 'always_on'].includes(runMode)) {
        throw new CliError("Invalid --run-mode. Use 'on_demand' or 'always_on'.")
      }
      let initMode = resolveInitFlavor(options.type)

      if (options.orchestrator) {
        if (initMode.type === 'skill') {
          throw new CliError('Cannot use --orchestrator with --type skill. Orchestrators are agent-type agents that call other agents.')
        }
        initMode = { type: 'agent', flavor: 'orchestrator' }
      }

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

      if (initMode.flavor !== 'code_runtime' && initMode.flavor !== 'orchestrator' && runMode === 'always_on') {
        throw new CliError(
          "run_mode=always_on requires runtime.command in orchagent.json (e.g. \"runtime\": { \"command\": \"python main.py\" }). Use --type tool for code-runtime agents."
        )
      }

      // Create manifest and type-specific files
      const manifest = JSON.parse(MANIFEST_TEMPLATE)
      manifest.name = agentName
      manifest.type = initMode.type
      manifest.run_mode = runMode

      if (initMode.flavor === 'orchestrator') {
        manifest.description = 'An orchestrator agent that coordinates other agents'
        manifest.runtime = { command: 'python main.py' }
        manifest.manifest = {
          manifest_version: 1,
          dependencies: [{ id: 'org/agent-name', version: 'v1' }],
          max_hops: 3,
          timeout_ms: 120000,
          per_call_downstream_cap: 50,
        }
        manifest.required_secrets = []
      } else if (initMode.flavor === 'managed_loop') {
        manifest.description = 'An AI agent with tool use'
        manifest.supported_providers = ['anthropic']
        manifest.loop = { max_turns: 25 }
        manifest.required_secrets = []
      } else if (initMode.flavor === 'code_runtime') {
        manifest.description = 'A code-runtime agent'
        manifest.runtime = { command: 'python main.py' }
        manifest.required_secrets = []
      }

      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

      if (initMode.flavor === 'orchestrator') {
        const entrypointPath = path.join(targetDir, 'main.py')
        const requirementsPath = path.join(targetDir, 'requirements.txt')
        await fs.writeFile(entrypointPath, ORCHESTRATOR_MAIN_PY)
        await fs.writeFile(requirementsPath, ORCHESTRATOR_REQUIREMENTS)
        await fs.writeFile(schemaPath, AGENT_SCHEMA_TEMPLATE)
      } else if (initMode.flavor === 'code_runtime') {
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
      process.stdout.write(`  ${prefix}orchagent.json    - Agent configuration\n`)
      if (initMode.flavor === 'orchestrator') {
        process.stdout.write(`  ${prefix}main.py           - Orchestrator entrypoint (SDK calls)\n`)
        process.stdout.write(`  ${prefix}requirements.txt  - Python dependencies (orchagent-sdk)\n`)
      } else if (initMode.flavor === 'code_runtime') {
        process.stdout.write(`  ${prefix}main.py           - Agent entrypoint (stdin/stdout JSON)\n`)
      } else {
        process.stdout.write(`  ${prefix}prompt.md         - Prompt template\n`)
      }
      process.stdout.write(`  ${prefix}schema.json       - Input/output schemas\n`)
      process.stdout.write(`  ${prefix}README.md         - Agent documentation\n`)
      process.stdout.write(`  Run mode: ${runMode}\n`)
      process.stdout.write(`  Execution: ${initMode.flavor === 'orchestrator' ? 'code_runtime (orchestrator)' : initMode.flavor}\n`)
      process.stdout.write(`\nNext steps:\n`)
      if (initMode.flavor === 'orchestrator') {
        const stepNum = name ? 2 : 1
        if (name) {
          process.stdout.write(`  1. cd ${name}\n`)
        }
        process.stdout.write(`  ${stepNum}. Update manifest.dependencies in orchagent.json with your actual agents\n`)
        process.stdout.write(`  ${stepNum + 1}. Edit main.py with your orchestration logic\n`)
        process.stdout.write(`  ${stepNum + 2}. Publish dependency agents first, then: orchagent publish\n`)
      } else if (initMode.flavor === 'code_runtime') {
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
