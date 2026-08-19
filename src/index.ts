#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createHadenServer } from "./server.js";

const handle = serveStdio(createHadenServer, {
  onerror: (error) => console.error(`[haden-browser] ${error.message}`),
});

let closing = false;
const shutdown = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await handle.close();
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
