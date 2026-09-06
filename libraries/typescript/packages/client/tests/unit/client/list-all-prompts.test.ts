import { describe, expect, it, vi } from "vitest";

import { MCPConnection } from "../../../src/core/session.js";
import { BaseConnector } from "../../../src/transport/base.js";

class TestConnector extends BaseConnector {
  async connect(): Promise<void> {}

  get publicIdentifier(): Record<string, string> {
    return { type: "test" };
  }
}

describe("listPrompts and listAllPrompts", () => {
  describe("listPrompts", () => {
    it("forwards cursor and request options to the SDK client", async () => {
      const connector = new TestConnector() as BaseConnector & {
        client: unknown;
        capabilitiesCache: unknown;
      };
      connector.capabilitiesCache = { prompts: {} };

      const prompts = [{ name: "test-prompt" }];
      const listPromptsMock = vi
        .fn()
        .mockResolvedValue({ prompts, nextCursor: "page-2" });
      connector.client = { listPrompts: listPromptsMock };

      const options = { timeout: 3000 };
      const result = await connector.listPrompts("page-1", options);

      expect(result).toEqual({ prompts, nextCursor: "page-2" });
      expect(listPromptsMock).toHaveBeenCalledWith(
        { cursor: "page-1" },
        options
      );
    });

    it("passes undefined params when cursor is omitted", async () => {
      const connector = new TestConnector() as BaseConnector & {
        client: unknown;
        capabilitiesCache: unknown;
      };
      connector.capabilitiesCache = { prompts: {} };

      const prompts = [{ name: "test-prompt" }];
      const listPromptsMock = vi.fn().mockResolvedValue({ prompts });
      connector.client = { listPrompts: listPromptsMock };

      const options = { timeout: 3000 };
      const result = await connector.listPrompts(undefined, options);

      expect(result).toEqual({ prompts });
      expect(listPromptsMock).toHaveBeenCalledWith(undefined, options);
    });

    it("returns empty prompts when server does not advertise capability", async () => {
      const connector = new TestConnector() as BaseConnector & {
        client: unknown;
        capabilitiesCache: unknown;
      };
      connector.capabilitiesCache = {};
      connector.client = { listPrompts: vi.fn() };

      const result = await connector.listPrompts();
      expect(result).toEqual({ prompts: [] });
      expect((connector.client as any).listPrompts).not.toHaveBeenCalled();
    });

    it("handles -32601 (method not found) gracefully", async () => {
      const connector = new TestConnector() as BaseConnector & {
        client: unknown;
        capabilitiesCache: unknown;
      };
      connector.capabilitiesCache = { prompts: {} };

      const methodNotFoundError = new Error("Method not found") as Error & {
        code: number;
      };
      methodNotFoundError.code = -32601;
      connector.client = {
        listPrompts: vi.fn().mockRejectedValue(methodNotFoundError),
      };

      const result = await connector.listPrompts();
      expect(result).toEqual({ prompts: [] });
    });
  });

  describe("listAllPrompts", () => {
    it("paginates across multiple pages until nextCursor is undefined", async () => {
      const connector = new TestConnector() as BaseConnector & {
        client: unknown;
        capabilitiesCache: unknown;
      };
      connector.capabilitiesCache = { prompts: {} };

      const pages: Record<string, { prompts: any[]; nextCursor?: string }> = {
        first: {
          prompts: [{ name: "prompt-1" }, { name: "prompt-2" }],
          nextCursor: "cursor-page-2",
        },
        "cursor-page-2": {
          prompts: [{ name: "prompt-3" }],
          nextCursor: "cursor-page-3",
        },
        "cursor-page-3": {
          prompts: [{ name: "prompt-4" }, { name: "prompt-5" }],
          nextCursor: undefined,
        },
      };

      const listPromptsMock = vi
        .fn()
        .mockImplementation(async (params?: { cursor?: string }) => {
          const key = params?.cursor ?? "first";
          return pages[key];
        });

      connector.client = { listPrompts: listPromptsMock };

      const result = await connector.listAllPrompts();

      expect(result).toEqual({
        prompts: [
          { name: "prompt-1" },
          { name: "prompt-2" },
          { name: "prompt-3" },
          { name: "prompt-4" },
          { name: "prompt-5" },
        ],
      });

      expect(listPromptsMock).toHaveBeenCalledTimes(3);
      expect(listPromptsMock).toHaveBeenNthCalledWith(1, undefined, undefined);
      expect(listPromptsMock).toHaveBeenNthCalledWith(
        2,
        { cursor: "cursor-page-2" },
        undefined
      );
      expect(listPromptsMock).toHaveBeenNthCalledWith(
        3,
        { cursor: "cursor-page-3" },
        undefined
      );
    });

    it("follows empty-string cursor without premature termination", async () => {
      const connector = new TestConnector() as BaseConnector & {
        client: unknown;
        capabilitiesCache: unknown;
      };
      connector.capabilitiesCache = { prompts: {} };

      const listPromptsMock = vi
        .fn()
        .mockResolvedValueOnce({
          prompts: [{ name: "prompt-1" }],
          nextCursor: "",
        })
        .mockResolvedValueOnce({
          prompts: [{ name: "prompt-2" }],
          nextCursor: undefined,
        });

      connector.client = { listPrompts: listPromptsMock };

      const result = await connector.listAllPrompts();

      expect(result).toEqual({
        prompts: [{ name: "prompt-1" }, { name: "prompt-2" }],
      });
      expect(listPromptsMock).toHaveBeenCalledTimes(2);
      expect(listPromptsMock).toHaveBeenNthCalledWith(1, undefined, undefined);
      expect(listPromptsMock).toHaveBeenNthCalledWith(
        2,
        { cursor: "" },
        undefined
      );
    });

    it("detects repeated cursor and throws error to prevent infinite loop", async () => {
      const connector = new TestConnector() as BaseConnector & {
        client: unknown;
        capabilitiesCache: unknown;
      };
      connector.capabilitiesCache = { prompts: {} };

      connector.client = {
        listPrompts: vi
          .fn()
          .mockResolvedValueOnce({
            prompts: [{ name: "p1" }],
            nextCursor: "loop-cursor",
          })
          .mockResolvedValueOnce({
            prompts: [{ name: "p2" }],
            nextCursor: "loop-cursor",
          }),
      };

      await expect(connector.listAllPrompts()).rejects.toThrow(
        "prompts/list returned a repeated pagination cursor"
      );
    });

    it("surfaces transport error when disconnect lands between pages", async () => {
      const connector = new TestConnector() as BaseConnector & {
        client: unknown;
        capabilitiesCache: unknown;
      };
      connector.capabilitiesCache = { prompts: {} };

      let page = 0;
      let connected = true;
      connector.client = {
        async listPrompts() {
          if (!connected) throw new Error("Not connected");
          page += 1;
          connected = false;
          connector.client = null;
          return {
            prompts: [{ name: `prompt-${page}` }],
            nextCursor: "next-page",
          };
        },
      };

      await expect(connector.listAllPrompts()).rejects.toThrow("Not connected");
    });

    it("returns empty prompts when server does not advertise capability", async () => {
      const connector = new TestConnector() as BaseConnector & {
        client: unknown;
        capabilitiesCache: unknown;
      };
      connector.capabilitiesCache = {};
      connector.client = { listPrompts: vi.fn() };

      const result = await connector.listAllPrompts();
      expect(result).toEqual({ prompts: [] });
      expect((connector.client as any).listPrompts).not.toHaveBeenCalled();
    });

    it("handles -32601 (method not found) gracefully", async () => {
      const connector = new TestConnector() as BaseConnector & {
        client: unknown;
        capabilitiesCache: unknown;
      };
      connector.capabilitiesCache = { prompts: {} };

      const methodNotFoundError = new Error("Method not found") as Error & {
        code: number;
      };
      methodNotFoundError.code = -32601;
      connector.client = {
        listPrompts: vi.fn().mockRejectedValue(methodNotFoundError),
      };

      const result = await connector.listAllPrompts();
      expect(result).toEqual({ prompts: [] });
    });
  });

  describe("MCPConnection delegation", () => {
    it("forwards cursor and options from MCPConnection.listPrompts", async () => {
      const connector = {
        listPrompts: vi
          .fn()
          .mockResolvedValue({ prompts: [], nextCursor: "cursor-1" }),
      };
      const connection = new MCPConnection(connector as never);
      const options = { timeout: 1000 };

      const result = await connection.listPrompts("page-1", options);
      expect(result).toEqual({ prompts: [], nextCursor: "cursor-1" });
      expect(connector.listPrompts).toHaveBeenCalledWith("page-1", options);
    });

    it("forwards options from MCPConnection.listAllPrompts", async () => {
      const connector = {
        listAllPrompts: vi
          .fn()
          .mockResolvedValue({ prompts: [{ name: "all-prompts" }] }),
      };
      const connection = new MCPConnection(connector as never);
      const options = { timeout: 1000 };

      const result = await connection.listAllPrompts(options);
      expect(result).toEqual({ prompts: [{ name: "all-prompts" }] });
      expect(connector.listAllPrompts).toHaveBeenCalledWith(options);
    });
  });
});
