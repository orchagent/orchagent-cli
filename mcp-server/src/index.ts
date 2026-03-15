#!/usr/bin/env node

/**
 * orchagent MCP Server
 *
 * Exposes orchagent platform capabilities as MCP tools:
 * - Agent execution (list, run)
 * - Task management (list, create, update, complete)
 * - Messages (list, send)
 * - Schedules (list, create, trigger)
 * - Runs (list, logs)
 *
 * Auth: ORCHAGENT_API_KEY env var (required)
 * Transport: stdio (for Claude Desktop / Claude Code)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GatewayClient } from "./api.js";

const server = new McpServer(
  {
    name: "orchagent",
    version: "0.1.0",
  },
  {
    capabilities: { logging: {} },
  }
);

// Lazily initialised so we get a clear error if ORCHAGENT_API_KEY is missing
let _client: GatewayClient | null = null;
function client(): GatewayClient {
  if (!_client) _client = new GatewayClient();
  return _client;
}

function ok(data: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function err(
  msg: string
): { content: { type: "text"; text: string }[]; isError: true } {
  return {
    content: [{ type: "text" as const, text: msg }],
    isError: true as const,
  };
}

// ────────────────────────────────────────────────────
// Agents
// ────────────────────────────────────────────────────

server.tool(
  "orchagent_list_agents",
  "List all agents in your orchagent account. Returns name, type, version, and description for each agent.",
  {
    workspace_id: z
      .string()
      .optional()
      .describe("Filter to a specific workspace (UUID). Omit for all."),
  },
  async ({ workspace_id }) => {
    try {
      return ok(await client().listAgents(workspace_id));
    } catch (e) {
      return err(`Failed to list agents: ${e instanceof Error ? e.message : e}`);
    }
  }
);

server.tool(
  "orchagent_run_agent",
  "Execute a deployed agent on orchagent and return the result. The agent runs in a cloud sandbox.",
  {
    org: z.string().describe("Organisation slug (e.g. 'stocksure')"),
    agent: z.string().describe("Agent name (e.g. 'claim-reviewer')"),
    version: z
      .string()
      .default("latest")
      .describe("Agent version (e.g. 'v1'). Defaults to 'latest'."),
    input: z
      .record(z.unknown())
      .default({})
      .describe("Input data matching the agent's input schema"),
    workspace_id: z
      .string()
      .optional()
      .describe("Workspace ID for workspace-scoped agents"),
  },
  async ({ org, agent, version, input, workspace_id }) => {
    try {
      return ok(await client().runAgent(org, agent, version, input, workspace_id));
    } catch (e) {
      return err(
        `Failed to run ${org}/${agent}@${version}: ${e instanceof Error ? e.message : e}`
      );
    }
  }
);

// ────────────────────────────────────────────────────
// Tasks
// ────────────────────────────────────────────────────

server.tool(
  "orchagent_list_tasks",
  "List tasks from your orchagent task list. Supports filtering by status, project, priority, and overdue.",
  {
    status: z
      .enum(["open", "in_progress", "done", "cancelled"])
      .optional()
      .describe("Filter by status"),
    project: z.string().optional().describe("Filter by project name"),
    priority: z
      .enum(["low", "normal", "high", "urgent"])
      .optional()
      .describe("Filter by priority"),
    overdue: z
      .boolean()
      .optional()
      .describe("If true, only return open tasks past their due date"),
    limit: z
      .number()
      .min(1)
      .max(200)
      .optional()
      .describe("Max results (default 50)"),
  },
  async (params) => {
    try {
      return ok(await client().listTasks(params));
    } catch (e) {
      return err(`Failed to list tasks: ${e instanceof Error ? e.message : e}`);
    }
  }
);

server.tool(
  "orchagent_create_task",
  "Create a new task in your orchagent task list.",
  {
    title: z.string().describe("Task title (required)"),
    description: z.string().optional().describe("Detailed description"),
    due_date: z
      .string()
      .optional()
      .describe("Due date in YYYY-MM-DD format"),
    project: z.string().optional().describe("Project name (free text)"),
    priority: z
      .enum(["low", "normal", "high", "urgent"])
      .optional()
      .describe("Priority level (default: normal)"),
  },
  async (params) => {
    try {
      return ok(await client().createTask(params));
    } catch (e) {
      return err(
        `Failed to create task: ${e instanceof Error ? e.message : e}`
      );
    }
  }
);

server.tool(
  "orchagent_update_task",
  "Update an existing task — change status, priority, due date, project, or title. Use status 'done' to complete a task.",
  {
    task_id: z.string().describe("Task UUID"),
    title: z.string().optional().describe("New title"),
    description: z.string().optional().describe("New description"),
    due_date: z
      .string()
      .optional()
      .describe("New due date (YYYY-MM-DD)"),
    project: z.string().optional().describe("New project name"),
    priority: z
      .enum(["low", "normal", "high", "urgent"])
      .optional()
      .describe("New priority"),
    status: z
      .enum(["open", "in_progress", "done", "cancelled"])
      .optional()
      .describe("New status. Use 'done' to complete the task."),
  },
  async ({ task_id, ...updates }) => {
    try {
      return ok(await client().updateTask(task_id, updates));
    } catch (e) {
      return err(
        `Failed to update task ${task_id}: ${e instanceof Error ? e.message : e}`
      );
    }
  }
);

server.tool(
  "orchagent_delete_task",
  "Permanently delete a task from your orchagent task list.",
  {
    task_id: z.string().describe("Task UUID to delete"),
  },
  async ({ task_id }) => {
    try {
      return ok(await client().deleteTask(task_id));
    } catch (e) {
      return err(
        `Failed to delete task ${task_id}: ${e instanceof Error ? e.message : e}`
      );
    }
  }
);

// ────────────────────────────────────────────────────
// Messages
// ────────────────────────────────────────────────────

server.tool(
  "orchagent_list_messages",
  "List messages sent by agents. Messages are notifications — briefings, alerts, reports.",
  {
    level: z
      .enum(["info", "success", "warning", "error"])
      .optional()
      .describe("Filter by message level"),
    agent_name: z
      .string()
      .optional()
      .describe("Filter by sending agent name"),
    limit: z
      .number()
      .min(1)
      .max(200)
      .optional()
      .describe("Max results (default 50)"),
  },
  async (params) => {
    try {
      return ok(await client().listMessages(params));
    } catch (e) {
      return err(
        `Failed to list messages: ${e instanceof Error ? e.message : e}`
      );
    }
  }
);

server.tool(
  "orchagent_send_message",
  "Send a message to the user's orchagent message feed. Appears in orch-hq's Messages panel.",
  {
    title: z.string().describe("Message title / subject line"),
    body: z.string().describe("Message body (plain text or markdown)"),
    level: z
      .enum(["info", "success", "warning", "error"])
      .default("info")
      .describe("Message level: info, success, warning, or error"),
    metadata: z
      .record(z.unknown())
      .optional()
      .describe("Arbitrary metadata (e.g. { report_url: '...' })"),
  },
  async (params) => {
    try {
      return ok(await client().sendMessage(params));
    } catch (e) {
      return err(
        `Failed to send message: ${e instanceof Error ? e.message : e}`
      );
    }
  }
);

// ────────────────────────────────────────────────────
// Schedules
// ────────────────────────────────────────────────────

server.tool(
  "orchagent_list_schedules",
  "List scheduled agent runs (cron or webhook) in a workspace.",
  {
    workspace_id: z.string().describe("Workspace UUID"),
    agent_name: z
      .string()
      .optional()
      .describe("Filter by agent name"),
    limit: z
      .number()
      .min(1)
      .max(200)
      .optional()
      .describe("Max results (default 50)"),
  },
  async ({ workspace_id, ...params }) => {
    try {
      return ok(await client().listSchedules(workspace_id, params));
    } catch (e) {
      return err(
        `Failed to list schedules: ${e instanceof Error ? e.message : e}`
      );
    }
  }
);

server.tool(
  "orchagent_create_schedule",
  "Create a new scheduled agent run. Use cron expressions for recurring execution.",
  {
    workspace_id: z.string().describe("Workspace UUID"),
    agent_id: z.string().describe("Agent UUID"),
    agent_name: z.string().describe("Agent name (e.g. 'morning-brief')"),
    agent_version: z
      .string()
      .default("v1")
      .describe("Agent version (e.g. 'v1')"),
    schedule_type: z
      .enum(["cron", "webhook"])
      .default("cron")
      .describe("Schedule type"),
    cron_expression: z
      .string()
      .optional()
      .describe("Cron expression (e.g. '0 9 * * *' for daily 9am). Required for cron type."),
    timezone: z
      .string()
      .default("UTC")
      .describe("IANA timezone (e.g. 'Europe/London')"),
    input_data: z
      .record(z.unknown())
      .optional()
      .describe("Input data to pass to the agent on each run"),
  },
  async ({ workspace_id, ...body }) => {
    try {
      return ok(await client().createSchedule(workspace_id, body));
    } catch (e) {
      return err(
        `Failed to create schedule: ${e instanceof Error ? e.message : e}`
      );
    }
  }
);

server.tool(
  "orchagent_trigger_schedule",
  "Manually trigger a scheduled agent run right now, without waiting for the next cron tick.",
  {
    workspace_id: z.string().describe("Workspace UUID"),
    schedule_id: z.string().describe("Schedule UUID"),
    input: z
      .record(z.unknown())
      .optional()
      .describe("Override input data for this run"),
  },
  async ({ workspace_id, schedule_id, input }) => {
    try {
      return ok(
        await client().triggerSchedule(workspace_id, schedule_id, input)
      );
    } catch (e) {
      return err(
        `Failed to trigger schedule: ${e instanceof Error ? e.message : e}`
      );
    }
  }
);

// ────────────────────────────────────────────────────
// Runs
// ────────────────────────────────────────────────────

server.tool(
  "orchagent_list_runs",
  "List recent agent execution runs in a workspace. Shows status, duration, cost, and errors.",
  {
    workspace_id: z.string().describe("Workspace UUID"),
    agent_name: z
      .string()
      .optional()
      .describe("Filter by agent name"),
    status: z
      .enum(["running", "completed", "failed", "timeout"])
      .optional()
      .describe("Filter by run status"),
    limit: z
      .number()
      .min(1)
      .max(200)
      .optional()
      .describe("Max results (default 50)"),
  },
  async ({ workspace_id, ...params }) => {
    try {
      return ok(await client().listRuns(workspace_id, params));
    } catch (e) {
      return err(
        `Failed to list runs: ${e instanceof Error ? e.message : e}`
      );
    }
  }
);

server.tool(
  "orchagent_get_run_logs",
  "Get detailed logs for a specific agent run — stdout, stderr, exit code, execution time.",
  {
    workspace_id: z.string().describe("Workspace UUID"),
    run_id: z.string().describe("Run UUID"),
  },
  async ({ workspace_id, run_id }) => {
    try {
      return ok(await client().getRunLogs(workspace_id, run_id));
    } catch (e) {
      return err(
        `Failed to get run logs: ${e instanceof Error ? e.message : e}`
      );
    }
  }
);

// ────────────────────────────────────────────────────
// Start
// ────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("orchagent MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
