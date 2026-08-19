import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BrowserSession } from "../src/browser/browser-session.js";
import type { BrowserConfig } from "../src/types.js";

const config: BrowserConfig = {
  headless: true,
  blockHeavyAssets: true,
  allowPrivateHosts: true,
  navigationTimeoutMs: 10_000,
  actionTimeoutMs: 5_000,
  defaultMaxChars: 10_000,
  maxImageBytes: 1024 * 1024,
};

describe("browser session", () => {
  let server: Server;
  let origin: string;
  let session: BrowserSession;

  beforeAll(async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <title>Session test</title>
        <style>img { width: 10px; height: 10px }</style>
        <main>
          <button onclick="document.querySelector('#state').textContent = 'clicked'">Run</button>
          <label>Name <input placeholder="Your name" oninput="document.querySelector('#state').textContent = this.value"></label>
          <p id="state">idle</p>
          <img alt="Tiny dot" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
        </main>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
    session = new BrowserSession(config);
  });

  afterAll(async () => {
    await session.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("opens, acts through refs, and returns the updated snapshot", async () => {
    const opened = await session.open(origin, { mode: "text", maxChars: 10_000 });
    expect(opened.content).toContain('[e1] button "Run"');
    expect(opened.content).toContain('[e2] input "Name" type=text');
    expect(opened.content).toContain('[image img1: "Tiny dot"]');

    const clicked = await session.interact(
      { action: "click", ref: "e1" },
      { mode: "text", maxChars: 10_000 },
    );
    expect(clicked.content).toContain("clicked");

    const filled = await session.interact(
      { action: "fill", ref: "e2", value: "Haden" },
      { mode: "text", maxChars: 10_000 },
    );
    expect(filled.content).toContain('value="Haden"');
    expect(filled.content).toContain("Haden");
  });

  it("retrieves image bytes only when requested", async () => {
    await session.open(origin, { mode: "text", maxChars: 10_000 });
    const image = await session.getImage("img1");
    expect(image.mimeType).toBe("image/gif");
    expect(image.alt).toBe("Tiny dot");
    expect(Buffer.from(image.data, "base64").byteLength).toBeGreaterThan(10);
  });
});
