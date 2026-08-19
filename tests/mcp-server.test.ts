import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createHadenServer } from "../src/server.js";

describe("MCP server contract", () => {
  let client: Client;
  let server: McpServer;

  beforeEach(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = createHadenServer();
    client = new Client({ name: "haden-test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("advertises a compact goal-oriented tool set", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "haden_open",
      "haden_read",
      "haden_interact",
      "haden_image",
      "haden_status",
    ]);

    const open = tools.find((tool) => tool.name === "haden_open");
    expect(open?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        mode: { enum: ["text", "dom", "visual"], default: "text" },
      },
    });
  });

  it("serves tool calls over MCP", async () => {
    const result = await client.callTool({ name: "haden_status", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify({ running: false }, null, 2) },
    ]);
  });
});
