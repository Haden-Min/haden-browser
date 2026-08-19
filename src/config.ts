import type { BrowserConfig } from "./types.js";

function booleanFromEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${name} must be true or false, received: ${value}`);
}

function integerFromEnv(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}, received: ${raw}`);
  }
  return value;
}

export function loadConfig(): BrowserConfig {
  return {
    headless: booleanFromEnv("HADEN_HEADLESS", true),
    blockHeavyAssets: booleanFromEnv("HADEN_BLOCK_HEAVY_ASSETS", true),
    allowPrivateHosts: booleanFromEnv("HADEN_ALLOW_PRIVATE_HOSTS", false),
    navigationTimeoutMs: integerFromEnv("HADEN_NAVIGATION_TIMEOUT_MS", 20_000, 1_000),
    actionTimeoutMs: integerFromEnv("HADEN_ACTION_TIMEOUT_MS", 8_000, 500),
    defaultMaxChars: integerFromEnv("HADEN_MAX_CHARS", 30_000, 1_000),
    maxImageBytes: integerFromEnv("HADEN_MAX_IMAGE_BYTES", 5 * 1024 * 1024, 1024),
  };
}
