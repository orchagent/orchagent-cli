import { Command } from 'commander'
import fs from 'fs/promises'
import path from 'path'

import { CliError } from '../lib/errors'
import { runInitWizard, printTemplateList } from './init-wizard'
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
import {
  CRON_JOB_MAIN_PY,
  CRON_JOB_MAIN_JS,
  CRON_JOB_SCHEMA,
  cronJobReadme,
} from './templates/cron-job'
import {
  SA_CONFIG_PY,
  SA_BRAIN_PY,
  SA_DISCORD_CONNECTOR_PY,
  SA_TELEGRAM_CONNECTOR_PY,
  SA_SLACK_CONNECTOR_PY,
  SA_MAIN_PY,
  SA_REQUIREMENTS,
  SA_OVERVIEW_MD,
  SA_FAQ_MD,
  SA_ENV_EXAMPLE,
} from './templates/support-agent'

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
  echo '{"input": "hello"}' | python3 main.py
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

const CODE_TEMPLATE_JS = `/**
 * orchagent tool entrypoint.
 *
 * Reads JSON input from stdin, processes it, and writes JSON output to stdout.
 * This is the standard orchagent tool protocol.
 *
 * Usage:
 *   echo '{"input": "hello"}' | node main.js
 */

const fs = require('fs');

function main() {
  const raw = fs.readFileSync('/dev/stdin', 'utf-8');
  let data;
  try {
    data = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    console.log(JSON.stringify({ error: 'Invalid JSON input' }));
    process.exit(1);
  }

  const input = data.input || '';

  // --- Your logic here ---
  // To use workspace secrets, add them to "required_secrets" in orchagent.json:
  //   "required_secrets": ["MY_API_KEY"]
  // Then access via: process.env.MY_API_KEY
  const result = \`Received: \${input}\`;
  // --- End your logic ---

  console.log(JSON.stringify({ result }));
}

main();
`

const ALWAYS_ON_TEMPLATE_PY = `"""
orchagent always-on service entrypoint.

Runs a long-lived HTTP server that handles requests over HTTP.
This is the standard pattern for always-on services on orchagent.

IMPORTANT: Port 8080 is reserved by the platform health server.
           Use a different port (default: 3000).

Local development:
  python3 main.py
"""

import json
import os
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = int(os.environ.get("PORT", "3000"))


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)
        try:
            data = json.loads(body) if body else {}
        except json.JSONDecodeError:
            self._respond(400, {"error": "Invalid JSON"})
            return

        user_input = data.get("input", "")

        # --- Your logic here ---
        # To use workspace secrets, add them to "required_secrets" in orchagent.json:
        #   "required_secrets": ["MY_API_KEY"]
        # Then access via: os.environ["MY_API_KEY"]
        result = f"Received: {user_input}"
        # --- End your logic ---

        self._respond(200, {"result": result})

    def do_GET(self):
        if self.path == "/health":
            self._respond(200, {"status": "ok"})
            return
        self._respond(200, {"status": "running"})

    def _respond(self, code, body):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def log_message(self, format, *args):
        print(f"[{self.log_date_time_string()}] {format % args}")


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Always-on service listening on port {PORT}")
    server.serve_forever()
`

const ALWAYS_ON_TEMPLATE_JS = `/**
 * orchagent always-on service entrypoint.
 *
 * Runs a long-lived HTTP server that handles requests over HTTP.
 * This is the standard pattern for always-on services on orchagent.
 *
 * IMPORTANT: Port 8080 is reserved by the platform health server.
 *            Use a different port (default: 3000).
 *
 * Local development:
 *   node main.js
 */

const http = require('http');

const PORT = parseInt(process.env.PORT || '3000', 10);

const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'running' }));
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let data;
      try {
        data = body ? JSON.parse(body) : {};
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const input = data.input || '';

      // --- Your logic here ---
      // To use workspace secrets, add them to "required_secrets" in orchagent.json:
      //   "required_secrets": ["MY_API_KEY"]
      // Then access via: process.env.MY_API_KEY
      const result = \`Received: \${input}\`;
      // --- End your logic ---

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result }));
    });
    return;
  }

  res.writeHead(405, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Method not allowed' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(\`Always-on service listening on port \${PORT}\`);
});
`

const DISCORD_MAIN_JS = `/**
 * Discord bot agent — powered by Claude.
 *
 * Listens for messages in configured channels and responds using the Anthropic API.
 *
 * Local development:
 *   1. Copy .env.example to .env and fill in your tokens
 *   2. npm install
 *   3. node main.js
 */

const { Client, GatewayIntentBits } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const DISCORD_CHANNEL_IDS = process.env.DISCORD_CHANNEL_IDS || '';

const MODEL = process.env.MODEL || 'claude-sonnet-4-5-20250929';
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || '1024', 10);

const SYSTEM_PROMPT = \`\\
You are a helpful assistant in a Discord server.

Be concise and friendly. Use code blocks for code examples.
Keep responses under 1800 characters (Discord limit is 2000).\`;


// ---------------------------------------------------------------------------
// Anthropic API
// ---------------------------------------------------------------------------

async function askClaude(client, userMessage) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });
  return response.content[0].text;
}


// ---------------------------------------------------------------------------
// Discord bot
// ---------------------------------------------------------------------------

function parseChannelIds(raw) {
  return new Set(
    raw.split(',')
      .map(s => s.trim())
      .filter(s => /^\\d+$/.test(s))
  );
}

function main() {
  if (!DISCORD_BOT_TOKEN) {
    console.error('DISCORD_BOT_TOKEN not set');
    process.exit(1);
  }
  if (!ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set');
    process.exit(1);
  }
  if (!DISCORD_CHANNEL_IDS) {
    console.error('DISCORD_CHANNEL_IDS not set — add comma-separated channel IDs');
    process.exit(1);
  }

  const allowedChannels = parseChannelIds(DISCORD_CHANNEL_IDS);
  if (allowedChannels.size === 0) {
    console.error('No valid channel IDs in DISCORD_CHANNEL_IDS:', DISCORD_CHANNEL_IDS);
    process.exit(1);
  }

  console.log(\`Starting bot — model: \${MODEL}, channels: \${[...allowedChannels].join(', ')}\`);

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const bot = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  bot.on('ready', () => {
    console.log(\`Bot connected as \${bot.user.tag}\`);
  });

  bot.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content.trim()) return;

    const channelId = message.channelId;
    const parentId = message.channel.parentId;
    if (!allowedChannels.has(channelId) && !allowedChannels.has(parentId)) return;

    console.log(\`Message from \${message.author.tag}: \${message.content.slice(0, 100)}\`);

    try {
      await message.channel.sendTyping();
      const answer = await askClaude(anthropic, message.content);
      const trimmed = answer.length > 1900 ? answer.slice(0, 1897) + '...' : answer;
      await message.reply(trimmed);
    } catch (err) {
      console.error('Anthropic API error:', err.message || err);
      await message.reply('Sorry, I ran into an issue. Please try again.');
    }
  });

  bot.login(DISCORD_BOT_TOKEN);
}

main();
`

const DISCORD_PACKAGE_JSON = `{
  "name": "discord-bot",
  "private": true,
  "type": "commonjs",
  "dependencies": {
    "discord.js": "^14.16.0",
    "@anthropic-ai/sdk": "^0.30.0"
  }
}
`

const DISCORD_JS_ENV_EXAMPLE = `# Required — get your bot token from https://discord.com/developers/applications
DISCORD_BOT_TOKEN=

# Required — add to workspace secrets: orch secrets set ANTHROPIC_API_KEY <key>
ANTHROPIC_API_KEY=

# Required — comma-separated Discord channel IDs where the bot should respond
DISCORD_CHANNEL_IDS=

# Optional — customize the model and response length
# MODEL=claude-sonnet-4-5-20250929
# MAX_TOKENS=1024
`

// ---------------------------------------------------------------------------
// Orchestration templates: fan-out, pipeline, map-reduce
// ---------------------------------------------------------------------------

const FANOUT_MAIN_PY = `"""
orchagent fan-out orchestrator.

Calls multiple agents in parallel, combines their results.

Usage:
  echo '{"task": "analyze this"}' | python3 main.py
"""

import asyncio
import json
import sys

# pip install orchagent-sdk  (package name)
from orchagent import AgentClient  # module name


async def run():
    raw = sys.stdin.read()
    try:
        data = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        print(json.dumps({"error": "Invalid JSON input"}))
        sys.exit(1)

    task = data.get("task", "")
    client = AgentClient()

    # Fan-out: call all agents in parallel
    # Replace these with your actual dependencies (must match manifest.dependencies)
    agent_a, agent_b, agent_c = await asyncio.gather(
        client.call("org/agent-a@v1", {"task": task}),
        client.call("org/agent-b@v1", {"task": task}),
        client.call("org/agent-c@v1", {"task": task}),
    )

    # Combine results
    print(json.dumps({
        "results": [agent_a, agent_b, agent_c],
        "summary": f"Collected results from 3 agents",
        "success": True,
    }))


if __name__ == "__main__":
    asyncio.run(run())
`

const FANOUT_MAIN_JS = `/**
 * orchagent fan-out orchestrator.
 *
 * Calls multiple agents in parallel, combines their results.
 *
 * Usage:
 *   echo '{"task": "analyze this"}' | node main.js
 */

const fs = require('fs');
const { AgentClient } = require('orchagent-sdk');

async function main() {
  const raw = fs.readFileSync('/dev/stdin', 'utf-8');
  let data;
  try {
    data = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    console.log(JSON.stringify({ error: 'Invalid JSON input' }));
    process.exit(1);
  }

  const task = data.task || '';
  const client = new AgentClient();

  // Fan-out: call all agents in parallel
  // Replace these with your actual dependencies (must match manifest.dependencies)
  const [agentA, agentB, agentC] = await Promise.all([
    client.call('org/agent-a@v1', { task }),
    client.call('org/agent-b@v1', { task }),
    client.call('org/agent-c@v1', { task }),
  ]);

  console.log(JSON.stringify({
    results: [agentA, agentB, agentC],
    summary: 'Collected results from 3 agents',
    success: true,
  }));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
`

const PIPELINE_MAIN_PY = `"""
orchagent pipeline orchestrator.

Calls agents sequentially — each step's output feeds into the next.

Usage:
  echo '{"task": "process this data"}' | python3 main.py
"""

import asyncio
import json
import sys

# pip install orchagent-sdk  (package name)
from orchagent import AgentClient  # module name


async def run():
    raw = sys.stdin.read()
    try:
        data = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        print(json.dumps({"error": "Invalid JSON input"}))
        sys.exit(1)

    task = data.get("task", "")
    client = AgentClient()

    # Pipeline: each step feeds into the next
    # Replace these with your actual dependencies (must match manifest.dependencies)
    step1 = await client.call("org/parser@v1", {"input": task})
    step2 = await client.call("org/analyzer@v1", {"input": step1})
    step3 = await client.call("org/reporter@v1", {"input": step2})

    print(json.dumps({
        "result": step3,
        "steps_completed": 3,
        "success": True,
    }))


if __name__ == "__main__":
    asyncio.run(run())
`

const PIPELINE_MAIN_JS = `/**
 * orchagent pipeline orchestrator.
 *
 * Calls agents sequentially — each step's output feeds into the next.
 *
 * Usage:
 *   echo '{"task": "process this data"}' | node main.js
 */

const fs = require('fs');
const { AgentClient } = require('orchagent-sdk');

async function main() {
  const raw = fs.readFileSync('/dev/stdin', 'utf-8');
  let data;
  try {
    data = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    console.log(JSON.stringify({ error: 'Invalid JSON input' }));
    process.exit(1);
  }

  const task = data.task || '';
  const client = new AgentClient();

  // Pipeline: each step feeds into the next
  // Replace these with your actual dependencies (must match manifest.dependencies)
  const step1 = await client.call('org/parser@v1', { input: task });
  const step2 = await client.call('org/analyzer@v1', { input: step1 });
  const step3 = await client.call('org/reporter@v1', { input: step2 });

  console.log(JSON.stringify({
    result: step3,
    steps_completed: 3,
    success: true,
  }));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
`

const MAPREDUCE_MAIN_PY = `"""
orchagent map-reduce orchestrator.

Splits input into chunks, processes each in parallel (map), then aggregates (reduce).

Usage:
  echo '{"items": ["item1", "item2", "item3"]}' | python3 main.py
"""

import asyncio
import json
import sys

# pip install orchagent-sdk  (package name)
from orchagent import AgentClient  # module name


async def run():
    raw = sys.stdin.read()
    try:
        data = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        print(json.dumps({"error": "Invalid JSON input"}))
        sys.exit(1)

    items = data.get("items", [])
    if not items:
        print(json.dumps({"error": "No items to process", "success": False}))
        sys.exit(1)

    client = AgentClient()

    # Map: process each item in parallel
    # Replace with your actual dependency (must match manifest.dependencies)
    mapped = await asyncio.gather(
        *[client.call("org/processor@v1", {"item": item}) for item in items]
    )

    # Reduce: aggregate results into a single output
    # Replace with your actual dependency (must match manifest.dependencies)
    reduced = await client.call("org/aggregator@v1", {"results": mapped})

    print(json.dumps({
        "result": reduced,
        "items_processed": len(items),
        "success": True,
    }))


if __name__ == "__main__":
    asyncio.run(run())
`

const MAPREDUCE_MAIN_JS = `/**
 * orchagent map-reduce orchestrator.
 *
 * Splits input into chunks, processes each in parallel (map), then aggregates (reduce).
 *
 * Usage:
 *   echo '{"items": ["item1", "item2", "item3"]}' | node main.js
 */

const fs = require('fs');
const { AgentClient } = require('orchagent-sdk');

async function main() {
  const raw = fs.readFileSync('/dev/stdin', 'utf-8');
  let data;
  try {
    data = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    console.log(JSON.stringify({ error: 'Invalid JSON input' }));
    process.exit(1);
  }

  const items = data.items || [];
  if (!items.length) {
    console.log(JSON.stringify({ error: 'No items to process', success: false }));
    process.exit(1);
  }

  const client = new AgentClient();

  // Map: process each item in parallel
  // Replace with your actual dependency (must match manifest.dependencies)
  const mapped = await Promise.all(
    items.map(item => client.call('org/processor@v1', { item }))
  );

  // Reduce: aggregate results into a single output
  // Replace with your actual dependency (must match manifest.dependencies)
  const reduced = await client.call('org/aggregator@v1', { results: mapped });

  console.log(JSON.stringify({
    result: reduced,
    items_processed: items.length,
    success: true,
  }));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
`

const FANOUT_SCHEMA = `{
  "input": {
    "type": "object",
    "properties": {
      "task": {
        "type": "string",
        "description": "The task to fan out to all agents"
      }
    },
    "required": ["task"]
  },
  "output": {
    "type": "object",
    "properties": {
      "results": {
        "type": "array",
        "description": "Results from each agent"
      },
      "summary": {
        "type": "string",
        "description": "Summary of combined results"
      },
      "success": {
        "type": "boolean",
        "description": "Whether all agents completed successfully"
      }
    },
    "required": ["results", "success"]
  }
}
`

const PIPELINE_SCHEMA = `{
  "input": {
    "type": "object",
    "properties": {
      "task": {
        "type": "string",
        "description": "The input to feed into the pipeline"
      }
    },
    "required": ["task"]
  },
  "output": {
    "type": "object",
    "properties": {
      "result": {
        "type": "object",
        "description": "Final output from the last pipeline step"
      },
      "steps_completed": {
        "type": "integer",
        "description": "Number of pipeline steps completed"
      },
      "success": {
        "type": "boolean",
        "description": "Whether the pipeline completed successfully"
      }
    },
    "required": ["result", "success"]
  }
}
`

const MAPREDUCE_SCHEMA = `{
  "input": {
    "type": "object",
    "properties": {
      "items": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Items to process in parallel"
      }
    },
    "required": ["items"]
  },
  "output": {
    "type": "object",
    "properties": {
      "result": {
        "type": "object",
        "description": "Aggregated result from all processed items"
      },
      "items_processed": {
        "type": "integer",
        "description": "Number of items processed"
      },
      "success": {
        "type": "boolean",
        "description": "Whether all items were processed successfully"
      }
    },
    "required": ["result", "success"]
  }
}
`

const AGENT_BUILDER_HINT = `\n  Tip: orch skill install orchagent-public/agent-builder — gives your AI the full platform builder reference\n`

type InitFlavor = 'direct_llm' | 'managed_loop' | 'code_runtime' | 'orchestrator' | 'discord' | 'discord_js' | 'support_agent' | 'github_weekly_summary' | 'fan_out' | 'pipeline' | 'map_reduce' | 'cron_job'

function readmeTemplate(agentName: string, flavor: InitFlavor, type?: string): string {
  if (flavor === 'support_agent') {
    return `# ${agentName}

A multi-platform support agent powered by Claude. Connects to Discord, Telegram, and/or Slack.

## Setup

### 1. Customize

Edit \`config.py\` — set your product name, description, and bot name.

### 2. Add Knowledge

Replace the example files in \`knowledge/\` with your own docs.
Files named \`NN-topic-name.md\` auto-discover as topics.

### 3. Set Platform Tokens

Copy \`.env.example\` to \`.env\` and fill in tokens for the platforms you want.
At least one platform token is required.

### 4. Run Locally

\`\`\`sh
pip install -r requirements.txt
python3 main.py
\`\`\`

### 5. Deploy

\`\`\`sh
orch publish
# Add secrets in your workspace (web dashboard > Settings > Secrets)
orch service deploy
\`\`\`

## Platforms

| Platform | Token Required | Extra Config |
|----------|---------------|--------------|
| Discord | \`DISCORD_BOT_TOKEN\` | \`DISCORD_CHANNEL_IDS\` |
| Telegram | \`TELEGRAM_BOT_TOKEN\` | — |
| Slack | \`SLACK_BOT_TOKEN\` | \`SLACK_APP_TOKEN\` |
`
  }

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
python3 main.py
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
| \`ANTHROPIC_API_KEY\` | Yes | Anthropic API key (workspace secret via \`required_secrets\`) |
| \`DISCORD_CHANNEL_IDS\` | Yes | Comma-separated channel IDs (workspace secret) |
| \`MODEL\` | No | Claude model (default: claude-sonnet-4-5-20250929) |
| \`MAX_TOKENS\` | No | Max response tokens (default: 1024) |
`
  }

  if (flavor === 'discord_js') {
    return `# ${agentName}

An always-on Discord bot powered by Claude (JavaScript).

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

npm install
node main.js
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

Edit \`main.js\` to customize:

- **SYSTEM_PROMPT** — controls how the bot responds
- **MODEL** / **MAX_TOKENS** — override via env vars

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| \`DISCORD_BOT_TOKEN\` | Yes | Discord bot token (workspace secret) |
| \`ANTHROPIC_API_KEY\` | Yes | Anthropic API key (workspace secret via \`required_secrets\`) |
| \`DISCORD_CHANNEL_IDS\` | Yes | Comma-separated channel IDs (workspace secret) |
| \`MODEL\` | No | Claude model (default: claude-sonnet-4-5-20250929) |
| \`MAX_TOKENS\` | No | Max response tokens (default: 1024) |
`
  }

  const usesTask = flavor === 'managed_loop' || flavor === 'orchestrator' || type === 'agent'
  const inputField = usesTask ? 'task' : 'input'
  const inputDescription = usesTask ? 'The task to perform' : 'The input to process'
  const cloudExample = `orchagent run ${agentName} --data '{"${inputField}": "Hello world"}'`
  const localExample = `orchagent run ${agentName} --local --data '{"${inputField}": "Hello world"}'`

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

  if (flavor === 'fan_out') {
    readme += `
## Pattern: Fan-Out

This orchestrator calls multiple agents **in parallel** and combines their results. Use this when you have independent tasks that can run concurrently.

\`\`\`
Input ──┬──> Agent A ──┐
        ├──> Agent B ──┼──> Combined Results
        └──> Agent C ──┘
\`\`\`

## Dependencies

Update \`manifest.dependencies\` in \`orchagent.json\` with your actual agents.

**Publish order:** Publish dependency agents first, then this orchestrator.

| Dependency | Version | Description |
|------------|---------|-------------|
| \`org/agent-a\` | v1 | TODO: describe |
| \`org/agent-b\` | v1 | TODO: describe |
| \`org/agent-c\` | v1 | TODO: describe |
`
  }

  if (flavor === 'pipeline') {
    readme += `
## Pattern: Pipeline

This orchestrator calls agents **sequentially** — each step's output feeds into the next. Use this when data must flow through ordered processing stages.

\`\`\`
Input ──> Parser ──> Analyzer ──> Reporter ──> Output
\`\`\`

## Dependencies

Update \`manifest.dependencies\` in \`orchagent.json\` with your actual agents.

**Publish order:** Publish dependency agents first, then this orchestrator.

| Dependency | Version | Description |
|------------|---------|-------------|
| \`org/parser\` | v1 | TODO: describe |
| \`org/analyzer\` | v1 | TODO: describe |
| \`org/reporter\` | v1 | TODO: describe |
`
  }

  if (flavor === 'map_reduce') {
    readme += `
## Pattern: Map-Reduce

This orchestrator **splits input** into items, processes each in **parallel** (map), then **aggregates** the results (reduce).

\`\`\`
Items ──┬──> Processor (item 1) ──┐
        ├──> Processor (item 2) ──┼──> Aggregator ──> Output
        └──> Processor (item N) ──┘
\`\`\`

## Dependencies

Update \`manifest.dependencies\` in \`orchagent.json\` with your actual agents.

**Publish order:** Publish dependency agents first, then this orchestrator.

| Dependency | Version | Description |
|------------|---------|-------------|
| \`org/processor\` | v1 | Processes individual items |
| \`org/aggregator\` | v1 | Combines processed results |
`
  }

  return readme
}

const AGENT_CODE_TEMPLATE_PY = `"""
orchagent agent entrypoint.

Reads JSON input from stdin, processes the task, and writes JSON output to stdout.
This is a code-runtime agent — you control the logic and can call any LLM provider.

Usage:
  echo '{"task": "summarize this text"}' | python3 main.py
"""

import json
import sys


def main():
    # Read JSON input from stdin
    raw = sys.stdin.read()
    try:
        data = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        print(json.dumps({"error": "Invalid JSON input", "success": False}))
        sys.exit(1)

    task = data.get("task", "")

    # --- Your agent logic here ---
    # This is a code-runtime agent. You write the logic — call any LLM provider,
    # use any library, chain multiple steps, etc.
    #
    # Example (Anthropic):
    #   pip install anthropic
    #   import anthropic
    #   client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from env
    #   response = client.messages.create(model="claude-sonnet-4-5-20250929", ...)
    #
    # Example (OpenAI):
    #   pip install openai
    #   import openai
    #   client = openai.OpenAI()  # reads OPENAI_API_KEY from env
    #   response = client.chat.completions.create(model="gpt-4o", ...)
    #
    # To use workspace secrets, add them to "required_secrets" in orchagent.json:
    #   "required_secrets": ["ANTHROPIC_API_KEY"]
    # Then access via: os.environ["ANTHROPIC_API_KEY"]
    result = f"Received task: {task}"
    # --- End your logic ---

    # Write JSON output to stdout
    print(json.dumps({"result": result, "success": True}))


if __name__ == "__main__":
    main()
`

const AGENT_CODE_TEMPLATE_JS = `/**
 * orchagent agent entrypoint.
 *
 * Reads JSON input from stdin, processes the task, and writes JSON output to stdout.
 * This is a code-runtime agent — you control the logic and can call any LLM provider.
 *
 * Usage:
 *   echo '{"task": "summarize this text"}' | node main.js
 */

const fs = require('fs');

function main() {
  const raw = fs.readFileSync('/dev/stdin', 'utf-8');
  let data;
  try {
    data = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    console.log(JSON.stringify({ error: 'Invalid JSON input', success: false }));
    process.exit(1);
  }

  const task = data.task || '';

  // --- Your agent logic here ---
  // This is a code-runtime agent. You write the logic — call any LLM provider,
  // use any library, chain multiple steps, etc.
  //
  // Example (Anthropic):
  //   npm install @anthropic-ai/sdk
  //   const Anthropic = require('@anthropic-ai/sdk');
  //   const client = new Anthropic();  // reads ANTHROPIC_API_KEY from env
  //
  // Example (OpenAI):
  //   npm install openai
  //   const OpenAI = require('openai');
  //   const client = new OpenAI();  // reads OPENAI_API_KEY from env
  //
  // To use workspace secrets, add them to "required_secrets" in orchagent.json:
  //   "required_secrets": ["ANTHROPIC_API_KEY"]
  // Then access via: process.env.ANTHROPIC_API_KEY
  const result = \`Received task: \${task}\`;
  // --- End your logic ---

  console.log(JSON.stringify({ result, success: true }));
}

main();
`

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
  echo '{"task": "do something"}' | python3 main.py
"""

import asyncio
import json
import sys

# pip install orchagent-sdk  (package name)
from orchagent import AgentClient  # module name


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

const ORCHESTRATOR_MAIN_JS = `/**
 * orchagent orchestrator entrypoint.
 *
 * Reads JSON input from stdin, calls dependency agents via the orchagent SDK,
 * and writes JSON output to stdout.
 *
 * Usage:
 *   echo '{"task": "do something"}' | node main.js
 */

const fs = require('fs');
const { AgentClient } = require('orchagent-sdk');

async function main() {
  // Read JSON input from stdin
  const raw = fs.readFileSync('/dev/stdin', 'utf-8');
  let data;
  try {
    data = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    console.log(JSON.stringify({ error: 'Invalid JSON input' }));
    process.exit(1);
  }

  const task = data.task || '';

  // --- Your orchestration logic here ---
  // The AgentClient reads ORCHAGENT_SERVICE_KEY from the environment automatically.
  // Do NOT add ORCHAGENT_SERVICE_KEY to required_secrets — the gateway injects it.
  const client = new AgentClient();

  // Call a dependency agent (must be listed in manifest.dependencies)
  const result = await client.call('org/agent-name@v1', { input: task });

  // You can chain multiple calls, run them in parallel, or add conditional logic:
  //
  // Sequential:
  //   const result2 = await client.call('org/another-agent@v1', { input: result });
  //
  // Parallel:
  //   const [r1, r2] = await Promise.all([
  //     client.call('org/agent-a@v1', { input: task }),
  //     client.call('org/agent-b@v1', { input: task }),
  //   ]);
  // --- End orchestration logic ---

  // Write JSON output to stdout
  console.log(JSON.stringify({ result, success: true }));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
`

const ORCHESTRATOR_PACKAGE_JSON = `{
  "name": "orchestrator",
  "private": true,
  "type": "commonjs",
  "dependencies": {
    "orchagent-sdk": "^0.1.0"
  }
}
`

const DISCORD_MAIN_PY = `"""
Discord bot agent — powered by Claude.

Listens for messages in configured channels and responds using the Anthropic API.

Local development:
  1. Copy .env.example to .env and fill in your tokens
  2. pip install -r requirements.txt
  3. python3 main.py
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

# Required — add to workspace secrets: orch secrets set ANTHROPIC_API_KEY <key>
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
  if (normalized === 'agent') {
    return { type: 'agent', flavor: 'managed_loop' }
  }
  if (normalized === 'agentic') {
    return { type: 'agent', flavor: 'code_runtime' }
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
    .description('Initialize a new agent project (interactive wizard when called without arguments)')
    .argument('[name]', 'Agent name (default: current directory name)')
    .option('--type <type>', 'Type: prompt, tool, agent, or skill (legacy aliases: agentic, code)', 'prompt')
    .option('--orchestrator', 'Create an orchestrator agent with dependency scaffolding and SDK boilerplate')
    .option('--run-mode <mode>', 'Run mode for agents: on_demand or always_on', 'on_demand')
    .option('--language <lang>', 'Language: python or javascript (default: python)', 'python')
    .option('--loop', 'Use platform-managed LLM loop execution (explicit for --type agentic; default for --type agent)')
    .option('--template <name>', 'Start from a template (use --list-templates to see options)')
    .option('--list-templates', 'Show available templates with descriptions')
    .action(async (name: string | undefined, options: { type: string; orchestrator?: boolean; loop?: boolean; runMode: string; language: string; template?: string; listTemplates?: boolean }) => {
      // --list-templates: print and exit
      if (options.listTemplates) {
        printTemplateList()
        return
      }

      // Interactive wizard: no name, TTY, and no explicit flags that indicate non-interactive intent
      const rawArgs = process.argv.slice(2)
      const initArgIndex = rawArgs.indexOf('init')
      const argsAfterInit = initArgIndex >= 0 ? rawArgs.slice(initArgIndex + 1) : []
      const hasExplicitFlags = argsAfterInit.some(a => a.startsWith('--'))
      const hasNameArg = name !== undefined

      if (!hasNameArg && !hasExplicitFlags && process.stdin.isTTY) {
        const wizard = await runInitWizard()
        // Re-invoke the action with wizard results by constructing args
        const wizardArgs = ['node', 'orch', 'init']
        if (wizard.name) wizardArgs.push(wizard.name)
        wizardArgs.push('--type', wizard.type)
        wizardArgs.push('--language', wizard.language)
        wizardArgs.push('--run-mode', wizard.runMode)
        if (wizard.template) wizardArgs.push('--template', wizard.template)
        if (wizard.orchestrator) wizardArgs.push('--orchestrator')
        if (wizard.loop) wizardArgs.push('--loop')

        // Create a fresh program to run with wizard args
        const wizardProgram = new Command()
        wizardProgram.exitOverride()
        registerInitCommand(wizardProgram)
        await wizardProgram.parseAsync(wizardArgs)
        return
      }
      const cwd = process.cwd()
      let runMode = (options.runMode || 'on_demand').trim().toLowerCase()
      if (!['on_demand', 'always_on'].includes(runMode)) {
        throw new CliError("Invalid --run-mode. Use 'on_demand' or 'always_on'.")
      }
      let initMode: { type: 'prompt' | 'tool' | 'agent' | 'skill'; flavor?: InitFlavor } = resolveInitFlavor(options.type)

      if (options.orchestrator) {
        if (initMode.type === 'skill') {
          throw new CliError('Cannot use --orchestrator with --type skill. Orchestrators are agent-type agents that call other agents.')
        }
        initMode = { type: 'agent', flavor: 'orchestrator' }
      }

      if (options.loop) {
        if (options.orchestrator) {
          throw new CliError('Cannot use --loop with --orchestrator. Orchestrators use code runtime with SDK calls.')
        }
        if (initMode.type !== 'agent') {
          throw new CliError('The --loop flag requires --type agent. It enables platform-managed LLM loop execution.')
        }
        initMode = { type: 'agent', flavor: 'managed_loop' }
      }

      if (options.template) {
        const template = options.template.trim().toLowerCase()
        const validTemplates = ['fan-out', 'pipeline', 'map-reduce', 'support-agent', 'discord', 'discord-js', 'github-weekly-summary', 'cron-job']
        if (!validTemplates.includes(template)) {
          throw new CliError(`Unknown --template '${template}'. Available templates: ${validTemplates.join(', ')}`)
        }
        if (options.orchestrator) {
          throw new CliError('Cannot use --template with --orchestrator.')
        }
        if (initMode.type === 'skill') {
          throw new CliError('Cannot use --template with --type skill.')
        }
        if (template === 'fan-out') {
          initMode = { type: 'agent', flavor: 'fan_out' }
        } else if (template === 'pipeline') {
          initMode = { type: 'agent', flavor: 'pipeline' }
        } else if (template === 'map-reduce') {
          initMode = { type: 'agent', flavor: 'map_reduce' }
        } else if (template === 'support-agent') {
          initMode = { type: 'agent', flavor: 'support_agent' }
          runMode = 'always_on'
        } else if (template === 'discord') {
          initMode = { type: 'agent', flavor: 'discord' }
          runMode = 'always_on'
        } else if (template === 'discord-js') {
          initMode = { type: 'agent', flavor: 'discord_js' }
          runMode = 'always_on'
        } else if (template === 'github-weekly-summary') {
          initMode = { type: 'agent', flavor: 'github_weekly_summary' }
        } else if (template === 'cron-job') {
          initMode = { type: 'tool', flavor: 'cron_job' }
        }
      }

      // Validate --language option
      const language = (options.language || 'python').trim().toLowerCase()
      if (!['python', 'javascript', 'js', 'typescript', 'ts'].includes(language)) {
        throw new CliError(`Invalid --language '${options.language}'. Use 'python' or 'javascript'.`)
      }
      const isJavaScript = ['javascript', 'js', 'typescript', 'ts'].includes(language)

      // Block unsupported JS flavors
      if (isJavaScript && initMode.flavor === 'managed_loop') {
        throw new CliError('JavaScript is not supported for managed-loop agents. Use --type agentic for a code-runtime agent scaffold.')
      }
      // JS orchestrators are now supported via the orchagent-sdk npm package

      // Block --language for types that don't create runtime files
      if (isJavaScript && (initMode.type === 'prompt' || initMode.type === 'skill')) {
        throw new CliError(
          `The --language flag has no effect for ${initMode.type} types (no runtime files are created). ` +
          'Use --type tool or --type agent to create a project with runtime scaffolding.'
        )
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

      // Handle support-agent template separately (multi-file structure)
      if (initMode.flavor === 'support_agent') {
        const manifestPath = path.join(targetDir, 'orchagent.json')

        try {
          await fs.access(manifestPath)
          throw new CliError(`Already initialized (orchagent.json exists in ${name ? name + '/' : 'current directory'})`)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw err
          }
        }

        // Create subdirectories
        await fs.mkdir(path.join(targetDir, 'connectors'), { recursive: true })
        await fs.mkdir(path.join(targetDir, 'knowledge'), { recursive: true })

        // Write manifest
        const manifest = {
          name: agentName,
          type: 'agent',
          description: 'Multi-platform support agent powered by Claude. Connects to Discord, Telegram, and/or Slack.',
          run_mode: 'always_on',
          runtime: { command: 'python3 main.py' },
          entrypoint: 'main.py',
          supported_providers: ['anthropic'],
          default_models: { anthropic: 'claude-sonnet-4-5-20250929' },
          required_secrets: ['ANTHROPIC_API_KEY'] as string[],
          tags: ['support', 'discord', 'telegram', 'slack', 'always-on', 'multi-platform'],
          bundle: {
            include: ['*.py', 'connectors/*.py', 'knowledge/*.md', 'requirements.txt'],
            exclude: ['tests/', '__pycache__', '*.pyc', '.pytest_cache'],
          },
        }
        await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

        // Write all source files
        await fs.writeFile(path.join(targetDir, 'config.py'), SA_CONFIG_PY)
        await fs.writeFile(path.join(targetDir, 'brain.py'), SA_BRAIN_PY)
        await fs.writeFile(path.join(targetDir, 'main.py'), SA_MAIN_PY)
        await fs.writeFile(path.join(targetDir, 'connectors', '__init__.py'), '')
        await fs.writeFile(path.join(targetDir, 'connectors', 'discord_connector.py'), SA_DISCORD_CONNECTOR_PY)
        await fs.writeFile(path.join(targetDir, 'connectors', 'telegram_connector.py'), SA_TELEGRAM_CONNECTOR_PY)
        await fs.writeFile(path.join(targetDir, 'connectors', 'slack_connector.py'), SA_SLACK_CONNECTOR_PY)
        await fs.writeFile(path.join(targetDir, 'requirements.txt'), SA_REQUIREMENTS)
        await fs.writeFile(path.join(targetDir, 'knowledge', '00-overview.md'), SA_OVERVIEW_MD)
        await fs.writeFile(path.join(targetDir, 'knowledge', '99-faq.md'), SA_FAQ_MD)
        await fs.writeFile(path.join(targetDir, '.env.example'), SA_ENV_EXAMPLE)
        await fs.writeFile(path.join(targetDir, 'README.md'), readmeTemplate(agentName, 'support_agent'))

        const prefix = name ? name + '/' : ''
        process.stdout.write(`\nInitialized support-agent "${agentName}" in ${targetDir}\n`)
        process.stdout.write(`\nFiles created:\n`)
        process.stdout.write(`  ${prefix}orchagent.json                       Agent manifest\n`)
        process.stdout.write(`  ${prefix}config.py                            Customize here (4 fields)\n`)
        process.stdout.write(`  ${prefix}brain.py                             Three-tier classifier + responder\n`)
        process.stdout.write(`  ${prefix}main.py                              Startup orchestrator\n`)
        process.stdout.write(`  ${prefix}connectors/discord_connector.py      Discord connector\n`)
        process.stdout.write(`  ${prefix}connectors/telegram_connector.py     Telegram connector\n`)
        process.stdout.write(`  ${prefix}connectors/slack_connector.py        Slack connector\n`)
        process.stdout.write(`  ${prefix}knowledge/00-overview.md             Example FAQ knowledge\n`)
        process.stdout.write(`  ${prefix}knowledge/99-faq.md                  Example FAQ knowledge\n`)
        process.stdout.write(`  ${prefix}requirements.txt                     Python dependencies\n`)
        process.stdout.write(`  ${prefix}.env.example                         Environment variables\n`)
        process.stdout.write(`  ${prefix}README.md                            Setup guide\n`)

        process.stdout.write(`\nNext steps:\n`)
        const s = name ? 2 : 1
        if (name) {
          process.stdout.write(`  1. cd ${name}\n`)
        }
        process.stdout.write(`  ${s}. Edit config.py with your product name and description\n`)
        process.stdout.write(`  ${s + 1}. Replace knowledge/ files with your own docs\n`)
        process.stdout.write(`  ${s + 2}. Copy .env.example to .env and add platform tokens\n`)
        process.stdout.write(`  ${s + 3}. Test locally: pip install -r requirements.txt && python3 main.py\n`)
        process.stdout.write(`  ${s + 4}. Deploy: orch publish && orch service deploy\n`)
        process.stdout.write(AGENT_BUILDER_HINT)
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
        process.stdout.write(AGENT_BUILDER_HINT)
        return
      }

      // Handle discord-js template separately (JS Discord bot)
      if (initMode.flavor === 'discord_js') {
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

        const manifest = {
          name: agentName,
          type: 'agent',
          description: 'An always-on Discord bot powered by Claude (JavaScript)',
          run_mode: 'always_on',
          runtime: { command: 'node main.js' },
          entrypoint: 'main.js',
          supported_providers: ['anthropic'],
          required_secrets: ['ANTHROPIC_API_KEY', 'DISCORD_BOT_TOKEN', 'DISCORD_CHANNEL_IDS'],
          tags: ['discord', 'always-on', 'javascript'],
        }
        await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
        await fs.writeFile(path.join(targetDir, 'main.js'), DISCORD_MAIN_JS)
        await fs.writeFile(path.join(targetDir, 'package.json'), DISCORD_PACKAGE_JSON)
        await fs.writeFile(path.join(targetDir, '.env.example'), DISCORD_JS_ENV_EXAMPLE)
        await fs.writeFile(path.join(targetDir, 'README.md'), readmeTemplate(agentName, 'discord_js'))

        const prefix = name ? name + '/' : ''
        process.stdout.write(`\nInitialized JS Discord bot "${agentName}" in ${targetDir}\n`)
        process.stdout.write(`\nFiles created:\n`)
        process.stdout.write(`  ${prefix}orchagent.json    - Agent configuration\n`)
        process.stdout.write(`  ${prefix}main.js           - Discord bot (discord.js + Anthropic)\n`)
        process.stdout.write(`  ${prefix}package.json      - npm dependencies\n`)
        process.stdout.write(`  ${prefix}.env.example      - Environment variables template\n`)
        process.stdout.write(`  ${prefix}README.md         - Setup guide\n`)

        process.stdout.write(`\nNext steps:\n`)
        const stepNum = name ? 2 : 1
        if (name) {
          process.stdout.write(`  1. cd ${name}\n`)
        }
        process.stdout.write(`  ${stepNum}. Create a Discord bot at https://discord.com/developers/applications\n`)
        process.stdout.write(`  ${stepNum + 1}. Enable Message Content Intent in bot settings\n`)
        process.stdout.write(`  ${stepNum + 2}. Copy .env.example to .env and fill in your tokens\n`)
        process.stdout.write(`  ${stepNum + 3}. Test locally: npm install && node main.js\n`)
        process.stdout.write(`  ${stepNum + 4}. Deploy: orch publish\n`)
        process.stdout.write(AGENT_BUILDER_HINT)
        return
      }

      // Handle orchestration templates (fan-out, pipeline, map-reduce)
      if (initMode.flavor === 'fan_out' || initMode.flavor === 'pipeline' || initMode.flavor === 'map_reduce') {
        const manifestPath = path.join(targetDir, 'orchagent.json')

        try {
          await fs.access(manifestPath)
          throw new CliError(`Already initialized (orchagent.json exists in ${name ? name + '/' : 'current directory'})`)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw err
          }
        }

        // Build dependencies based on template
        let dependencies: { id: string; version: string }[]
        let mainPy: string
        let mainJs: string
        let schema: string
        let templateLabel: string
        let maxHops: number

        if (initMode.flavor === 'fan_out') {
          dependencies = [
            { id: 'org/agent-a', version: 'v1' },
            { id: 'org/agent-b', version: 'v1' },
            { id: 'org/agent-c', version: 'v1' },
          ]
          mainPy = FANOUT_MAIN_PY
          mainJs = FANOUT_MAIN_JS
          schema = FANOUT_SCHEMA
          templateLabel = 'fan-out'
          maxHops = 2
        } else if (initMode.flavor === 'pipeline') {
          dependencies = [
            { id: 'org/parser', version: 'v1' },
            { id: 'org/analyzer', version: 'v1' },
            { id: 'org/reporter', version: 'v1' },
          ]
          mainPy = PIPELINE_MAIN_PY
          mainJs = PIPELINE_MAIN_JS
          schema = PIPELINE_SCHEMA
          templateLabel = 'pipeline'
          maxHops = 2
        } else {
          dependencies = [
            { id: 'org/processor', version: 'v1' },
            { id: 'org/aggregator', version: 'v1' },
          ]
          mainPy = MAPREDUCE_MAIN_PY
          mainJs = MAPREDUCE_MAIN_JS
          schema = MAPREDUCE_SCHEMA
          templateLabel = 'map-reduce'
          maxHops = 2
        }

        const manifest: Record<string, unknown> = {
          name: agentName,
          type: 'agent',
          description: `A ${templateLabel} orchestrator agent`,
          run_mode: runMode,
          runtime: { command: isJavaScript ? 'node main.js' : 'python3 main.py' },
          manifest: {
            manifest_version: 1,
            dependencies,
            max_hops: maxHops,
            timeout_ms: 120000,
            per_call_downstream_cap: 50,
          },
          required_secrets: [],
        }
        if (isJavaScript) {
          manifest.entrypoint = 'main.js'
        }

        await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

        if (isJavaScript) {
          await fs.writeFile(path.join(targetDir, 'main.js'), mainJs)
          await fs.writeFile(path.join(targetDir, 'package.json'), ORCHESTRATOR_PACKAGE_JSON)
        } else {
          await fs.writeFile(path.join(targetDir, 'main.py'), mainPy)
          await fs.writeFile(path.join(targetDir, 'requirements.txt'), ORCHESTRATOR_REQUIREMENTS)
        }
        await fs.writeFile(path.join(targetDir, 'schema.json'), schema)
        await fs.writeFile(path.join(targetDir, 'README.md'), readmeTemplate(agentName, initMode.flavor))

        const prefix = name ? name + '/' : ''
        process.stdout.write(`Initialized ${templateLabel} orchestrator "${agentName}" in ${targetDir}\n`)
        process.stdout.write(`\nFiles created:\n`)
        process.stdout.write(`  ${prefix}orchagent.json    - Agent configuration (${templateLabel} pattern)\n`)
        if (isJavaScript) {
          process.stdout.write(`  ${prefix}main.js           - ${templateLabel} orchestrator entrypoint\n`)
          process.stdout.write(`  ${prefix}package.json      - npm dependencies (orchagent-sdk)\n`)
        } else {
          process.stdout.write(`  ${prefix}main.py           - ${templateLabel} orchestrator entrypoint\n`)
          process.stdout.write(`  ${prefix}requirements.txt  - Python dependencies (orchagent-sdk)\n`)
        }
        process.stdout.write(`  ${prefix}schema.json       - Input/output schemas\n`)
        process.stdout.write(`  ${prefix}README.md         - Agent documentation\n`)
        process.stdout.write(`  Run mode: ${runMode}\n`)
        process.stdout.write(`  Execution: code_runtime (${templateLabel})\n`)

        process.stdout.write(`\nNext steps:\n`)
        const stepNum = name ? 2 : 1
        if (name) {
          process.stdout.write(`  1. cd ${name}\n`)
        }
        process.stdout.write(`  ${stepNum}. Update manifest.dependencies in orchagent.json with your actual agents\n`)
        if (isJavaScript) {
          process.stdout.write(`  ${stepNum + 1}. Edit main.js with your orchestration logic\n`)
        } else {
          process.stdout.write(`  ${stepNum + 1}. Edit main.py with your orchestration logic\n`)
        }
        process.stdout.write(`  ${stepNum + 2}. Publish dependency agents first, then: orchagent publish\n`)
        process.stdout.write(AGENT_BUILDER_HINT)
        return
      }

      // Handle cron-job template
      if (initMode.flavor === 'cron_job') {
        const manifestPath = path.join(targetDir, 'orchagent.json')

        try {
          await fs.access(manifestPath)
          throw new CliError(`Already initialized (orchagent.json exists in ${name ? name + '/' : 'current directory'})`)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw err
          }
        }

        const manifest: Record<string, unknown> = {
          name: agentName,
          type: 'tool',
          description: 'A scheduled job that runs on a cron schedule',
          run_mode: 'on_demand',
          runtime: { command: isJavaScript ? 'node main.js' : 'python3 main.py' },
          required_secrets: [],
          tags: ['scheduled', 'cron'],
        }
        if (isJavaScript) {
          manifest.entrypoint = 'main.js'
        }

        await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

        if (isJavaScript) {
          await fs.writeFile(path.join(targetDir, 'main.js'), CRON_JOB_MAIN_JS)
          await fs.writeFile(path.join(targetDir, 'package.json'), JSON.stringify({
            name: agentName,
            private: true,
            type: 'commonjs',
            dependencies: {},
          }, null, 2) + '\n')
        } else {
          await fs.writeFile(path.join(targetDir, 'main.py'), CRON_JOB_MAIN_PY)
        }
        await fs.writeFile(path.join(targetDir, 'schema.json'), CRON_JOB_SCHEMA)
        await fs.writeFile(path.join(targetDir, 'README.md'), cronJobReadme(agentName))

        const prefix = name ? name + '/' : ''
        process.stdout.write(`Initialized scheduled job "${agentName}" in ${targetDir}\n`)
        process.stdout.write(`\nFiles created:\n`)
        process.stdout.write(`  ${prefix}orchagent.json    - Agent configuration (cron job)\n`)
        if (isJavaScript) {
          process.stdout.write(`  ${prefix}main.js           - Scheduled job entrypoint\n`)
          process.stdout.write(`  ${prefix}package.json      - npm dependencies\n`)
        } else {
          process.stdout.write(`  ${prefix}main.py           - Scheduled job entrypoint\n`)
        }
        process.stdout.write(`  ${prefix}schema.json       - Input/output schemas\n`)
        process.stdout.write(`  ${prefix}README.md         - Setup guide with cron patterns\n`)

        process.stdout.write(`\nNext steps:\n`)
        const stepNum = name ? 2 : 1
        if (name) {
          process.stdout.write(`  1. cd ${name}\n`)
        }
        const mainFile = isJavaScript ? 'main.js' : 'main.py'
        const testCmd = isJavaScript ? 'node main.js' : 'python3 main.py'
        process.stdout.write(`  ${stepNum}. Edit ${mainFile} with your job logic\n`)
        process.stdout.write(`  ${stepNum + 1}. Test: echo '{}' | ${testCmd}\n`)
        process.stdout.write(`  ${stepNum + 2}. Publish: orch publish\n`)
        process.stdout.write(`  ${stepNum + 3}. Schedule: orch schedule create <org>/${agentName} --cron "0 9 * * 1"\n`)
        process.stdout.write(AGENT_BUILDER_HINT)
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
          "run_mode=always_on requires runtime.command in orchagent.json (e.g. \"runtime\": { \"command\": \"python3 main.py\" }). Use --type tool or --type agentic for code-runtime agents."
        )
      }

      // Create manifest and type-specific files
      const manifest = JSON.parse(MANIFEST_TEMPLATE)
      manifest.name = agentName
      manifest.type = initMode.type
      manifest.run_mode = runMode

      if (initMode.flavor === 'orchestrator') {
        manifest.description = 'An orchestrator agent that coordinates other agents'
        if (isJavaScript) {
          manifest.runtime = { command: 'node main.js' }
          manifest.entrypoint = 'main.js'
        } else {
          manifest.runtime = { command: 'python3 main.py' }
        }
        manifest.manifest = {
          manifest_version: 1,
          dependencies: [{ id: 'org/agent-name', version: 'v1' }],
          max_hops: 3,
          timeout_ms: 120000,
          per_call_downstream_cap: 50,
        }
        manifest.required_secrets = []
      } else if (initMode.flavor === 'managed_loop') {
        manifest.description = 'An AI agent with tool use (managed loop)'
        manifest.supported_providers = ['any']
        manifest.loop = { max_turns: 25 }
        manifest.required_secrets = []
      } else if (initMode.flavor === 'discord') {
        manifest.description = 'An always-on Discord bot powered by Claude'
        manifest.runtime = { command: 'python3 main.py' }
        manifest.supported_providers = ['anthropic']
        manifest.required_secrets = ['ANTHROPIC_API_KEY', 'DISCORD_BOT_TOKEN', 'DISCORD_CHANNEL_IDS']
        manifest.tags = ['discord', 'always-on']
      } else if (initMode.flavor === 'code_runtime') {
        manifest.description = initMode.type === 'agent' ? 'An AI agent' : 'A code-runtime tool'
        if (isJavaScript) {
          manifest.runtime = { command: 'node main.js' }
          manifest.entrypoint = 'main.js'
        } else {
          manifest.runtime = { command: 'python3 main.py' }
        }
        manifest.required_secrets = []
      }

      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

      if (initMode.flavor === 'orchestrator') {
        if (isJavaScript) {
          await fs.writeFile(path.join(targetDir, 'main.js'), ORCHESTRATOR_MAIN_JS)
          await fs.writeFile(path.join(targetDir, 'package.json'), ORCHESTRATOR_PACKAGE_JSON)
        } else {
          await fs.writeFile(path.join(targetDir, 'main.py'), ORCHESTRATOR_MAIN_PY)
          await fs.writeFile(path.join(targetDir, 'requirements.txt'), ORCHESTRATOR_REQUIREMENTS)
        }
        await fs.writeFile(schemaPath, AGENT_SCHEMA_TEMPLATE)
      } else if (initMode.flavor === 'discord') {
        const entrypointPath = path.join(targetDir, 'main.py')
        const requirementsPath = path.join(targetDir, 'requirements.txt')
        const envExamplePath = path.join(targetDir, '.env.example')
        await fs.writeFile(entrypointPath, DISCORD_MAIN_PY)
        await fs.writeFile(requirementsPath, DISCORD_REQUIREMENTS)
        await fs.writeFile(envExamplePath, DISCORD_ENV_EXAMPLE)
      } else if (initMode.flavor === 'code_runtime') {
        const isAgent = initMode.type === 'agent'
        if (isJavaScript) {
          const template = runMode === 'always_on' ? ALWAYS_ON_TEMPLATE_JS
            : isAgent ? AGENT_CODE_TEMPLATE_JS : CODE_TEMPLATE_JS
          await fs.writeFile(path.join(targetDir, 'main.js'), template)
          await fs.writeFile(path.join(targetDir, 'package.json'), JSON.stringify({
            name: agentName,
            private: true,
            type: 'commonjs',
            dependencies: {},
          }, null, 2) + '\n')
        } else {
          const template = runMode === 'always_on' ? ALWAYS_ON_TEMPLATE_PY
            : isAgent ? AGENT_CODE_TEMPLATE_PY : CODE_TEMPLATE_PY
          await fs.writeFile(path.join(targetDir, 'main.py'), template)
        }
        await fs.writeFile(schemaPath, isAgent ? AGENT_SCHEMA_TEMPLATE : SCHEMA_TEMPLATE)
      } else if (initMode.flavor === 'managed_loop') {
        await fs.writeFile(promptPath, AGENT_PROMPT_TEMPLATE)
        await fs.writeFile(schemaPath, AGENT_SCHEMA_TEMPLATE)
      } else {
        await fs.writeFile(promptPath, PROMPT_TEMPLATE)
        await fs.writeFile(schemaPath, SCHEMA_TEMPLATE)
      }

      // Create README
      const readmePath = path.join(targetDir, 'README.md')
      await fs.writeFile(readmePath, readmeTemplate(agentName, initMode.flavor || 'direct_llm', initMode.type))

      process.stdout.write(`Initialized agent "${agentName}" in ${targetDir}\n`)
      process.stdout.write(`\nFiles created:\n`)
      const prefix = name ? name + '/' : ''
      process.stdout.write(`  ${prefix}orchagent.json    - Agent configuration\n`)
      if (initMode.flavor === 'orchestrator') {
        if (isJavaScript) {
          process.stdout.write(`  ${prefix}main.js           - Orchestrator entrypoint (SDK calls)\n`)
          process.stdout.write(`  ${prefix}package.json      - npm dependencies (orchagent-sdk)\n`)
        } else {
          process.stdout.write(`  ${prefix}main.py           - Orchestrator entrypoint (SDK calls)\n`)
          process.stdout.write(`  ${prefix}requirements.txt  - Python dependencies (orchagent-sdk)\n`)
        }
      } else if (initMode.flavor === 'discord') {
        process.stdout.write(`  ${prefix}main.py           - Discord bot (discord.py + Anthropic)\n`)
        process.stdout.write(`  ${prefix}requirements.txt  - Python dependencies\n`)
        process.stdout.write(`  ${prefix}.env.example      - Environment variables template\n`)
      } else if (initMode.flavor === 'code_runtime') {
        const entrypointDesc = runMode === 'always_on' ? 'Always-on HTTP server'
          : initMode.type === 'agent' ? 'Agent entrypoint (your code)' : 'Tool entrypoint (stdin/stdout JSON)'
        if (isJavaScript) {
          process.stdout.write(`  ${prefix}main.js           - ${entrypointDesc}\n`)
          process.stdout.write(`  ${prefix}package.json      - npm dependencies\n`)
        } else {
          process.stdout.write(`  ${prefix}main.py           - ${entrypointDesc}\n`)
        }
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
        if (isJavaScript) {
          process.stdout.write(`  ${stepNum + 1}. Edit main.js with your orchestration logic\n`)
        } else {
          process.stdout.write(`  ${stepNum + 1}. Edit main.py with your orchestration logic\n`)
        }
        process.stdout.write(`  ${stepNum + 2}. Publish dependency agents first, then: orchagent publish\n`)
      } else if (initMode.flavor === 'discord') {
        const stepNum = name ? 2 : 1
        if (name) {
          process.stdout.write(`  1. cd ${name}\n`)
        }
        process.stdout.write(`  ${stepNum}. Create a Discord bot at https://discord.com/developers/applications\n`)
        process.stdout.write(`  ${stepNum + 1}. Enable Message Content Intent in bot settings\n`)
        process.stdout.write(`  ${stepNum + 2}. Copy .env.example to .env and fill in your tokens\n`)
        process.stdout.write(`  ${stepNum + 3}. Test locally: pip install -r requirements.txt && python3 main.py\n`)
        process.stdout.write(`  ${stepNum + 4}. Deploy: orch publish\n`)
      } else if (initMode.flavor === 'code_runtime') {
        const stepNum = name ? 2 : 1
        if (name) {
          process.stdout.write(`  1. cd ${name}\n`)
        }
        if (runMode === 'always_on') {
          const mainFile = isJavaScript ? 'main.js' : 'main.py'
          const testCmd = isJavaScript ? 'node main.js' : 'python3 main.py'
          process.stdout.write(`  ${stepNum}. Edit ${mainFile} with your service logic\n`)
          process.stdout.write(`  ${stepNum + 1}. Test locally: ${testCmd}\n`)
          process.stdout.write(`  ${stepNum + 2}. Publish: orch publish\n`)
          process.stdout.write(`  ${stepNum + 3}. Deploy: orch service deploy\n`)
        } else if (isJavaScript) {
          const inputField = initMode.type === 'agent' ? 'task' : 'input'
          process.stdout.write(`  ${stepNum}. Edit main.js with your agent logic\n`)
          process.stdout.write(`  ${stepNum + 1}. Edit schema.json with your input/output schemas\n`)
          process.stdout.write(`  ${stepNum + 2}. Test: echo '{"${inputField}": "test"}' | node main.js\n`)
          process.stdout.write(`  ${stepNum + 3}. Run: orchagent publish\n`)
        } else {
          const inputField = initMode.type === 'agent' ? 'task' : 'input'
          process.stdout.write(`  ${stepNum}. Edit main.py with your agent logic\n`)
          process.stdout.write(`  ${stepNum + 1}. Edit schema.json with your input/output schemas\n`)
          process.stdout.write(`  ${stepNum + 2}. Test: echo '{"${inputField}": "test"}' | python3 main.py\n`)
          process.stdout.write(`  ${stepNum + 3}. Run: orchagent publish\n`)
        }
      } else {
        const stepNum = name ? 2 : 1
        if (name) {
          process.stdout.write(`  1. cd ${name}\n`)
        }
        process.stdout.write(`  ${stepNum}. Edit prompt.md with your agent instructions\n`)
        process.stdout.write(`  ${stepNum + 1}. Edit schema.json with your input/output schemas\n`)
        process.stdout.write(`  ${stepNum + 2}. Run: orchagent publish\n`)
      }
      if (initMode.flavor === 'managed_loop') {
        process.stdout.write(`\n  Note: supported_providers: ["any"] means anthropic, openai, or gemini\n`)
        process.stdout.write(`        Your vault key determines which is used (set with: orch secrets set)\n`)
      }
      process.stdout.write(AGENT_BUILDER_HINT)
    })
}
