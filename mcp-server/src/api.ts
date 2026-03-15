/**
 * Thin HTTP client for the orchagent gateway API.
 * All methods return parsed JSON or throw with a descriptive error.
 */

const DEFAULT_GATEWAY_URL = "https://api.orchagent.io";

export class GatewayClient {
  private apiKey: string;
  private baseUrl: string;

  constructor() {
    const apiKey = process.env.ORCHAGENT_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ORCHAGENT_API_KEY environment variable is required. " +
          "Get your API key from https://orchagent.io/settings/api-keys"
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = (
      process.env.ORCHAGENT_GATEWAY_URL || DEFAULT_GATEWAY_URL
    ).replace(/\/+$/, "");
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
    timeoutMs = 120_000
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method,
        headers: this.headers(extraHeaders),
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const text = await res.text();
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }

      if (!res.ok) {
        const msg =
          typeof data === "object" && data !== null && "error" in data
            ? JSON.stringify((data as { error: unknown }).error)
            : text;
        throw new Error(`${method} ${path} → ${res.status}: ${msg}`);
      }

      return data;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`${method} ${path} timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // --- Agents ---

  async listAgents(workspaceId?: string): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (workspaceId) headers["X-Workspace-Id"] = workspaceId;
    return this.request("GET", "/agents", undefined, headers);
  }

  async runAgent(
    org: string,
    agent: string,
    version: string,
    input: Record<string, unknown>,
    workspaceId?: string
  ): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (workspaceId) headers["X-Workspace-Id"] = workspaceId;
    return this.request(
      "POST",
      `/${org}/${agent}/${version}/run`,
      input,
      headers,
      300_000 // 5 min for agent runs
    );
  }

  // --- Tasks ---

  async listTasks(params?: {
    status?: string;
    project?: string;
    priority?: string;
    overdue?: boolean;
    limit?: number;
  }): Promise<unknown> {
    const qs = new URLSearchParams();
    if (params?.status) qs.set("status", params.status);
    if (params?.project) qs.set("project", params.project);
    if (params?.priority) qs.set("priority", params.priority);
    if (params?.overdue) qs.set("overdue", "true");
    if (params?.limit) qs.set("limit", String(params.limit));
    const q = qs.toString();
    return this.request("GET", `/tasks${q ? `?${q}` : ""}`);
  }

  async createTask(body: {
    title: string;
    description?: string;
    due_date?: string;
    project?: string;
    priority?: string;
  }): Promise<unknown> {
    return this.request("POST", "/tasks", body);
  }

  async updateTask(
    taskId: string,
    body: {
      title?: string;
      description?: string;
      due_date?: string;
      project?: string;
      priority?: string;
      status?: string;
    }
  ): Promise<unknown> {
    return this.request("PATCH", `/tasks/${taskId}`, body);
  }

  async deleteTask(taskId: string): Promise<unknown> {
    return this.request("DELETE", `/tasks/${taskId}`);
  }

  // --- Messages ---

  async listMessages(params?: {
    level?: string;
    agent_name?: string;
    limit?: number;
  }): Promise<unknown> {
    const qs = new URLSearchParams();
    if (params?.level) qs.set("level", params.level);
    if (params?.agent_name) qs.set("agent_name", params.agent_name);
    if (params?.limit) qs.set("limit", String(params.limit));
    const q = qs.toString();
    return this.request("GET", `/messages${q ? `?${q}` : ""}`);
  }

  async sendMessage(body: {
    title: string;
    body: string;
    level?: string;
    metadata?: Record<string, unknown>;
  }): Promise<unknown> {
    return this.request("POST", "/messages", body);
  }

  // --- Schedules ---

  async listSchedules(
    workspaceId: string,
    params?: { agent_name?: string; limit?: number }
  ): Promise<unknown> {
    const qs = new URLSearchParams();
    if (params?.agent_name) qs.set("agent_name", params.agent_name);
    if (params?.limit) qs.set("limit", String(params.limit));
    const q = qs.toString();
    return this.request(
      "GET",
      `/workspaces/${workspaceId}/schedules${q ? `?${q}` : ""}`
    );
  }

  async createSchedule(
    workspaceId: string,
    body: {
      agent_id: string;
      agent_name: string;
      agent_version: string;
      schedule_type: string;
      cron_expression?: string;
      timezone?: string;
      input_data?: Record<string, unknown>;
    }
  ): Promise<unknown> {
    return this.request(
      "POST",
      `/workspaces/${workspaceId}/schedules`,
      body
    );
  }

  async triggerSchedule(
    workspaceId: string,
    scheduleId: string,
    input?: Record<string, unknown>
  ): Promise<unknown> {
    return this.request(
      "POST",
      `/workspaces/${workspaceId}/schedules/${scheduleId}/trigger`,
      input || {}
    );
  }

  // --- Runs ---

  async listRuns(
    workspaceId: string,
    params?: {
      agent_name?: string;
      status?: string;
      limit?: number;
    }
  ): Promise<unknown> {
    const qs = new URLSearchParams();
    if (params?.agent_name) qs.set("agent_name", params.agent_name);
    if (params?.status) qs.set("status", params.status);
    if (params?.limit) qs.set("limit", String(params.limit));
    const q = qs.toString();
    return this.request(
      "GET",
      `/workspaces/${workspaceId}/runs${q ? `?${q}` : ""}`
    );
  }

  async getRunLogs(
    workspaceId: string,
    runId: string
  ): Promise<unknown> {
    return this.request(
      "GET",
      `/workspaces/${workspaceId}/runs/${runId}/logs`
    );
  }
}
