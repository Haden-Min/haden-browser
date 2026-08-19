import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { BrowserSession } from "./browser/browser-session.js";
import { loadConfig } from "./config.js";
import { SNAPSHOT_MODES, type Snapshot, type SnapshotMode } from "./types.js";

const modeSchema = z.enum(SNAPSHOT_MODES).default("text");
const maxCharsSchema = z.number().int().min(1_000).max(100_000).optional();

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

function formatSnapshot(snapshot: Snapshot): string {
  const lines = [
    `# ${snapshot.title || "Untitled page"}`,
    `URL: ${snapshot.url}`,
    `View: ${snapshot.mode}`,
    `Interactive elements: ${snapshot.interactiveCount}`,
    `Images: ${snapshot.imageCount}${snapshot.imageCount ? " (use haden_image with an img ref only when visual inspection is needed)" : ""}`,
    `Truncated: ${snapshot.truncated ? "yes" : "no"}`,
    "",
    snapshot.content || "[no visible content]",
  ];
  return lines.join("\n");
}

export function createHadenServer(): McpServer {
  const config = loadConfig();
  const session = new BrowserSession(config);
  const server = new McpServer(
    { name: "haden-browser", version: "0.1.0" },
    {
      instructions:
        "Use haden_open for a URL, then act on e1/e2 refs with haden_interact. " +
        "Prefer the text view for research, dom for HTML structure, and visual only when layout/CSS matters. " +
        "Images remain text placeholders; call haden_image only when seeing the actual pixels is necessary.",
    },
  );

  server.registerTool(
    "haden_open",
    {
      title: "Open web page",
      description:
        "Open an HTTP(S) URL and return an AI-optimized snapshot. text is fastest; dom returns sanitized HTML; visual adds computed layout/CSS.",
      inputSchema: z.object({
        url: z.string().url(),
        mode: modeSchema,
        maxChars: maxCharsSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ url, mode, maxChars }) => {
      try {
        const snapshot = await session.open(url, {
          mode,
          maxChars: maxChars ?? config.defaultMaxChars,
        });
        return textResult(formatSnapshot(snapshot));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "haden_read",
    {
      title: "Read current page",
      description:
        "Read the current page again, optionally limited to a CSS selector. Returns stable e refs for actions and img refs for optional image retrieval.",
      inputSchema: z.object({
        mode: modeSchema,
        selector: z.string().min(1).max(500).optional(),
        maxChars: maxCharsSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ mode, selector, maxChars }) => {
      try {
        const snapshot = await session.read({
          mode,
          maxChars: maxChars ?? config.defaultMaxChars,
          ...(selector ? { selector } : {}),
        });
        return textResult(formatSnapshot(snapshot));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "haden_interact",
    {
      title: "Interact with page",
      description:
        "Perform one browser action and immediately return the updated snapshot, avoiding an extra read call. click/fill/select need a current e ref; press can target a ref or the page.",
      inputSchema: z.object({
        action: z.enum(["click", "fill", "select", "press", "scroll", "back", "forward", "reload", "wait"]),
        ref: z.string().regex(/^e\d+$/).optional(),
        value: z.string().max(100_000).optional(),
        key: z.string().min(1).max(100).optional(),
        direction: z.enum(["up", "down", "top", "bottom"]).optional(),
        amount: z.number().int().min(1).max(10_000).optional(),
        waitMs: z.number().int().min(0).max(10_000).optional(),
        mode: modeSchema,
        maxChars: maxCharsSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ mode, maxChars, ...input }) => {
      try {
        const snapshot = await session.interact(input, {
          mode: mode as SnapshotMode,
          maxChars: maxChars ?? config.defaultMaxChars,
        });
        return textResult(formatSnapshot(snapshot));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "haden_image",
    {
      title: "Inspect image",
      description:
        "Return the actual pixels for one img ref from the latest snapshot. Use only after alt text/placeholders are insufficient for the goal.",
      inputSchema: z.object({ ref: z.string().regex(/^img\d+$/) }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ ref }) => {
      try {
        const image = await session.getImage(ref);
        const source = image.sourceUrl.startsWith("data:")
          ? "inline data URL"
          : image.sourceUrl.startsWith("blob:")
            ? "page-local blob URL"
            : image.sourceUrl;
        return {
          content: [
            {
              type: "text",
              text: `${image.id}${image.alt ? ` — ${image.alt}` : ""}\nSource: ${source}\nBytes: ${image.byteLength}`,
            },
            { type: "image", data: image.data, mimeType: image.mimeType },
          ],
        } satisfies CallToolResult;
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "haden_status",
    {
      title: "Browser status",
      description: "Report whether the browser is running and which page is active.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => textResult(JSON.stringify(await session.status(), null, 2)),
  );

  server.server.onclose = () => {
    void session.close();
  };
  return server;
}
