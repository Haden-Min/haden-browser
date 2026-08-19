# Browser MCP benchmark

This benchmark compares `haden-browser` with two official, commonly configured browser MCP servers:

- Microsoft Playwright MCP `0.0.78`
- Google Chrome DevTools MCP `1.7.0` in both `--slim` and full/default modes

## What it measures

1. Warm-package-cache process connection and MCP handshake time.
2. Tool-definition bytes and reference tokens exposed to the model.
3. Article navigation/read latency, response bytes, reference tokens, and origin bytes transferred.
4. A form workflow: navigate/read, fill, and submit.
5. A visual/CSS inspection workflow.
6. Explicit image inspection: original image for Haden, viewport screenshot for the general-purpose MCPs.

All products use the same Chrome for Testing executable, `1280x800` viewport, headless isolated profiles, local deterministic pages, and sequential execution. Each product is started fresh for every repetition. Package downloads and browser installation are excluded by warming the npm cache before measurement.

Token counts use `js-tiktoken` with the `o200k_base` encoding over compact JSON. Each workflow includes the tool-call name and arguments plus the complete `CallToolResult`. The core-session total adds one complete `tools/list` schema load to the article, form, and visual workflows. Binary image data is excluded from text-token counts because multimodal image accounting depends on the host and model; image bytes are reported separately. These are reproducible reference counts, not a promise of exact billed usage for every AI model.

Tool schemas are measured as the complete JSON returned by `tools/list`. Response bytes are the complete UTF-8 `CallToolResult` JSON.

Playwright MCP `0.0.78` writes automatic post-action snapshots to artifact files. The runner therefore calls `browser_snapshot` explicitly whenever inline page content is required and counts that extra MCP call; artifact file bytes and filesystem-read latency are not added to the response-byte metric.

## Run

```bash
npm install
npm run setup-browser
npm run benchmark -- --runs=5
```

Results are written to `benchmarks/results/latest.json`. The runner pins competitor versions so later results remain comparable.

The checked-in five-run report is available at [`results/2026-08-19.md`](results/2026-08-19.md).

This is a basic browsing efficiency benchmark, not a feature-completeness ranking. Chrome DevTools MCP full mode intentionally includes debugging, network, Lighthouse, and performance tooling that Haden does not provide. Slim mode is efficient but requires the model to author JavaScript and does not expose semantic action refs.
