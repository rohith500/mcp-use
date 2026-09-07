import { describe, expect, it, vi } from "vitest";

import { BaseConnector } from "../../../src/transport/base.js";

class TestConnector extends BaseConnector {
  async connect(): Promise<void> {}

  get publicIdentifier(): Record<string, string> {
    return { type: "test" };
  }
}

describe("listAllResources pagination resilience", () => {
  it("paginates across multiple pages until nextCursor is undefined", async () => {
    const connector = new TestConnector() as BaseConnector & {
      client: unknown;
      capabilitiesCache: unknown;
    };
    connector.capabilitiesCache = { resources: {} };

    const listResourcesMock = vi
      .fn()
      .mockResolvedValueOnce({
        resources: [{ uri: "res://1", name: "One" }],
        nextCursor: "cursor-page-2",
      })
      .mockResolvedValueOnce({
        resources: [{ uri: "res://2", name: "Two" }],
        nextCursor: "cursor-page-3",
      })
      .mockResolvedValueOnce({
        resources: [{ uri: "res://3", name: "Three" }],
        nextCursor: undefined,
      });

    connector.client = { listResources: listResourcesMock };

    const result = await connector.listAllResources();

    expect(result).toEqual({
      resources: [
        { uri: "res://1", name: "One" },
        { uri: "res://2", name: "Two" },
        { uri: "res://3", name: "Three" },
      ],
    });
    expect(listResourcesMock).toHaveBeenCalledTimes(3);
    // First call must omit cursor or pass undefined, NOT { cursor: undefined }
    expect(listResourcesMock).toHaveBeenNthCalledWith(1, undefined, undefined);
    expect(listResourcesMock).toHaveBeenNthCalledWith(
      2,
      { cursor: "cursor-page-2" },
      undefined
    );
    expect(listResourcesMock).toHaveBeenNthCalledWith(
      3,
      { cursor: "cursor-page-3" },
      undefined
    );
  });

  it("detects immediate repeated cursor cycles and throws an error", async () => {
    const connector = new TestConnector() as BaseConnector & {
      client: unknown;
      capabilitiesCache: unknown;
    };
    connector.capabilitiesCache = { resources: {} };

    const listResourcesMock = vi
      .fn()
      .mockResolvedValueOnce({
        resources: [{ uri: "res://1", name: "One" }],
        nextCursor: "repeat-cursor",
      })
      .mockResolvedValueOnce({
        resources: [{ uri: "res://2", name: "Two" }],
        nextCursor: "repeat-cursor",
      });

    connector.client = { listResources: listResourcesMock };

    await expect(connector.listAllResources()).rejects.toThrow(
      "resources/list returned a repeated pagination cursor"
    );
    expect(listResourcesMock).toHaveBeenCalledTimes(2);
  });

  it("detects multi-hop cursor cycles (A -> B -> A) and throws an error", async () => {
    const connector = new TestConnector() as BaseConnector & {
      client: unknown;
      capabilitiesCache: unknown;
    };
    connector.capabilitiesCache = { resources: {} };

    const listResourcesMock = vi
      .fn()
      .mockResolvedValueOnce({
        resources: [{ uri: "res://1" }],
        nextCursor: "cursor-A",
      })
      .mockResolvedValueOnce({
        resources: [{ uri: "res://2" }],
        nextCursor: "cursor-B",
      })
      .mockResolvedValueOnce({
        resources: [{ uri: "res://3" }],
        nextCursor: "cursor-A",
      });

    connector.client = { listResources: listResourcesMock };

    await expect(connector.listAllResources()).rejects.toThrow(
      "resources/list returned a repeated pagination cursor"
    );
    expect(listResourcesMock).toHaveBeenCalledTimes(3);
  });

  it("does not terminate prematurely when nextCursor is an empty string", async () => {
    const connector = new TestConnector() as BaseConnector & {
      client: unknown;
      capabilitiesCache: unknown;
    };
    connector.capabilitiesCache = { resources: {} };

    const listResourcesMock = vi
      .fn()
      .mockResolvedValueOnce({
        resources: [{ uri: "res://1" }],
        nextCursor: "",
      })
      .mockResolvedValueOnce({
        resources: [{ uri: "res://2" }],
        nextCursor: undefined,
      });

    connector.client = { listResources: listResourcesMock };

    const result = await connector.listAllResources();

    expect(result).toEqual({
      resources: [{ uri: "res://1" }, { uri: "res://2" }],
    });
    expect(listResourcesMock).toHaveBeenCalledTimes(2);
    expect(listResourcesMock).toHaveBeenNthCalledWith(1, undefined, undefined);
    expect(listResourcesMock).toHaveBeenNthCalledWith(
      2,
      { cursor: "" },
      undefined
    );
  });
});
