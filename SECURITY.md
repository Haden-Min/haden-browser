# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use the repository's private GitHub Security Advisory reporting flow and include reproduction steps, affected versions, impact, and any suggested mitigation.

## Security model

`haden-browser` controls a real browser and processes untrusted web content. By default it:

- accepts only HTTP and HTTPS navigation;
- rejects URLs with embedded credentials;
- resolves hostnames and blocks non-public destination addresses, including redirect/resource targets;
- blocks heavy asset requests during ordinary browsing;
- removes executable content from the DOM view;
- limits snapshot text and returned image size;
- runs as a local stdio MCP server rather than opening a listening network port.

Setting `HADEN_ALLOW_PRIVATE_HOSTS=true` intentionally relaxes a major SSRF boundary. Use it only for trusted local-development targets. In shared or hostile environments, enforce network egress and process isolation outside the application as well.

Only the latest release is expected to receive security fixes during the pre-1.0 period.
