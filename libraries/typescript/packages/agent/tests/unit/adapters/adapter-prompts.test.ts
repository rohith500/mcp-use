import { describe, expect, it, vi } from "vitest";

import { BaseAdapter } from "../../../src/adapters/base.js";
import type { BaseConnector } from "@mcp-use/client";

class TestAdapter extends BaseAdapter<any> {
  convertTool(tool: any): any {
    return tool;
  }

  convertResource(resource: any): any {
    return resource;
  }

  convertPrompt(prompt: any): any {
    return prompt;
  }

  async ensureConnectorInitialized(
    _connector: BaseConnector
  ): Promise<boolean> {
    return true;
  }
}

describe("BaseAdapter.loadPromptsForConnector", () => {
  it("uses listAllPrompts when present on connector", async () => {
    const adapter = new TestAdapter();
    const listAllPromptsMock = vi.fn().mockResolvedValue({
      prompts: [{ name: "prompt-1" }, { name: "prompt-2" }],
    });
    const listPromptsMock = vi.fn().mockResolvedValue({
      prompts: [{ name: "prompt-1" }],
    });

    const connector = {
      listAllPrompts: listAllPromptsMock,
      listPrompts: listPromptsMock,
    } as unknown as BaseConnector;

    const result = await adapter.loadPromptsForConnector(connector);

    expect(result).toEqual([{ name: "prompt-1" }, { name: "prompt-2" }]);
    expect(listAllPromptsMock).toHaveBeenCalledTimes(1);
    expect(listPromptsMock).not.toHaveBeenCalled();
  });

  it("falls back to listPrompts when listAllPrompts is absent for backward compatibility", async () => {
    const adapter = new TestAdapter();
    const listPromptsMock = vi.fn().mockResolvedValue({
      prompts: [{ name: "prompt-legacy" }],
    });

    const connector = {
      listPrompts: listPromptsMock,
    } as unknown as BaseConnector;

    const result = await adapter.loadPromptsForConnector(connector);

    expect(result).toEqual([{ name: "prompt-legacy" }]);
    expect(listPromptsMock).toHaveBeenCalledTimes(1);
  });
});
