import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { getEncoding } from "js-tiktoken";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(here);
const resultPath = join(here, "results", "latest.json");
const runsArgument = process.argv.find((value) => value.startsWith("--runs="));
const runCount = Number(runsArgument?.split("=")[1] ?? "5");
if (!Number.isInteger(runCount) || runCount < 1 || runCount > 20) {
  throw new Error("--runs must be an integer between 1 and 20");
}
const tokenizerName = "o200k_base";
const tokenizer = getEncoding(tokenizerName);

const png = createBenchmarkPng(640, 360);
const traffic = { requests: 0, bytes: 0 };
const resetTraffic = () => {
  traffic.requests = 0;
  traffic.bytes = 0;
};
const trafficSnapshot = () => ({ ...traffic });

const server = createServer((request, response) => {
  traffic.requests += 1;
  const url = new URL(request.url ?? "/", "http://benchmark.local");
  let body;
  let contentType;

  if (url.pathname === "/article") {
    body = Buffer.from(articlePage(), "utf8");
    contentType = "text/html; charset=utf-8";
  } else if (url.pathname === "/app") {
    body = Buffer.from(appPage(), "utf8");
    contentType = "text/html; charset=utf-8";
  } else if (url.pathname === "/visual") {
    body = Buffer.from(visualPage(), "utf8");
    contentType = "text/html; charset=utf-8";
  } else if (url.pathname === "/image") {
    body = Buffer.from(imagePage(), "utf8");
    contentType = "text/html; charset=utf-8";
  } else if (url.pathname.startsWith("/asset-")) {
    body = png;
    contentType = "image/png";
  } else {
    body = Buffer.from("not found", "utf8");
    contentType = "text/plain; charset=utf-8";
    response.statusCode = 404;
  }

  traffic.bytes += body.byteLength;
  response.setHeader("content-type", contentType);
  response.setHeader("content-length", String(body.byteLength));
  response.setHeader("cache-control", "no-store");
  response.end(body);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Benchmark server did not bind to TCP");
const origin = `http://127.0.0.1:${address.port}`;

const executablePath = chromium.executablePath();
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const sharedEnv = {
  ...process.env,
  CI: "1",
  CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1",
  CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1",
};

const products = [
  {
    id: "haden",
    label: "haden-browser 0.1.0",
    command: process.execPath,
    args: [join(projectRoot, "dist", "index.js")],
    env: { ...sharedEnv, HADEN_ALLOW_PRIVATE_HOSTS: "true" },
    adapterId: "haden",
  },
  {
    id: "playwright",
    label: "Playwright MCP 0.0.78",
    command: npx,
    args: [
      "-y",
      "@playwright/mcp@0.0.78",
      "--headless",
      "--isolated",
      "--viewport-size=1280x800",
      `--executable-path=${executablePath}`,
    ],
    env: sharedEnv,
    adapterId: "playwright",
  },
  {
    id: "chrome-slim",
    label: "Chrome DevTools MCP 1.7.0 Slim",
    command: npx,
    args: [
      "-y",
      "chrome-devtools-mcp@1.7.0",
      "--headless",
      "--isolated",
      "--slim",
      "--viewport=1280x800",
      `--executablePath=${executablePath}`,
      "--no-usage-statistics",
      "--no-performance-crux",
    ],
    env: sharedEnv,
    adapterId: "chrome-slim",
  },
  {
    id: "chrome-devtools",
    label: "Chrome DevTools MCP 1.7.0",
    command: npx,
    args: [
      "-y",
      "chrome-devtools-mcp@1.7.0",
      "--headless",
      "--isolated",
      "--viewport=1280x800",
      `--executablePath=${executablePath}`,
      "--no-usage-statistics",
      "--no-performance-crux",
    ],
    env: sharedEnv,
    adapterId: "chrome-devtools",
  },
];

async function executeBenchmark() {
  const rawResults = [];
  try {
    for (const product of products) {
      for (let run = 1; run <= runCount; run += 1) {
        process.stdout.write(`Running ${product.label} ${run}/${runCount}... `);
        const result = await runProduct(product, run);
        rawResults.push(result);
        process.stdout.write("done\n");
      }
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  const output = {
    generatedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      browserExecutable: executablePath,
      viewport: "1280x800",
      repetitions: runCount,
      execution: "sequential, fresh isolated process per repetition, warm npm package cache",
    },
    methodology: {
      responseSize: "UTF-8 bytes of complete MCP CallToolResult JSON",
      toolSchemaSize: "UTF-8 bytes of complete tools/list tool array JSON",
      tokenCount: `Exact ${tokenizerName} token count over compact MCP JSON`,
      workflowTokens: "MCP tool-call name and arguments plus complete CallToolResult; binary image data is excluded from text-token counts",
      coreSessionTokens: "One tool-schema load plus article, form, and visual workflow tokens; explicit image inspection is excluded",
      latency: "wall-clock milliseconds measured by the MCP client",
      imageComparison: "original image bytes for Haden; viewport screenshot bytes for general-purpose MCPs",
    },
    products: products.map(({ id, label, command, args }) => ({ id, label, command, args })),
    runs: rawResults,
    summary: summarize(rawResults, products),
  };

  await mkdir(dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  process.stdout.write(`Results: ${resultPath}\n`);
  process.stdout.write(`${JSON.stringify(output.summary, null, 2)}\n`);
}

async function runProduct(product, run) {
  const client = new Client({ name: "haden-browser-benchmark", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: product.command,
    args: product.args,
    cwd: projectRoot,
    env: product.env,
    stderr: "pipe",
    maxBufferSize: 25 * 1024 * 1024,
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const connectStart = performance.now();
  await client.connect(transport);
  const connectMs = performance.now() - connectStart;
  const listStart = performance.now();
  const { tools } = await client.listTools();
  const listToolsMs = performance.now() - listStart;

  try {
    const adapter = adapters[product.adapterId];
    if (!adapter) throw new Error(`Unknown benchmark adapter: ${product.adapterId}`);
    const call = async (name, arguments_) => {
      const start = performance.now();
      const result = await client.callTool({ name, arguments: arguments_ });
      const ms = performance.now() - start;
      if (result.isError) throw new Error(`${product.label} ${name}: ${textOf(result)}`);
      const requestTokens = tokenCount({ name, arguments: arguments_ });
      const responseTokens = tokenCount(textTokenPayload(result));
      return { result, ms, bytes: byteSize(result), requestTokens, responseTokens, totalTokens: requestTokens + responseTokens };
    };

    const context = { call, origin };
    resetTraffic();
    const article = await adapter.article(context);
    await settle();
    article.network = trafficSnapshot();

    resetTraffic();
    const form = await adapter.form(context);
    await settle();
    form.network = trafficSnapshot();

    resetTraffic();
    const visual = await adapter.visual(context);
    await settle();
    visual.network = trafficSnapshot();

    resetTraffic();
    const image = await adapter.image(context);
    await settle();
    image.network = trafficSnapshot();

    const toolSchemaTokens = tokenCount(tools);
    return {
      product: product.id,
      run,
      connectMs: round(connectMs),
      firstArticleReadyMs: round(connectMs + article.ms),
      listToolsMs: round(listToolsMs),
      toolCount: tools.length,
      toolSchemaBytes: byteSize(tools),
      toolSchemaTokens,
      coreSessionTokens: toolSchemaTokens + article.totalTokens + form.totalTokens + visual.totalTokens,
      article,
      form,
      visual,
      image,
      stderrTail: stderr.trim().split(/\r?\n/).slice(-3),
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

const hadenAdapter = {
  async article({ call, origin }) {
    return articleScenario([await call("haden_open", { url: `${origin}/article`, mode: "text", maxChars: 100_000 })]);
  },
  async form({ call, origin }) {
    const opened = await call("haden_open", { url: `${origin}/app`, mode: "text" });
    const email = matchRef(textOf(opened.result), /\[(e\d+)\] input "Email"/);
    const filled = await call("haden_interact", { action: "fill", ref: email, value: "analyst@example.com" });
    const submit = matchRef(textOf(filled.result), /\[(e\d+)\] button "Submit benchmark"/);
    const clicked = await call("haden_interact", { action: "click", ref: submit });
    return scenario([opened, filled, clicked], textOf(clicked.result).includes("Submission complete"));
  },
  async visual({ call, origin }) {
    const opened = await call("haden_open", { url: `${origin}/visual`, mode: "visual", maxChars: 100_000 });
    return scenario([opened], textOf(opened.result).includes("background=rgb"));
  },
  async image({ call, origin }) {
    const opened = await call("haden_open", { url: `${origin}/image`, mode: "text" });
    const inspected = await call("haden_image", { ref: "img1" });
    return imageScenario([opened, inspected]);
  },
};

const playwrightAdapter = {
  async article({ call, origin }) {
    const opened = await call("browser_navigate", { url: `${origin}/article` });
    const snapshot = await call("browser_snapshot", {});
    return articleScenario([opened, snapshot]);
  },
  async form({ call, origin }) {
    const opened = await call("browser_navigate", { url: `${origin}/app` });
    const snapshot = await call("browser_snapshot", {});
    const email = playwrightRef(textOf(snapshot.result), "textbox", "Email");
    const submit = playwrightRef(textOf(snapshot.result), "button", "Submit benchmark");
    const filled = await call("browser_type", { target: email, element: "Email", text: "analyst@example.com" });
    const clicked = await call("browser_click", { target: submit, element: "Submit benchmark" });
    const verified = await call("browser_snapshot", {});
    return scenario([opened, snapshot, filled, clicked, verified], textOf(verified.result).includes("Submission complete"));
  },
  async visual({ call, origin }) {
    const opened = await call("browser_navigate", { url: `${origin}/visual` });
    const evaluated = await call("browser_evaluate", { function: visualInspectionFunction });
    return scenario([opened, evaluated], textOf(evaluated.result).includes("backgroundColor"));
  },
  async image({ call, origin }) {
    const opened = await call("browser_navigate", { url: `${origin}/image` });
    const screenshot = await call("browser_take_screenshot", { type: "png", scale: "css" });
    return imageScenario([opened, screenshot]);
  },
};

const chromeAdapter = {
  async article({ call, origin }) {
    const opened = await call("navigate_page", { type: "url", url: `${origin}/article` });
    const snapshot = await call("take_snapshot", {});
    return articleScenario([opened, snapshot]);
  },
  async form({ call, origin }) {
    const opened = await call("navigate_page", { type: "url", url: `${origin}/app` });
    const snapshot = await call("take_snapshot", {});
    const email = chromeRef(textOf(snapshot.result), "textbox", "Email");
    const filled = await call("fill", { uid: email, value: "analyst@example.com", includeSnapshot: true });
    const submit = chromeRef(textOf(filled.result), "button", "Submit benchmark");
    const clicked = await call("click", { uid: submit, includeSnapshot: true });
    return scenario([opened, snapshot, filled, clicked], textOf(clicked.result).includes("Submission complete"));
  },
  async visual({ call, origin }) {
    const opened = await call("navigate_page", { type: "url", url: `${origin}/visual` });
    const evaluated = await call("evaluate_script", { function: visualInspectionFunction });
    return scenario([opened, evaluated], textOf(evaluated.result).includes("backgroundColor"));
  },
  async image({ call, origin }) {
    const opened = await call("navigate_page", { type: "url", url: `${origin}/image` });
    const screenshot = await call("take_screenshot", { format: "png" });
    return imageScenario([opened, screenshot]);
  },
};

const chromeSlimAdapter = {
  async article({ call, origin }) {
    const opened = await call("navigate", { url: `${origin}/article` });
    const read = await call("evaluate", { script: "document.body.innerText" });
    return articleScenario([opened, read], textOf(read.result).includes("AI browsing research corpus"));
  },
  async form({ call, origin }) {
    const opened = await call("navigate", { url: `${origin}/app` });
    const submitted = await call("evaluate", {
      script: `(() => {
        document.querySelector('input[type=email]').value = 'analyst@example.com';
        document.querySelector('form').requestSubmit();
        return document.body.innerText;
      })()`,
    });
    return scenario([opened, submitted], textOf(submitted.result).includes("Submission complete"));
  },
  async visual({ call, origin }) {
    const opened = await call("navigate", { url: `${origin}/visual` });
    const evaluated = await call("evaluate", { script: visualInspectionExpression });
    return scenario([opened, evaluated], textOf(evaluated.result).includes("backgroundColor"));
  },
  async image({ call, origin }) {
    const opened = await call("navigate", { url: `${origin}/image` });
    const screenshot = await call("screenshot", {});
    return imageScenario([opened, screenshot]);
  },
};

const adapters = {
  haden: hadenAdapter,
  playwright: playwrightAdapter,
  "chrome-slim": chromeSlimAdapter,
  "chrome-devtools": chromeAdapter,
};

const visualInspectionFunction = `() => [...document.querySelectorAll('[data-bench]')].map(element => {
  const style = getComputedStyle(element);
  const box = element.getBoundingClientRect();
  return {
    text: element.textContent.trim(),
    box: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
    display: style.display,
    color: style.color,
    backgroundColor: style.backgroundColor,
    font: style.font,
    padding: style.padding,
    border: style.border,
  };
})`;

const visualInspectionExpression = `JSON.stringify([...document.querySelectorAll('[data-bench]')].map(element => {
  const style = getComputedStyle(element);
  const box = element.getBoundingClientRect();
  return {
    text: element.textContent.trim(),
    box: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
    display: style.display,
    color: style.color,
    backgroundColor: style.backgroundColor,
    font: style.font,
    padding: style.padding,
    border: style.border,
  };
}))`;

function scenario(calls, success = true, imageBytes = 0) {
  return {
    calls: calls.length,
    ms: round(calls.reduce((total, call) => total + call.ms, 0)),
    responseBytes: calls.reduce((total, call) => total + call.bytes, 0),
    finalResponseBytes: calls.at(-1)?.bytes ?? 0,
    requestTokens: calls.reduce((total, call) => total + call.requestTokens, 0),
    responseTokens: calls.reduce((total, call) => total + call.responseTokens, 0),
    totalTokens: calls.reduce((total, call) => total + call.totalTokens, 0),
    imageBytes,
    success,
  };
}

function articleScenario(calls, success = true) {
  const result = scenario(calls, success);
  const text = textOf(calls.at(-1).result);
  return { ...result, ...analyzeArticle(text) };
}

function imageScenario(calls) {
  const finalResult = calls.at(-1).result;
  const imageBytes = imagePayloadBytes(finalResult);
  const contentTypes = (finalResult.content ?? []).map((content) => content.type);
  const delivery = imageBytes > 0 ? "inline-image" : contentTypes.includes("resource_link") ? "resource-link" : "text-only";
  return { ...scenario(calls, true, imageBytes), delivery, contentTypes };
}

function analyzeArticle(text) {
  return {
    sectionCount: new Set([...text.matchAll(/Section (\d+)/g)].map((match) => match[1])).size,
    actionRefCount: (text.match(/\[e\d+\]|\[ref=[^\]]+\]|uid=[^\s]+/g) ?? []).length,
    imageAltCount: (text.match(/Illustration for section/g) ?? []).length,
  };
}

function textOf(result) {
  return (result.content ?? [])
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("\n");
}

function imagePayloadBytes(result) {
  return (result.content ?? [])
    .filter((content) => content.type === "image")
    .reduce((total, content) => total + Buffer.from(content.data, "base64").byteLength, 0);
}

function byteSize(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function tokenCount(value) {
  return tokenizer.encode(JSON.stringify(value)).length;
}

function textTokenPayload(result) {
  return {
    ...result,
    content: (result.content ?? []).map((content) =>
      content.type === "image"
        ? { ...content, data: `[binary image excluded: ${Buffer.from(content.data, "base64").byteLength} bytes]` }
        : content,
    ),
  };
}

function matchRef(text, expression) {
  const value = expression.exec(text)?.[1];
  if (!value) throw new Error(`Could not find ref with ${expression} in:\n${text.slice(0, 3_000)}`);
  return value;
}

function playwrightRef(text, role, name) {
  const line = text.split(/\r?\n/).find((candidate) => candidate.includes(`${role} "${name}"`));
  return matchRef(line ?? text, /\[ref=([^\]]+)\]/);
}

function chromeRef(text, role, name) {
  const line = text.split(/\r?\n/).find((candidate) => candidate.includes(role) && candidate.includes(`"${name}"`));
  return matchRef(line ?? text, /uid=([^\s]+)/);
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 120));
}

function summarize(results, productDefinitions) {
  const metrics = [
    "connectMs",
    "firstArticleReadyMs",
    "listToolsMs",
    "toolCount",
    "toolSchemaBytes",
    "toolSchemaTokens",
    "coreSessionTokens",
    "article.ms",
    "article.responseBytes",
    "article.requestTokens",
    "article.responseTokens",
    "article.totalTokens",
    "article.network.requests",
    "article.network.bytes",
    "article.sectionCount",
    "article.actionRefCount",
    "article.imageAltCount",
    "form.calls",
    "form.ms",
    "form.responseBytes",
    "form.requestTokens",
    "form.responseTokens",
    "form.totalTokens",
    "visual.calls",
    "visual.ms",
    "visual.responseBytes",
    "visual.requestTokens",
    "visual.responseTokens",
    "visual.totalTokens",
    "image.ms",
    "image.responseBytes",
    "image.imageBytes",
  ];

  return Object.fromEntries(
    productDefinitions.map((product) => {
      const productRuns = results.filter((result) => result.product === product.id);
      const values = Object.fromEntries(
        metrics.map((metric) => [metric, median(productRuns.map((run) => getPath(run, metric)))]),
      );
      values["image.delivery"] = productRuns[0]?.image.delivery ?? "unknown";
      values.allScenariosSucceeded = productRuns.every(
        (run) => run.article.success && run.form.success && run.visual.success && run.image.success,
      );
      return [product.id, values];
    }),
  );
}

function getPath(value, path) {
  return path.split(".").reduce((current, key) => current[key], value);
}

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  const value = ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
  return round(value);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function articlePage() {
  const sections = Array.from({ length: 48 }, (_, index) => `
    <section>
      <h2>Section ${index + 1}: deterministic browser research</h2>
      <p>Benchmark paragraph ${index + 1} explains how an AI agent locates relevant information, follows semantic links, and minimizes unnecessary context while preserving the facts required to complete a browsing task.</p>
      ${index % 4 === 0 ? `<a href="#section-${index + 2}">Continue to topic ${index + 2}</a>` : ""}
      ${index % 6 === 0 ? `<img src="/asset-${index / 6}.png" alt="Illustration for section ${index + 1}">` : ""}
    </section>`).join("");
  return `<!doctype html><html><head><title>AI browsing research corpus</title><style>
    body{font:16px/1.55 system-ui;max-width:850px;margin:auto;padding:24px;color:#172033}nav{display:flex;gap:16px}
    section{border-bottom:1px solid #d8deea;padding:12px 0}img{display:block;width:320px;height:180px;object-fit:cover}
  </style></head><body><nav><a href="/article">Research</a><a href="/app">Form</a><a href="/visual">Visual</a></nav>
  <main><h1>AI browsing research corpus</h1><p>This fixed page provides enough semantic content to compare browser context efficiency.</p>${sections}</main></body></html>`;
}

function appPage() {
  return `<!doctype html><html><head><title>Agent form workflow</title><style>
    body{font:16px system-ui;max-width:680px;margin:40px auto}label{display:block;margin:16px 0}input,select,button{font:inherit;padding:10px}
  </style></head><body><main><h1>Agent form workflow</h1><form id="benchmark-form">
    <label>Email <input type="email" aria-label="Email" placeholder="name@example.com" required></label>
    <label>Role <select aria-label="Role"><option>Researcher</option><option>Engineer</option></select></label>
    <label><input type="checkbox" aria-label="Include details"> Include details</label>
    <button type="submit">Submit benchmark</button>
  </form><p id="status" role="status">Waiting for submission</p></main><script>
    document.querySelector('#benchmark-form').addEventListener('submit', event => {
      event.preventDefault();
      const email = document.querySelector('input[type=email]').value;
      document.querySelector('#status').textContent = 'Submission complete: ' + email;
    });
  </script></body></html>`;
}

function visualPage() {
  const cards = Array.from({ length: 12 }, (_, index) => `<article data-bench><h2>Metric ${index + 1}</h2><p>${(index + 1) * 17} requests</p></article>`).join("");
  return `<!doctype html><html><head><title>Computed style dashboard</title><style>
    body{font:16px/1.4 system-ui;margin:0;color:rgb(26,35,52);background:rgb(241,245,249)}
    main{max-width:1000px;margin:auto;padding:32px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
    article{background:rgb(255,255,255);padding:20px;border:1px solid rgb(203,213,225);border-radius:10px}
    h2{font-size:18px;margin:0 0 12px}p{color:rgb(3,105,161);font-weight:600}
  </style></head><body><main><h1>Computed style dashboard</h1><section class="grid">${cards}</section></main></body></html>`;
}

function imagePage() {
  return `<!doctype html><html><head><title>Image inspection target</title><style>
    body{font:16px system-ui;margin:0;padding:24px;background:#f8fafc}img{display:block;width:640px;height:360px}
  </style></head><body><main><h1>Image inspection target</h1><p>The visual should be requested only when its alt text is insufficient.</p>
    <img src="/asset-main.png" alt="Blue and orange deterministic benchmark gradient"></main></body></html>`;
}

function createBenchmarkPng(width, height) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 1;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 3;
      const red = Math.floor((x * 255) / width);
      const green = ((x ^ y) & 31) * 8;
      const blue = Math.floor((y * 255) / height);
      const previousX = x - 1;
      const previousRed = previousX < 0 ? 0 : Math.floor((previousX * 255) / width);
      const previousGreen = previousX < 0 ? 0 : ((previousX ^ y) & 31) * 8;
      const previousBlue = previousX < 0 ? 0 : blue;
      raw[offset] = (red - previousRed) & 0xff;
      raw[offset + 1] = (green - previousGreen) & 0xff;
      raw[offset + 2] = (blue - previousBlue) & 0xff;
    }
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([signature, pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, checksum]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

await executeBenchmark();
