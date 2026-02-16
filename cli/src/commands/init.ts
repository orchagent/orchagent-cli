import { Command } from 'commander'
import fs from 'fs/promises'
import path from 'path'

import { CliError } from '../lib/errors'
import {
  AVAILABLE_TEMPLATES,
  TEMPLATE_MANIFEST,
  TEMPLATE_MAIN_PY,
  TEMPLATE_CONFIG_PY,
  TEMPLATE_GITHUB_FETCHER_PY,
  TEMPLATE_ACTIVITY_STORE_PY,
  TEMPLATE_ANALYST_PY,
  TEMPLATE_MODELS_PY,
  TEMPLATE_REQUIREMENTS_TXT,
  TEMPLATE_WEEKLY_SUMMARY_PROMPT,
  TEMPLATE_ENV_EXAMPLE,
  TEMPLATE_README,
} from './templates/github-weekly-summary'

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

type InitFlavor = 'direct_llm' | 'managed_loop' | 'code_runtime' | 'orchestrator' | 'discord' | 'github_weekly_summary'

function readmeTemplate(agentName: string, flavor: InitFlavor): string {
  if (flavor === 'discord') {
    return `# ${agentName}

An always-on Discord bot powered by Claude.

## Setup

### 1. Create a Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application, then go to **Bot** and copy the bot token
3. Under **Privileged Gateway Intents**, enable **Message Content Intent**
4. Go to **OAuth2 > URL Generator**, select \`bot\` scope, then invite to your server

### 2. Get channel IDs

Enable Developer Mode in Discord (Settings > Advanced), then right-click a channel and copy its ID.

### 3. Local development

\`\`\`sh
cp .env.example .env
# Fill in DISCORD_BOT_TOKEN, ANTHROPIC_API_KEY, DISCORD_CHANNEL_IDS

pip install -r requirements.txt
python main.py
\`\`\`

### 4. Deploy

\`\`\`sh
orch publish

# Add secrets in your workspace (web dashboard > Settings > Secrets):
#   DISCORD_BOT_TOKEN — your bot token
#   DISCORD_CHANNEL_IDS — comma-separated channel IDs

orch service deploy
\`\`\`

## Customization

Edit \`main.py\` to customize:

- **SYSTEM_PROMPT** — controls how the bot responds
- **MODEL** / **MAX_TOKENS** — override via env vars

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| \`DISCORD_BOT_TOKEN\` | Yes | Discord bot token (workspace secret) |
| \`ANTHROPIC_API_KEY\` | Auto | Injected by orchagent via \`supported_providers\` |
| \`DISCORD_CHANNEL_IDS\` | Yes | Comma-separated channel IDs (workspace secret) |
| \`MODEL\` | No | Claude model (default: claude-sonnet-4-5-20250929) |
| \`MAX_TOKENS\` | No | Max response tokens (default: 1024) |
`
  }

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

const DISCORD_MAIN_PY = `"""
Discord bot agent — powered by Claude.

Listens for messages in configured channels and responds using the Anthropic API.

Local development:
  1. Copy .env.example to .env and fill in your tokens
  2. pip install -r requirements.txt
  3. python main.py
"""

import asyncio
import logging
import os
import sys

import anthropic
import discord

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DISCORD_BOT_TOKEN = os.environ.get("DISCORD_BOT_TOKEN", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
DISCORD_CHANNEL_IDS = os.environ.get("DISCORD_CHANNEL_IDS", "")

MODEL = os.environ.get("MODEL", "claude-sonnet-4-5-20250929")
MAX_TOKENS = int(os.environ.get("MAX_TOKENS", "1024"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("discord-bot")

SYSTEM_PROMPT = """\\
You are a helpful assistant in a Discord server.

Be concise and friendly. Use code blocks for code examples.
Keep responses under 1800 characters (Discord limit is 2000)."""


# ---------------------------------------------------------------------------
# Anthropic API
# ---------------------------------------------------------------------------


def ask_claude(client: anthropic.Anthropic, user_message: str) -> str:
    """Send a message to Claude and return the response."""
    response = client.messages.create(
        model=MODEL,
        max_tokens=MAX_TOKENS,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_message}],
    )
    return response.content[0].text


# ---------------------------------------------------------------------------
# Discord bot
# ---------------------------------------------------------------------------


def parse_channel_ids(raw: str) -> set[int]:
    """Parse comma-separated channel IDs from env var."""
    return {int(x.strip()) for x in raw.split(",") if x.strip().isdigit()}


class Bot(discord.Client):
    def __init__(self, anthropic_client: anthropic.Anthropic, allowed_channels: set[int]):
        intents = discord.Intents.default()
        intents.message_content = True
        super().__init__(intents=intents)
        self.anthropic_client = anthropic_client
        self.allowed_channels = allowed_channels

    async def on_ready(self):
        logger.info("Bot connected as %s", self.user)

    async def on_message(self, message: discord.Message):
        if message.author.bot or not message.content.strip():
            return

        # Only respond in allowed channels (or threads within them)
        channel_id = message.channel.id
        parent_id = getattr(message.channel, "parent_id", None)
        if channel_id not in self.allowed_channels and parent_id not in self.allowed_channels:
            return

        logger.info("Message from %s: %.100s", message.author, message.content)

        async with message.channel.typing():
            try:
                answer = await asyncio.to_thread(
                    ask_claude, self.anthropic_client, message.content
                )
            except anthropic.APIError as exc:
                logger.error("Anthropic API error: %s", exc)
                await message.reply("Sorry, I ran into an issue. Please try again.")
                return

        if len(answer) > 1900:
            answer = answer[:1897] + "..."

        await message.reply(answer)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main():
    if not DISCORD_BOT_TOKEN:
        logger.error("DISCORD_BOT_TOKEN not set")
        sys.exit(1)
    if not ANTHROPIC_API_KEY:
        logger.error("ANTHROPIC_API_KEY not set")
        sys.exit(1)
    if not DISCORD_CHANNEL_IDS:
        logger.error("DISCORD_CHANNEL_IDS not set — add comma-separated channel IDs")
        sys.exit(1)

    allowed = parse_channel_ids(DISCORD_CHANNEL_IDS)
    if not allowed:
        logger.error("No valid channel IDs in DISCORD_CHANNEL_IDS=%r", DISCORD_CHANNEL_IDS)
        sys.exit(1)

    logger.info("Starting bot — model: %s, channels: %s", MODEL, allowed)

    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    bot = Bot(client, allowed)
    bot.run(DISCORD_BOT_TOKEN, log_handler=None)


if __name__ == "__main__":
    main()
`

const DISCORD_REQUIREMENTS = `discord.py>=2.3.0,<3.0.0
anthropic>=0.40.0,<1.0.0
`

const DISCORD_ENV_EXAMPLE = `# Required — get your bot token from https://discord.com/developers/applications
DISCORD_BOT_TOKEN=

# Required for local dev — auto-injected in production via supported_providers
ANTHROPIC_API_KEY=

# Required — comma-separated Discord channel IDs where the bot should respond
DISCORD_CHANNEL_IDS=

# Optional — customize the model and response length
# MODEL=claude-sonnet-4-5-20250929
# MAX_TOKENS=1024
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
    .option('--template <name>', 'Start from a template (available: github-weekly-summary, discord)')
    .action(async (name: string | undefined, options: { type: string; orchestrator?: boolean; runMode: string; template?: string }) => {
      const cwd = process.cwd()
      let runMode = (options.runMode || 'on_demand').trim().toLowerCase()
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

      if (options.template) {
        const template = options.template.trim().toLowerCase()
        const validTemplates = ['discord', 'github-weekly-summary']
        if (!validTemplates.includes(template)) {
          throw new CliError(`Unknown --template '${template}'. Available templates: ${validTemplates.join(', ')}`)
        }
        if (options.orchestrator) {
          throw new CliError('Cannot use --template with --orchestrator.')
        }
        if (initMode.type === 'skill') {
          throw new CliError('Cannot use --template with --type skill.')
        }
        if (template === 'discord') {
          initMode = { type: 'agent', flavor: 'discord' }
          runMode = 'always_on'
        } else if (template === 'github-weekly-summary') {
          initMode = { type: 'agent', flavor: 'github_weekly_summary' }
        }
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

      // Handle github-weekly-summary template separately (own file set + output)
      if (initMode.flavor === 'github_weekly_summary') {
        const manifestPath = path.join(targetDir, 'orchagent.json')

        // Check if already initialized
        try {
          await fs.access(manifestPath)
          throw new CliError(`Already initialized (orchagent.json exists in ${name ? name + '/' : 'current directory'})`)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw err
          }
        }

        const sub = (s: string) => s.replace(/\{\{name\}\}/g, agentName)

        // Create prompts/ subdirectory
        await fs.mkdir(path.join(targetDir, 'prompts'), { recursive: true })

        // Write all files
        await fs.writeFile(manifestPath, sub(TEMPLATE_MANIFEST))
        await fs.writeFile(path.join(targetDir, 'main.py'), TEMPLATE_MAIN_PY)
        await fs.writeFile(path.join(targetDir, 'config.py'), TEMPLATE_CONFIG_PY)
        await fs.writeFile(path.join(targetDir, 'github_fetcher.py'), TEMPLATE_GITHUB_FETCHER_PY)
        await fs.writeFile(path.join(targetDir, 'activity_store.py'), TEMPLATE_ACTIVITY_STORE_PY)
        await fs.writeFile(path.join(targetDir, 'analyst.py'), TEMPLATE_ANALYST_PY)
        await fs.writeFile(path.join(targetDir, 'models.py'), TEMPLATE_MODELS_PY)
        await fs.writeFile(path.join(targetDir, 'requirements.txt'), TEMPLATE_REQUIREMENTS_TXT)
        await fs.writeFile(path.join(targetDir, 'prompts', 'weekly_summary.md'), TEMPLATE_WEEKLY_SUMMARY_PROMPT)
        await fs.writeFile(path.join(targetDir, '.env.example'), sub(TEMPLATE_ENV_EXAMPLE))
        await fs.writeFile(path.join(targetDir, 'README.md'), sub(TEMPLATE_README))

        const prefix = name ? name + '/' : ''
        process.stdout.write(`\nInitialized github-weekly-summary agent "${agentName}" in ${targetDir}\n`)
        process.stdout.write(`\nFiles created:\n`)
        process.stdout.write(`  ${prefix}orchagent.json            Agent manifest\n`)
        process.stdout.write(`  ${prefix}main.py                   Entrypoint\n`)
        process.stdout.write(`  ${prefix}config.py                 Config loader\n`)
        process.stdout.write(`  ${prefix}github_fetcher.py         GitHub API client\n`)
        process.stdout.write(`  ${prefix}activity_store.py         Stats computation\n`)
        process.stdout.write(`  ${prefix}analyst.py                LLM summary generator\n`)
        process.stdout.write(`  ${prefix}models.py                 Data models\n`)
        process.stdout.write(`  ${prefix}requirements.txt          Python dependencies\n`)
        process.stdout.write(`  ${prefix}prompts/weekly_summary.md LLM prompt template\n`)
        process.stdout.write(`  ${prefix}.env.example              Secret reference\n`)
        process.stdout.write(`  ${prefix}README.md                 Setup guide\n`)

        process.stdout.write(`\nNext steps:\n`)
        const s = name ? 2 : 1
        if (name) {
          process.stdout.write(`  1. cd ${name}\n`)
        }
        process.stdout.write(`  ${s}. orch github connect                  Connect your GitHub account\n`)
        process.stdout.write(`  ${s + 1}. orch publish                          Publish the agent\n`)
        process.stdout.write(`  ${s + 2}. Add secrets in web dashboard          ORCHAGENT_API_KEY, DISCORD_WEBHOOK_URL, ANTHROPIC_API_KEY, GITHUB_REPOS\n`)
        process.stdout.write(`  ${s + 3}. orch run <org>/${agentName}            Test it\n`)
        process.stdout.write(`  ${s + 4}. orch schedule create <org>/${agentName} --cron "0 9 * * 1"   Schedule weekly\n`)
        process.stdout.write(`\n  See README.md for full setup guide.\n`)
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

      if (initMode.flavor !== 'code_runtime' && initMode.flavor !== 'orchestrator' && initMode.flavor !== 'discord' && runMode === 'always_on') {
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
      } else if (initMode.flavor === 'discord') {
        manifest.description = 'An always-on Discord bot powered by Claude'
        manifest.runtime = { command: 'python main.py' }
        manifest.supported_providers = ['anthropic']
        manifest.required_secrets = ['DISCORD_BOT_TOKEN', 'DISCORD_CHANNEL_IDS']
        manifest.tags = ['discord', 'always-on']
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
      } else if (initMode.flavor === 'discord') {
        const entrypointPath = path.join(targetDir, 'main.py')
        const requirementsPath = path.join(targetDir, 'requirements.txt')
        const envExamplePath = path.join(targetDir, '.env.example')
        await fs.writeFile(entrypointPath, DISCORD_MAIN_PY)
        await fs.writeFile(requirementsPath, DISCORD_REQUIREMENTS)
        await fs.writeFile(envExamplePath, DISCORD_ENV_EXAMPLE)
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
      } else if (initMode.flavor === 'discord') {
        process.stdout.write(`  ${prefix}main.py           - Discord bot (discord.py + Anthropic)\n`)
        process.stdout.write(`  ${prefix}requirements.txt  - Python dependencies\n`)
        process.stdout.write(`  ${prefix}.env.example      - Environment variables template\n`)
      } else if (initMode.flavor === 'code_runtime') {
        process.stdout.write(`  ${prefix}main.py           - Agent entrypoint (stdin/stdout JSON)\n`)
      } else {
        process.stdout.write(`  ${prefix}prompt.md         - Prompt template\n`)
      }
      if (initMode.flavor !== 'discord') {
        process.stdout.write(`  ${prefix}schema.json       - Input/output schemas\n`)
      }
      process.stdout.write(`  ${prefix}README.md         - Agent documentation\n`)
      process.stdout.write(`  Run mode: ${runMode}\n`)
      process.stdout.write(`  Execution: ${initMode.flavor === 'orchestrator' ? 'code_runtime (orchestrator)' : initMode.flavor === 'discord' ? 'code_runtime (discord)' : initMode.flavor}\n`)
      process.stdout.write(`\nNext steps:\n`)
      if (initMode.flavor === 'orchestrator') {
        const stepNum = name ? 2 : 1
        if (name) {
          process.stdout.write(`  1. cd ${name}\n`)
        }
        process.stdout.write(`  ${stepNum}. Update manifest.dependencies in orchagent.json with your actual agents\n`)
        process.stdout.write(`  ${stepNum + 1}. Edit main.py with your orchestration logic\n`)
        process.stdout.write(`  ${stepNum + 2}. Publish dependency agents first, then: orchagent publish\n`)
      } else if (initMode.flavor === 'discord') {
        const stepNum = name ? 2 : 1
        if (name) {
          process.stdout.write(`  1. cd ${name}\n`)
        }
        process.stdout.write(`  ${stepNum}. Create a Discord bot at https://discord.com/developers/applications\n`)
        process.stdout.write(`  ${stepNum + 1}. Enable Message Content Intent in bot settings\n`)
        process.stdout.write(`  ${stepNum + 2}. Copy .env.example to .env and fill in your tokens\n`)
        process.stdout.write(`  ${stepNum + 3}. Test locally: pip install -r requirements.txt && python main.py\n`)
        process.stdout.write(`  ${stepNum + 4}. Deploy: orch publish\n`)
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
