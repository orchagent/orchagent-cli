/**
 * Cron-job template for `orch init --template cron-job`.
 *
 * Provides Python and JavaScript scaffolding for scheduled tasks —
 * daily reports, data syncs, cleanups, notifications, etc.
 */

// ---------------------------------------------------------------------------
// Python template
// ---------------------------------------------------------------------------

export const CRON_JOB_MAIN_PY = `"""
orchagent scheduled job.

Runs on a cron schedule to perform periodic tasks.

Schedule examples:
  orch schedule create org/my-job --cron "0 9 * * 1"    # Every Monday 9 AM UTC
  orch schedule create org/my-job --cron "0 0 * * *"    # Daily at midnight
  orch schedule create org/my-job --cron "0 */6 * * *"  # Every 6 hours

Local test:
  echo '{}' | python main.py
"""

import json
import os
import sys
from datetime import datetime, timezone


def main():
    raw = sys.stdin.read()
    try:
        data = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        print(json.dumps({"error": "Invalid JSON input"}))
        sys.exit(1)

    dry_run = data.get("options", {}).get("dry_run", False)

    # --- Your scheduled job logic here ---
    # Common patterns:
    #   - Fetch data from an API and store results
    #   - Generate a daily/weekly report
    #   - Clean up old records or files
    #   - Send digest notifications (email, Slack, Discord)
    #
    # To use workspace secrets (API keys, webhook URLs):
    #   1. Add to "required_secrets" in orchagent.json
    #   2. Set in workspace: orch secrets set MY_SECRET <value>
    #   3. Access via: os.environ["MY_SECRET"]
    #
    # Example: send to a webhook
    #   import urllib.request
    #   webhook_url = os.environ["WEBHOOK_URL"]
    #   req = urllib.request.Request(webhook_url, data=json.dumps(payload).encode(),
    #                                headers={"Content-Type": "application/json"})
    #   urllib.request.urlopen(req)

    now = datetime.now(timezone.utc).isoformat()

    report = {
        "generated_at": now,
        "status": "completed" if not dry_run else "dry_run",
        "summary": "Scheduled job ran successfully",
        "items_processed": 0,
    }
    # --- End your logic ---

    print(json.dumps({
        "result": report,
        "success": True,
    }))


if __name__ == "__main__":
    main()
`

// ---------------------------------------------------------------------------
// JavaScript template
// ---------------------------------------------------------------------------

export const CRON_JOB_MAIN_JS = `/**
 * orchagent scheduled job.
 *
 * Runs on a cron schedule to perform periodic tasks.
 *
 * Schedule examples:
 *   orch schedule create org/my-job --cron "0 9 * * 1"    # Every Monday 9 AM UTC
 *   orch schedule create org/my-job --cron "0 0 * * *"    # Daily at midnight
 *   orch schedule create org/my-job --cron "0 */6 * * *"  # Every 6 hours
 *
 * Local test:
 *   echo '{}' | node main.js
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

  const dryRun = (data.options || {}).dry_run || false;

  // --- Your scheduled job logic here ---
  // Common patterns:
  //   - Fetch data from an API and store results
  //   - Generate a daily/weekly report
  //   - Clean up old records or files
  //   - Send digest notifications (email, Slack, Discord)
  //
  // To use workspace secrets (API keys, webhook URLs):
  //   1. Add to "required_secrets" in orchagent.json
  //   2. Set in workspace: orch secrets set MY_SECRET value
  //   3. Access via: process.env.MY_SECRET
  //
  // Example: send to a webhook
  //   const https = require('https');
  //   const url = new URL(process.env.WEBHOOK_URL);
  //   const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  //   req.write(JSON.stringify(payload));
  //   req.end();

  const now = new Date().toISOString();

  const report = {
    generated_at: now,
    status: dryRun ? 'dry_run' : 'completed',
    summary: 'Scheduled job ran successfully',
    items_processed: 0,
  };
  // --- End your logic ---

  console.log(JSON.stringify({
    result: report,
    success: true,
  }));
}

main();
`

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const CRON_JOB_SCHEMA = `{
  "input": {
    "type": "object",
    "properties": {
      "options": {
        "type": "object",
        "description": "Optional configuration for this run",
        "properties": {
          "dry_run": {
            "type": "boolean",
            "description": "If true, simulate without making changes"
          }
        }
      }
    }
  },
  "output": {
    "type": "object",
    "properties": {
      "result": {
        "type": "object",
        "description": "Job results and summary"
      },
      "success": {
        "type": "boolean",
        "description": "Whether the job completed successfully"
      }
    },
    "required": ["result", "success"]
  }
}
`

// ---------------------------------------------------------------------------
// README
// ---------------------------------------------------------------------------

export function cronJobReadme(agentName: string): string {
  return `# ${agentName}

A scheduled job that runs on a cron schedule.

## Setup

### 1. Edit the job logic

Edit \`main.py\` (or \`main.js\`) with your scheduled task logic — data processing, report generation, API syncs, notifications, etc.

### 2. Publish

\`\`\`sh
orch publish
\`\`\`

### 3. Schedule

\`\`\`sh
# Every Monday at 9 AM UTC
orch schedule create <org>/${agentName} --cron "0 9 * * 1"

# Every day at midnight
orch schedule create <org>/${agentName} --cron "0 0 * * *"

# Every 6 hours
orch schedule create <org>/${agentName} --cron "0 */6 * * *"
\`\`\`

### 4. Monitor

\`\`\`sh
orch schedule list              # View all schedules
orch logs <org>/${agentName}    # View recent runs
orch metrics <org>/${agentName} # View execution stats
\`\`\`

## Common Cron Patterns

| Pattern | Schedule |
|---------|----------|
| \`0 9 * * 1\` | Every Monday at 9 AM |
| \`0 0 * * *\` | Daily at midnight |
| \`0 */6 * * *\` | Every 6 hours |
| \`0 9 * * 1-5\` | Weekdays at 9 AM |
| \`0 0 1 * *\` | First of each month |

## Input

The job receives optional input when triggered:

| Field | Type | Description |
|-------|------|-------------|
| \`options.dry_run\` | boolean | If true, simulate without making changes |

You can also trigger manually with custom input:

\`\`\`sh
orch run <org>/${agentName} --data '{"options": {"dry_run": true}}'
\`\`\`

## Environment Variables

To use API keys or webhook URLs, add them to \`required_secrets\` in orchagent.json, then set them in your workspace:

\`\`\`sh
orch secrets set MY_API_KEY <value>
orch secrets set WEBHOOK_URL <value>
\`\`\`
`
}
