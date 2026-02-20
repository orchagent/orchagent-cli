/**
 * Tests for the orchagent JS SDK.
 *
 * Covers:
 * - AgentClient construction (local mode, cloud mode, env var loading)
 * - Call chain cycle detection
 * - Deadline enforcement
 * - Max hops enforcement
 * - Invalid agent reference validation
 * - fromRequest() header parsing
 * - Gateway envelope unwrapping
 * - Error classes
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AgentClient,
  AgentClientError,
  CallChainCycleError,
  DependencyCallError,
  TimeoutExceededError,
  LocalExecutionError,
  callAgent,
} from "./index";

// Save original env
const originalEnv = { ...process.env };

function resetEnv() {
  // Remove all ORCHAGENT_ vars
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("ORCHAGENT_")) {
      delete process.env[key];
    }
  }
}

describe("AgentClient", () => {
  beforeEach(() => {
    resetEnv();
  });

  afterEach(() => {
    // Restore original env
    resetEnv();
    Object.assign(process.env, originalEnv);
    vi.restoreAllMocks();
  });

  describe("construction", () => {
    it("throws when no service key in cloud mode", () => {
      expect(() => new AgentClient()).toThrow("No service key provided");
    });

    it("does not throw in local execution mode without service key", () => {
      process.env.ORCHAGENT_LOCAL_EXECUTION = "true";
      const client = new AgentClient();
      expect(client.serviceKey).toBeUndefined();
    });

    it("reads service key from env var", () => {
      process.env.ORCHAGENT_SERVICE_KEY = "test-key-123";
      const client = new AgentClient();
      expect(client.serviceKey).toBe("test-key-123");
    });

    it("prefers explicit service key over env var", () => {
      process.env.ORCHAGENT_SERVICE_KEY = "env-key";
      const client = new AgentClient({ serviceKey: "explicit-key" });
      expect(client.serviceKey).toBe("explicit-key");
    });

    it("reads gateway URL from env var", () => {
      process.env.ORCHAGENT_SERVICE_KEY = "key";
      process.env.ORCHAGENT_GATEWAY_URL = "https://custom.gateway.io";
      const client = new AgentClient();
      expect(client.gatewayUrl).toBe("https://custom.gateway.io");
    });

    it("defaults gateway URL to api.orchagent.io", () => {
      process.env.ORCHAGENT_SERVICE_KEY = "key";
      const client = new AgentClient();
      expect(client.gatewayUrl).toBe("https://api.orchagent.io");
    });

    it("reads call chain from env var", () => {
      process.env.ORCHAGENT_SERVICE_KEY = "key";
      process.env.ORCHAGENT_CALL_CHAIN = "org/a@v1,org/b@v2";
      const client = new AgentClient();
      expect(client.callChain).toEqual(["org/a@v1", "org/b@v2"]);
    });

    it("reads deadline from env var", () => {
      process.env.ORCHAGENT_SERVICE_KEY = "key";
      process.env.ORCHAGENT_DEADLINE_MS = "1700000000000";
      const client = new AgentClient();
      expect(client.deadlineMs).toBe(1700000000000);
    });

    it("reads max hops from env var", () => {
      process.env.ORCHAGENT_SERVICE_KEY = "key";
      process.env.ORCHAGENT_MAX_HOPS = "5";
      const client = new AgentClient();
      expect(client.maxHops).toBe(5);
    });

    it("reads downstream remaining from env var", () => {
      process.env.ORCHAGENT_SERVICE_KEY = "key";
      process.env.ORCHAGENT_DOWNSTREAM_REMAINING = "10";
      const client = new AgentClient();
      expect(client.downstreamRemaining).toBe(10);
    });

    it("reads billing org from env var", () => {
      process.env.ORCHAGENT_SERVICE_KEY = "key";
      process.env.ORCHAGENT_BILLING_ORG_ID = "org-123";
      const client = new AgentClient();
      expect(client.billingOrgId).toBe("org-123");
    });

    it("reads root run ID from env var", () => {
      process.env.ORCHAGENT_SERVICE_KEY = "key";
      process.env.ORCHAGENT_ROOT_RUN_ID = "run-456";
      const client = new AgentClient();
      expect(client.rootRunId).toBe("run-456");
    });

    it("explicit options override env vars", () => {
      process.env.ORCHAGENT_SERVICE_KEY = "env-key";
      process.env.ORCHAGENT_CALL_CHAIN = "org/old@v1";
      process.env.ORCHAGENT_DEADLINE_MS = "999";
      process.env.ORCHAGENT_MAX_HOPS = "3";

      const client = new AgentClient({
        serviceKey: "opt-key",
        callChain: ["org/new@v1"],
        deadlineMs: 1234,
        maxHops: 7,
      });

      expect(client.serviceKey).toBe("opt-key");
      expect(client.callChain).toEqual(["org/new@v1"]);
      expect(client.deadlineMs).toBe(1234);
      expect(client.maxHops).toBe(7);
    });
  });

  describe("fromRequest()", () => {
    it("parses call chain from headers", () => {
      process.env.ORCHAGENT_SERVICE_KEY = "key";
      const client = AgentClient.fromRequest({
        headers: {
          "x-orchagent-call-chain": "org/a@v1,org/b@v2",
        },
      });
      expect(client.callChain).toEqual(["org/a@v1", "org/b@v2"]);
    });

    it("parses deadline from headers", () => {
      process.env.ORCHAGENT_SERVICE_KEY = "key";
      const client = AgentClient.fromRequest({
        headers: {
          "x-orchagent-deadline-ms": "1700000000000",
        },
      });
      expect(client.deadlineMs).toBe(1700000000000);
    });

    it("parses max hops from headers", () => {
      process.env.ORCHAGENT_SERVICE_KEY = "key";
      const client = AgentClient.fromRequest({
        headers: {
          "x-orchagent-max-hops": "3",
        },
      });
      expect(client.maxHops).toBe(3);
    });

    it("parses billing org from headers", () => {
      process.env.ORCHAGENT_SERVICE_KEY = "key";
      const client = AgentClient.fromRequest({
        headers: {
          "x-orchagent-billing-org-id": "org-789",
        },
      });
      expect(client.billingOrgId).toBe("org-789");
    });

    it("parses root run ID from headers", () => {
      process.env.ORCHAGENT_SERVICE_KEY = "key";
      const client = AgentClient.fromRequest({
        headers: {
          "x-orchagent-root-run-id": "run-abc",
        },
      });
      expect(client.rootRunId).toBe("run-abc");
    });

    it("accepts explicit service key", () => {
      const client = AgentClient.fromRequest(
        { headers: {} },
        "explicit-key",
      );
      expect(client.serviceKey).toBe("explicit-key");
    });

    it("handles empty headers gracefully", () => {
      process.env.ORCHAGENT_SERVICE_KEY = "key";
      const client = AgentClient.fromRequest({ headers: {} });
      expect(client.callChain).toEqual([]);
      expect(client.deadlineMs).toBeNull();
      expect(client.maxHops).toBeNull();
    });
  });

  describe("call() validation", () => {
    it("rejects invalid agent reference", async () => {
      process.env.ORCHAGENT_SERVICE_KEY = "key";
      const client = new AgentClient();
      await expect(client.call("bad-ref", {})).rejects.toThrow(
        "Invalid agent reference",
      );
    });

    it("accepts valid agent references", async () => {
      process.env.ORCHAGENT_SERVICE_KEY = "key";
      const client = new AgentClient();

      // These should not throw validation errors (will fail on network)
      const refs = [
        "org/agent@v1",
        "my-org/my-agent@v1.2.3",
        "joe/leak-finder@v1",
        "a1/b2.c_d@v10",
      ];

      for (const ref of refs) {
        try {
          await client.call(ref, {});
        } catch (err: unknown) {
          // Should fail on network, not validation
          expect((err as Error).message).not.toContain("Invalid agent reference");
        }
      }
    });

    it("detects call chain cycle", async () => {
      process.env.ORCHAGENT_SERVICE_KEY = "key";
      const client = new AgentClient({
        callChain: ["org/a@v1", "org/b@v1"],
      });
      await expect(client.call("org/a@v1", {})).rejects.toThrow(
        CallChainCycleError,
      );
    });

    it("includes chain in cycle error message", async () => {
      process.env.ORCHAGENT_SERVICE_KEY = "key";
      const client = new AgentClient({
        callChain: ["org/a@v1", "org/b@v1"],
      });
      await expect(client.call("org/a@v1", {})).rejects.toThrow(
        "would create a cycle",
      );
    });

    it("detects deadline expiry", async () => {
      process.env.ORCHAGENT_SERVICE_KEY = "key";
      const client = new AgentClient({
        deadlineMs: Date.now() - 1000, // 1 second in the past
      });
      await expect(client.call("org/agent@v1", {})).rejects.toThrow(
        TimeoutExceededError,
      );
    });

    it("enforces max hops", async () => {
      process.env.ORCHAGENT_SERVICE_KEY = "key";
      const client = new AgentClient({ maxHops: 0 });
      await expect(client.call("org/agent@v1", {})).rejects.toThrow(
        "Max hops exceeded",
      );
    });
  });

  describe("call() HTTP behavior", () => {
    it("unwraps gateway envelope with data+metadata", async () => {
      process.env.ORCHAGENT_SERVICE_KEY = "key";
      const client = new AgentClient();

      const mockResponse = {
        ok: true,
        status: 200,
        json: async () => ({
          data: { result: "hello" },
          metadata: { execution_time_ms: 100 },
          warnings: [],
        }),
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockResponse as unknown as Response,
      );

      const result = await client.call("org/agent@v1", { input: "test" });
      expect(result).toEqual({ result: "hello" });
    });

    it("returns raw result when no gateway envelope", async () => {
      process.env.ORCHAGENT_SERVICE_KEY = "key";
      const client = new AgentClient();

      const mockResponse = {
        ok: true,
        status: 200,
        json: async () => ({ result: "raw" }),
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockResponse as unknown as Response,
      );

      const result = await client.call("org/agent@v1", {});
      expect(result).toEqual({ result: "raw" });
    });

    it("sends correct URL with default endpoint", async () => {
      process.env.ORCHAGENT_SERVICE_KEY = "key";
      const client = new AgentClient({
        gatewayUrl: "https://test.gateway.io",
      });

      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: {}, metadata: {} }),
      } as unknown as Response);

      await client.call("myorg/myagent@v2", {});

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://test.gateway.io/myorg/myagent/v2/run",
        expect.any(Object),
      );
    });

    it("sends custom endpoint", async () => {
      process.env.ORCHAGENT_SERVICE_KEY = "key";
      const client = new AgentClient();

      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: {}, metadata: {} }),
      } as unknown as Response);

      await client.call("org/agent@v1", {}, { endpoint: "analyze" });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/analyze"),
        expect.any(Object),
      );
    });

    it("sends authorization header", async () => {
      process.env.ORCHAGENT_SERVICE_KEY = "my-secret-key";
      const client = new AgentClient();

      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: {}, metadata: {} }),
      } as unknown as Response);

      await client.call("org/agent@v1", {});

      const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer my-secret-key");
    });

    it("propagates call chain header", async () => {
      process.env.ORCHAGENT_SERVICE_KEY = "key";
      const client = new AgentClient({
        callChain: ["org/a@v1"],
      });

      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: {}, metadata: {} }),
      } as unknown as Response);

      await client.call("org/b@v1", {});

      const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers["x-orchagent-call-chain"]).toBe("org/a@v1");
    });

    it("propagates deadline header", async () => {
      process.env.ORCHAGENT_SERVICE_KEY = "key";
      const deadline = Date.now() + 60000;
      const client = new AgentClient({ deadlineMs: deadline });

      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: {}, metadata: {} }),
      } as unknown as Response);

      await client.call("org/agent@v1", {});

      const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers["x-orchagent-deadline-ms"]).toBe(String(deadline));
    });

    it("decrements max hops in header", async () => {
      process.env.ORCHAGENT_SERVICE_KEY = "key";
      const client = new AgentClient({ maxHops: 5 });

      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: {}, metadata: {} }),
      } as unknown as Response);

      await client.call("org/agent@v1", {});

      const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers["x-orchagent-max-hops"]).toBe("4");
    });

    it("propagates billing org header", async () => {
      process.env.ORCHAGENT_SERVICE_KEY = "key";
      const client = new AgentClient({ billingOrgId: "org-billing" });

      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: {}, metadata: {} }),
      } as unknown as Response);

      await client.call("org/agent@v1", {});

      const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers["x-orchagent-billing-org-id"]).toBe("org-billing");
    });

    it("throws DependencyCallError on 4xx/5xx", async () => {
      process.env.ORCHAGENT_SERVICE_KEY = "key";
      const client = new AgentClient();

      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ detail: "Not found" }),
      } as unknown as Response);

      await expect(client.call("org/agent@v1", {})).rejects.toThrow(
        DependencyCallError,
      );
    });

    it("includes status code in DependencyCallError", async () => {
      process.env.ORCHAGENT_SERVICE_KEY = "key";
      const client = new AgentClient();

      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ detail: "Forbidden" }),
      } as unknown as Response);

      try {
        await client.call("org/agent@v1", {});
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(DependencyCallError);
        expect((err as DependencyCallError).statusCode).toBe(403);
        expect((err as DependencyCallError).responseBody).toEqual({
          detail: "Forbidden",
        });
      }
    });
  });

  describe("callAgent() convenience function", () => {
    it("creates client and calls agent", async () => {
      process.env.ORCHAGENT_SERVICE_KEY = "key";

      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: { result: "ok" }, metadata: {} }),
      } as unknown as Response);

      const result = await callAgent("org/agent@v1", { input: "test" });
      expect(result).toEqual({ result: "ok" });
    });
  });

  describe("error classes", () => {
    it("AgentClientError has correct name", () => {
      const err = new AgentClientError("test");
      expect(err.name).toBe("AgentClientError");
      expect(err.message).toBe("test");
      expect(err).toBeInstanceOf(Error);
    });

    it("DependencyCallError stores status code and body", () => {
      const err = new DependencyCallError("fail", 500, { error: "internal" });
      expect(err.name).toBe("DependencyCallError");
      expect(err.statusCode).toBe(500);
      expect(err.responseBody).toEqual({ error: "internal" });
      expect(err).toBeInstanceOf(AgentClientError);
    });

    it("CallChainCycleError has correct name", () => {
      const err = new CallChainCycleError("cycle detected");
      expect(err.name).toBe("CallChainCycleError");
      expect(err).toBeInstanceOf(AgentClientError);
    });

    it("TimeoutExceededError has correct name", () => {
      const err = new TimeoutExceededError("timed out");
      expect(err.name).toBe("TimeoutExceededError");
      expect(err).toBeInstanceOf(AgentClientError);
    });

    it("LocalExecutionError stores exit code and stderr", () => {
      const err = new LocalExecutionError("failed", 1, "error output");
      expect(err.name).toBe("LocalExecutionError");
      expect(err.exitCode).toBe(1);
      expect(err.stderr).toBe("error output");
      expect(err).toBeInstanceOf(AgentClientError);
    });
  });
});
