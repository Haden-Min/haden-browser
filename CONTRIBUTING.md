# Contributing to haden-browser

Thanks for helping make web access more efficient for AI agents.

## Local setup

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Run `npm run setup-browser`.
4. Run `npm run check` before submitting a change.

## Design principles

- Optimize for useful information per token and per tool round trip.
- Keep `text` output deterministic, compact, and understandable without screenshots.
- Never return image pixels unless `haden_image` is explicitly called.
- Prefer a small, composable MCP tool surface over one tool per browser primitive.
- Preserve secure defaults. New access to local files, private networks, or credentials must be explicit and documented.
- Add tests for extraction changes against a real browser page, not only string fixtures.

## Pull requests

Keep each pull request focused. Describe the AI workflow being improved, include before/after tool output when extraction changes, and mention any token, latency, privacy, or compatibility tradeoff.

By contributing, you agree that your contribution is licensed under the MIT License.
