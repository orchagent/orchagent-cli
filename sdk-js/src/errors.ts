/**
 * Error classes for the orchagent SDK.
 */

export class AgentClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentClientError";
  }
}

export class DependencyCallError extends AgentClientError {
  statusCode: number | null;
  responseBody: unknown;

  constructor(
    message: string,
    statusCode: number | null = null,
    responseBody: unknown = null,
  ) {
    super(message);
    this.name = "DependencyCallError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

export class CallChainCycleError extends AgentClientError {
  constructor(message: string) {
    super(message);
    this.name = "CallChainCycleError";
  }
}

export class TimeoutExceededError extends AgentClientError {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutExceededError";
  }
}

export class LocalExecutionError extends AgentClientError {
  exitCode: number | null;
  stderr: string | null;

  constructor(
    message: string,
    exitCode: number | null = null,
    stderr: string | null = null,
  ) {
    super(message);
    this.name = "LocalExecutionError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}
