/**
 * orchagent SDK for agent-to-agent calls.
 *
 * Usage:
 *   const { AgentClient } = require('orchagent-sdk');
 *
 *   const client = new AgentClient();
 *   const result = await client.call('org/agent@v1', { input: 'data' });
 */

export {
  AgentClient,
  callAgent,
  type AgentClientOptions,
  type CallOptions,
} from "./client";

export {
  AgentClientError,
  CallChainCycleError,
  DependencyCallError,
  LocalExecutionError,
  TimeoutExceededError,
} from "./errors";
