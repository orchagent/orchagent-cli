/**
 * AgentClient - SDK for agents to call other agents.
 *
 * Handles:
 * - Service key authentication
 * - Call chain propagation (prevents cycles)
 * - Deadline/timeout propagation
 * - Downstream cap propagation
 */

import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

import {
  AgentClientError,
  CallChainCycleError,
  DependencyCallError,
  LocalExecutionError,
  TimeoutExceededError,
} from "./errors";

// Header names
const CALL_CHAIN_HEADER = "x-orchagent-call-chain";
const CALL_CHAIN_SIG_HEADER = "x-orchagent-call-chain-sig";
const DEADLINE_HEADER = "x-orchagent-deadline-ms";
const MAX_HOPS_HEADER = "x-orchagent-max-hops";
const DOWNSTREAM_REMAINING_HEADER = "x-orchagent-downstream-remaining";
const REQUEST_ID_HEADER = "x-orchagent-request-id";
const BILLING_ORG_HEADER = "x-orchagent-billing-org-id";
const BILLING_ORG_SIG_HEADER = "x-orchagent-billing-org-sig";
const ROOT_RUN_ID_HEADER = "x-orchagent-root-run-id";

// Agent reference regex
const AGENT_REF_RE =
  /^([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9._-]*)@(v\d+(?:\.\d+){0,2})$/;

// Default gateway URL
const DEFAULT_GATEWAY_URL = "https://api.orchagent.io";

// Environment variable names (must match gateway orchestration contract v1)
const LOCAL_EXECUTION_ENV = "ORCHAGENT_LOCAL_EXECUTION";
const AGENTS_DIR_ENV = "ORCHAGENT_AGENTS_DIR";
const SERVICE_KEY_ENV = "ORCHAGENT_SERVICE_KEY";
const GATEWAY_URL_ENV = "ORCHAGENT_GATEWAY_URL";
const CALL_CHAIN_ENV = "ORCHAGENT_CALL_CHAIN";
const CALL_CHAIN_SIG_ENV = "ORCHAGENT_CALL_CHAIN_SIG";
const DEADLINE_ENV = "ORCHAGENT_DEADLINE_MS";
const MAX_HOPS_ENV = "ORCHAGENT_MAX_HOPS";
const DOWNSTREAM_REMAINING_ENV = "ORCHAGENT_DOWNSTREAM_REMAINING";
const BILLING_ORG_ENV = "ORCHAGENT_BILLING_ORG_ID";
const BILLING_ORG_SIG_ENV = "ORCHAGENT_BILLING_ORG_SIG";
const ROOT_RUN_ID_ENV = "ORCHAGENT_ROOT_RUN_ID";
const REQUEST_ID_ENV = "ORCHAGENT_REQUEST_ID";

export interface AgentClientOptions {
  serviceKey?: string;
  gatewayUrl?: string;
  callChain?: string[];
  deadlineMs?: number;
  maxHops?: number;
  downstreamRemaining?: number;
  requestId?: string;
  billingOrgId?: string;
  rootRunId?: string;
}

export interface CallOptions {
  endpoint?: string;
  timeout?: number;
}

/**
 * Client for calling other agents from within an orchestrator agent.
 *
 * Automatically handles:
 * - Service key authentication (from ORCHAGENT_SERVICE_KEY env var)
 * - Call chain propagation via X-Orchagent-Call-Chain header
 * - Deadline propagation via X-Orchagent-Deadline-Ms header
 * - Max hops enforcement
 *
 * Usage:
 *   const { AgentClient } = require('orchagent-sdk');
 *   const client = new AgentClient();
 *   const result = await client.call('org/agent@v1', { input: 'data' });
 */
export class AgentClient {
  serviceKey: string | undefined;
  gatewayUrl: string;
  callChain: string[];
  deadlineMs: number | null;
  maxHops: number | null;
  downstreamRemaining: number | null;
  requestId: string | null;
  billingOrgId: string | null;
  billingOrgSig: string | null;
  callChainSig: string | null;
  rootRunId: string | null;

  private _localExecution: boolean;
  private _agentsDir: string;

  constructor(options: AgentClientOptions = {}) {
    // Detect local execution mode
    this._localExecution =
      (process.env[LOCAL_EXECUTION_ENV] || "").toLowerCase() === "true";
    this._agentsDir =
      process.env[AGENTS_DIR_ENV] || join(homedir(), ".orchagent", "agents");

    // Service key — optional in local mode
    this.serviceKey = options.serviceKey || process.env[SERVICE_KEY_ENV];
    if (!this._localExecution && !this.serviceKey) {
      throw new AgentClientError(
        "No service key provided. Set ORCHAGENT_SERVICE_KEY env var or pass serviceKey option.",
      );
    }

    this.gatewayUrl =
      options.gatewayUrl ||
      process.env[GATEWAY_URL_ENV] ||
      DEFAULT_GATEWAY_URL;

    // Load call chain from env var if not provided
    if (options.callChain !== undefined) {
      this.callChain = options.callChain;
    } else if (process.env[CALL_CHAIN_ENV]) {
      this.callChain = process.env[CALL_CHAIN_ENV]!
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      this.callChain = [];
    }

    // Load deadline from env var if not provided
    if (options.deadlineMs !== undefined) {
      this.deadlineMs = options.deadlineMs;
    } else if (process.env[DEADLINE_ENV]) {
      this.deadlineMs = parseInt(process.env[DEADLINE_ENV]!, 10);
    } else {
      this.deadlineMs = null;
    }

    // Load max hops from env var if not provided
    if (options.maxHops !== undefined) {
      this.maxHops = options.maxHops;
    } else if (process.env[MAX_HOPS_ENV]) {
      this.maxHops = parseInt(process.env[MAX_HOPS_ENV]!, 10);
    } else {
      this.maxHops = null;
    }

    // Load downstream remaining from env var if not provided
    if (options.downstreamRemaining !== undefined) {
      this.downstreamRemaining = options.downstreamRemaining;
    } else if (process.env[DOWNSTREAM_REMAINING_ENV]) {
      this.downstreamRemaining = parseInt(
        process.env[DOWNSTREAM_REMAINING_ENV]!,
        10,
      );
    } else {
      this.downstreamRemaining = null;
    }

    this.requestId = options.requestId || process.env[REQUEST_ID_ENV] || null;

    // Load billing org from env var if not provided
    if (options.billingOrgId !== undefined) {
      this.billingOrgId = options.billingOrgId;
    } else if (process.env[BILLING_ORG_ENV]) {
      this.billingOrgId = process.env[BILLING_ORG_ENV]!;
    } else {
      this.billingOrgId = null;
    }

    // Load billing org HMAC signature (gateway-issued, prevents spoofing)
    this.billingOrgSig = process.env[BILLING_ORG_SIG_ENV] || null;

    // Load call chain HMAC signature (gateway-issued, prevents chain spoofing)
    this.callChainSig = process.env[CALL_CHAIN_SIG_ENV] || null;

    // Load root run ID from env var
    if (options.rootRunId !== undefined) {
      this.rootRunId = options.rootRunId;
    } else if (process.env[ROOT_RUN_ID_ENV]) {
      this.rootRunId = process.env[ROOT_RUN_ID_ENV]!;
    } else {
      this.rootRunId = null;
    }
  }

  /**
   * Create AgentClient from an HTTP request object.
   *
   * Works with Express, Koa, Fastify, or any framework with a `headers` property.
   */
  static fromRequest(
    request: { headers: Record<string, string | string[] | undefined> },
    serviceKey?: string,
  ): AgentClient {
    const h = (name: string): string | undefined => {
      const v = request.headers[name];
      return Array.isArray(v) ? v[0] : v;
    };

    const chainHeader = h(CALL_CHAIN_HEADER) || "";
    const callChain = chainHeader
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const deadlineStr = h(DEADLINE_HEADER);
    const deadlineMs = deadlineStr ? parseInt(deadlineStr, 10) : undefined;

    const maxHopsStr = h(MAX_HOPS_HEADER);
    const maxHops = maxHopsStr ? parseInt(maxHopsStr, 10) : undefined;

    const downstreamStr = h(DOWNSTREAM_REMAINING_HEADER);
    const downstreamRemaining = downstreamStr
      ? parseInt(downstreamStr, 10)
      : undefined;

    const client = new AgentClient({
      serviceKey,
      callChain,
      deadlineMs,
      maxHops,
      downstreamRemaining,
      requestId: h(REQUEST_ID_HEADER),
      billingOrgId: h(BILLING_ORG_HEADER),
      rootRunId: h(ROOT_RUN_ID_HEADER),
    });
    client.billingOrgSig = h(BILLING_ORG_SIG_HEADER) || null;
    client.callChainSig = h(CALL_CHAIN_SIG_HEADER) || null;
    return client;
  }

  /**
   * Execute a sub-agent via local subprocess.
   */
  private _callLocally(
    agentRef: string,
    inputData: Record<string, unknown>,
    timeout?: number,
  ): unknown {
    const match = agentRef.match(AGENT_REF_RE);
    if (!match) {
      throw new AgentClientError(`Invalid agent reference: ${agentRef}`);
    }

    const [, org, agent, version] = match;
    const agentDir = join(this._agentsDir, org!, agent!);
    const metaPath = join(agentDir, "agent.json");

    if (!existsSync(metaPath)) {
      throw new LocalExecutionError(
        `Agent not found: ${agentRef}. Download with: orch run ${org}/${agent}@${version} --download-only --with-deps`,
      );
    }

    const agentMeta = JSON.parse(readFileSync(metaPath, "utf-8"));
    const entrypoint: string = agentMeta.entrypoint || "sandbox_main.py";

    // Find entrypoint (check bundle dir first, then agent dir)
    const bundlePath = join(agentDir, "bundle", entrypoint);
    const directPath = join(agentDir, entrypoint);

    let entrypointPath: string;
    let cwd: string;

    if (existsSync(bundlePath)) {
      entrypointPath = bundlePath;
      cwd = join(agentDir, "bundle");
    } else if (existsSync(directPath)) {
      entrypointPath = directPath;
      cwd = agentDir;
    } else {
      throw new LocalExecutionError(`Entrypoint not found: ${entrypoint}`);
    }

    // Determine command based on entrypoint extension
    const cmd = entrypoint.endsWith(".js") ? "node" : "python3";

    // Build subprocess environment
    const env: Record<string, string> = { ...process.env } as Record<
      string,
      string
    >;
    env[LOCAL_EXECUTION_ENV] = "true";
    env[AGENTS_DIR_ENV] = this._agentsDir;
    env[CALL_CHAIN_ENV] = [...this.callChain, agentRef].join(",");

    if (this.deadlineMs) {
      env[DEADLINE_ENV] = String(this.deadlineMs);
    }
    if (this.maxHops !== null) {
      env[MAX_HOPS_ENV] = String(Math.max(0, this.maxHops - 1));
    }
    if (this.downstreamRemaining !== null) {
      env[DOWNSTREAM_REMAINING_ENV] = String(this.downstreamRemaining);
    }
    if (this.billingOrgId !== null) {
      env[BILLING_ORG_ENV] = this.billingOrgId;
    }
    if (this.billingOrgSig !== null) {
      env[BILLING_ORG_SIG_ENV] = this.billingOrgSig;
    }
    if (this.callChainSig !== null) {
      env[CALL_CHAIN_SIG_ENV] = this.callChainSig;
    }
    if (this.rootRunId !== null) {
      env[ROOT_RUN_ID_ENV] = this.rootRunId;
    }

    // Calculate timeout from deadline
    let effectiveTimeoutMs = (timeout || 60) * 1000;
    if (this.deadlineMs) {
      const remainingMs = this.deadlineMs - Date.now();
      if (remainingMs <= 0) {
        throw new TimeoutExceededError("Deadline passed");
      }
      effectiveTimeoutMs = Math.min(effectiveTimeoutMs, remainingMs);
    }

    try {
      const stdout = execFileSync(cmd, [entrypointPath], {
        input: JSON.stringify(inputData),
        cwd,
        env,
        timeout: effectiveTimeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        encoding: "utf-8",
      });

      try {
        return JSON.parse(stdout.trim());
      } catch {
        throw new LocalExecutionError(
          `Invalid JSON from ${agentRef}: ${stdout.slice(0, 200)}`,
        );
      }
    } catch (err: unknown) {
      if (err instanceof LocalExecutionError) throw err;

      const e = err as {
        code?: string;
        status?: number;
        stderr?: string;
        killed?: boolean;
      };

      if (e.killed || e.code === "ETIMEDOUT") {
        throw new TimeoutExceededError(`Timeout calling ${agentRef}`);
      }

      throw new LocalExecutionError(
        `Agent ${agentRef} failed: ${e.stderr || "unknown error"}`,
        e.status ?? null,
        e.stderr ?? null,
      );
    }
  }

  /**
   * Call another agent as a dependency.
   *
   * @param agentRef - Agent reference in format "org/agent@version"
   * @param inputData - Input data to send to the agent
   * @param options - Optional endpoint and timeout overrides
   * @returns Response data from the agent
   */
  async call(
    agentRef: string,
    inputData: Record<string, unknown>,
    options: CallOptions = {},
  ): Promise<unknown> {
    // Validate agent reference
    const match = agentRef.match(AGENT_REF_RE);
    if (!match) {
      throw new AgentClientError(
        `Invalid agent reference: ${agentRef}. Must be org/agent@version (e.g., joe/leak-finder@v1)`,
      );
    }

    const [, org, agent, version] = match;

    // Check for cycles
    if (this.callChain.includes(agentRef)) {
      throw new CallChainCycleError(
        `Call to ${agentRef} would create a cycle. Current chain: ${this.callChain.join(" -> ")}`,
      );
    }

    // Check deadline
    const nowMs = Date.now();
    if (this.deadlineMs && nowMs >= this.deadlineMs) {
      throw new TimeoutExceededError(
        "Deadline has passed, cannot make downstream call",
      );
    }

    // Route based on execution mode
    if (this._localExecution) {
      return this._callLocally(agentRef, inputData, options.timeout);
    }

    // Calculate remaining time for timeout
    let timeout = options.timeout || 30;
    if (this.deadlineMs) {
      const remainingSeconds = (this.deadlineMs - nowMs) / 1000;
      timeout = Math.min(timeout, remainingSeconds);
    }

    // Build URL — default to "run" endpoint if none specified
    const effectiveEndpoint = options.endpoint || "run";
    const url = `${this.gatewayUrl}/${org}/${agent}/${version}/${effectiveEndpoint}`;

    // Build headers
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.serviceKey}`,
      "Content-Type": "application/json",
    };

    // Propagate call chain + HMAC signature
    if (this.callChain.length > 0) {
      headers[CALL_CHAIN_HEADER] = this.callChain.join(",");
    }
    if (this.callChainSig) {
      headers[CALL_CHAIN_SIG_HEADER] = this.callChainSig;
    }

    // Propagate deadline
    if (this.deadlineMs) {
      headers[DEADLINE_HEADER] = String(this.deadlineMs);
    }

    // Propagate max hops (decremented)
    if (this.maxHops !== null) {
      if (this.maxHops <= 0) {
        throw new AgentClientError(
          "Max hops exceeded, cannot make downstream call",
        );
      }
      headers[MAX_HOPS_HEADER] = String(this.maxHops - 1);
    }

    // Propagate downstream remaining
    if (this.downstreamRemaining !== null) {
      headers[DOWNSTREAM_REMAINING_HEADER] = String(this.downstreamRemaining);
    }

    // Propagate request ID
    if (this.requestId) {
      headers[REQUEST_ID_HEADER] = this.requestId;
    }

    // Propagate billing org ID + HMAC signature
    if (this.billingOrgId) {
      headers[BILLING_ORG_HEADER] = this.billingOrgId;
    }
    if (this.billingOrgSig) {
      headers[BILLING_ORG_SIG_HEADER] = this.billingOrgSig;
    }

    // Propagate root run ID
    if (this.rootRunId) {
      headers[ROOT_RUN_ID_HEADER] = this.rootRunId;
    }

    // Make the call using built-in fetch (Node 18+)
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      timeout * 1000,
    );

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(inputData),
        signal: controller.signal,
      });

      if (response.status >= 400) {
        let errorBody: unknown;
        try {
          errorBody = await response.json();
        } catch {
          errorBody = await response.text();
        }

        throw new DependencyCallError(
          `Agent ${agentRef} returned error: ${response.status}`,
          response.status,
          errorBody,
        );
      }

      const result = await response.json();

      // Auto-unwrap gateway envelope: the gateway wraps all responses in
      // {"data": <agent_output>, "metadata": {...}, "warnings": [...]}
      // Callers want the agent output directly, not the transport envelope.
      if (
        result &&
        typeof result === "object" &&
        "data" in result &&
        "metadata" in result
      ) {
        return result.data;
      }

      return result;
    } catch (err: unknown) {
      if (err instanceof AgentClientError) throw err;

      const e = err as { name?: string; message?: string };

      if (e.name === "AbortError") {
        throw new TimeoutExceededError(
          `Timeout calling ${agentRef}: request aborted after ${timeout}s`,
        );
      }

      throw new DependencyCallError(
        `Network error calling ${agentRef}: ${e.message || "unknown error"}`,
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Convenience function to call an agent without creating a client instance.
 *
 * For most cases, prefer using AgentClient.fromRequest() for proper
 * call chain propagation.
 */
export async function callAgent(
  agentRef: string,
  inputData: Record<string, unknown>,
  serviceKey?: string,
  options: CallOptions = {},
): Promise<unknown> {
  const client = new AgentClient({ serviceKey });
  return client.call(agentRef, inputData, options);
}
