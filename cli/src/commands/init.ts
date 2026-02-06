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
    .option('--type <type>', 'Type: prompt, code, or skill (default: prompt)', 'prompt')
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

      // Create manifest
      const manifest = JSON.parse(MANIFEST_TEMPLATE)
      manifest.name = agentName
      manifest.type = ['code', 'skill'].includes(options.type) ? options.type : 'prompt'
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

      // Create prompt template (for prompt-based agents)
      if (options.type !== 'code') {
        await fs.writeFile(promptPath, PROMPT_TEMPLATE)
      }

      // Create schema template
      await fs.writeFile(schemaPath, SCHEMA_TEMPLATE)

      process.stdout.write(`Initialized agent "${agentName}" in ${targetDir}\n`)
      process.stdout.write(`\nFiles created:\n`)
      const prefix = name ? name + '/' : ''
      process.stdout.write(`  ${prefix}orchagent.json - Agent configuration\n`)
      if (options.type !== 'code') {
        process.stdout.write(`  ${prefix}prompt.md      - Prompt template\n`)
      }
      process.stdout.write(`  ${prefix}schema.json    - Input/output schemas\n`)
      process.stdout.write(`\nNext steps:\n`)
      if (options.type !== 'code') {
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
        process.stdout.write(`  ${stepNum}. Edit schema.json with your input/output schemas\n`)
        process.stdout.write(`  ${stepNum + 1}. Deploy your code and get the URL\n`)
        process.stdout.write(`  ${stepNum + 2}. Run: orchagent publish --url <your-agent-url>\n`)
      }
    })
}
