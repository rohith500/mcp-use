import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { BaseConnector } from "../../../src/transport/base.js";
import {
  StdioConnector,
  StdioConnectionManager,
} from "../../../src/transport/stdio.js";
import { HttpConnector } from "../../../src/transport/http.js";

class MockConnector extends BaseConnector {
  public establishTransportCallCount = 0;
  public cleanupResourcesCallCount = 0;
  public establishDelayMs = 0;
  public cleanupDelayMs = 0;
  public shouldFailEstablish = false;

  get publicIdentifier(): Record<string, string> {
    return { type: "mock" };
  }

  protected override async establishTransport(): Promise<void> {
    this.establishTransportCallCount++;
    if (this.establishDelayMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.establishDelayMs)
      );
    }
    if (this.shouldFailEstablish) {
      throw new Error("Failed to establish transport");
    }
    this.client = {
      close: vi.fn().mockResolvedValue(undefined),
    } as any;
  }

  protected override async cleanupResources(): Promise<void> {
    this.cleanupResourcesCallCount++;
    if (this.cleanupDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.cleanupDelayMs));
    }
    await super.cleanupResources();
  }

  public get isConnected(): boolean {
    return this.connected;
  }
}

describe("Connector lifecycle concurrency", () => {
  describe("Concurrent connect() calls", () => {
    it("coalesces concurrent connect() calls and invokes establishTransport only once", async () => {
      const connector = new MockConnector();
      connector.establishDelayMs = 20;

      const [res1, res2, res3] = await Promise.all([
        connector.connect(),
        connector.connect(),
        connector.connect(),
      ]);

      expect(res1).toBeUndefined();
      expect(res2).toBeUndefined();
      expect(res3).toBeUndefined();
      expect(connector.establishTransportCallCount).toBe(1);
      expect(connector.isConnected).toBe(true);

      // Subsequent call when already connected is an immediate no-op
      await connector.connect();
      expect(connector.establishTransportCallCount).toBe(1);
    });

    it("prevents duplicate StdioConnectionManager creation and child process leaks in StdioConnector", async () => {
      const startSpy = vi
        .spyOn(StdioConnectionManager.prototype, "start")
        .mockImplementation(async function (this: StdioConnectionManager) {
          // Simulate delay in starting transport / spawning process
          await new Promise((resolve) => setTimeout(resolve, 25));
          return {
            onclose: null,
            onerror: null,
            onmessage: null,
            start: vi.fn().mockResolvedValue(undefined),
            close: vi.fn().mockResolvedValue(undefined),
            send: vi.fn().mockResolvedValue(undefined),
          } as any;
        });

      const clientConnectSpy = vi
        .spyOn(Client.prototype, "connect")
        .mockResolvedValue(undefined);

      try {
        const connector = new StdioConnector({
          command: "node",
          args: ["-e", "console.log('test')"],
        });

        // Fire 3 concurrent connect calls
        await Promise.all([
          connector.connect(),
          connector.connect(),
          connector.connect(),
        ]);

        // StdioConnectionManager.start() must only be called ONCE
        // (i.e. only a single child process is ever spawned)
        expect(startSpy).toHaveBeenCalledTimes(1);
        expect(clientConnectSpy).toHaveBeenCalledTimes(1);

        await connector.disconnect();
      } finally {
        startSpy.mockRestore();
        clientConnectSpy.mockRestore();
      }
    });

    it("coalesces concurrent connect() calls in HttpConnector without duplicate transports", async () => {
      const connector = new HttpConnector("http://localhost:8080/mcp");
      const connectStreamableSpy = vi
        .spyOn(connector as any, "connectWithStreamableHttp")
        .mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 25));
        });

      try {
        await Promise.all([
          connector.connect(),
          connector.connect(),
          connector.connect(),
        ]);

        expect(connectStreamableSpy).toHaveBeenCalledTimes(1);
        await connector.disconnect();
      } finally {
        connectStreamableSpy.mockRestore();
      }
    });
  });

  describe("Concurrent disconnect() calls", () => {
    it("coalesces concurrent disconnect() calls and runs cleanupResources only once", async () => {
      const connector = new MockConnector();
      await connector.connect();
      expect(connector.isConnected).toBe(true);

      connector.cleanupDelayMs = 20;

      const [res1, res2, res3] = await Promise.all([
        connector.disconnect(),
        connector.disconnect(),
        connector.disconnect(),
      ]);

      expect(res1).toBeUndefined();
      expect(res2).toBeUndefined();
      expect(res3).toBeUndefined();
      expect(connector.cleanupResourcesCallCount).toBe(1);
      expect(connector.isConnected).toBe(false);

      // Subsequent disconnect when already disconnected is an immediate no-op
      await connector.disconnect();
      expect(connector.cleanupResourcesCallCount).toBe(1);
    });
  });

  describe("Interleaved connect() and disconnect()", () => {
    it("safely tears down resources when disconnect() is called while connect() is in flight", async () => {
      const connector = new MockConnector();
      connector.establishDelayMs = 30;

      const connectPromise = connector.connect();

      // Trigger disconnect while connect is in flight
      const disconnectPromise = connector.disconnect();

      await expect(connectPromise).rejects.toThrow(
        "Connection cancelled by disconnect"
      );
      await expect(disconnectPromise).resolves.toBeUndefined();

      // State must be cleanly disconnected
      expect(connector.isConnected).toBe(false);
      expect(connector.isClientConnected).toBe(false);
      expect(connector.establishTransportCallCount).toBe(1);
      expect(connector.cleanupResourcesCallCount).toBe(1);
    });

    it("waits for an in-progress disconnect() to finish before executing a new connect()", async () => {
      const connector = new MockConnector();
      await connector.connect();
      expect(connector.isConnected).toBe(true);

      connector.cleanupDelayMs = 30;

      const disconnectPromise = connector.disconnect();
      // Start connect while disconnect is tearing down
      const reconnectPromise = connector.connect();

      await Promise.all([disconnectPromise, reconnectPromise]);

      // Reconnect must have completed after disconnect finished
      expect(connector.isConnected).toBe(true);
      expect(connector.establishTransportCallCount).toBe(2);
      expect(connector.cleanupResourcesCallCount).toBe(1);

      await connector.disconnect();
      expect(connector.cleanupResourcesCallCount).toBe(2);
    });
  });

  describe("Error recovery", () => {
    it("cleans up resources and permits clean retry after connection failure", async () => {
      const connector = new MockConnector();
      connector.shouldFailEstablish = true;

      await expect(connector.connect()).rejects.toThrow(
        "Failed to establish transport"
      );
      expect(connector.isConnected).toBe(false);
      expect(connector.cleanupResourcesCallCount).toBe(1);

      // Now fix the failure condition and retry
      connector.shouldFailEstablish = false;
      await connector.connect();

      expect(connector.isConnected).toBe(true);
      expect(connector.establishTransportCallCount).toBe(2);

      await connector.disconnect();
      expect(connector.isConnected).toBe(false);
    });
  });
});
