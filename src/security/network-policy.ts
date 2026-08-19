import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a = 0, b = 0, c = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0] ?? "";
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized)) return true;

  const mappedIpv4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mappedIpv4 ? isPrivateIpv4(mappedIpv4) : false;
}

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) return isPrivateIpv6(address);
  return true;
}

export function parseWebUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http and https URLs are allowed, received: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("URLs containing embedded credentials are not allowed");
  }
  return url;
}

export class NetworkPolicy {
  readonly #allowPrivateHosts: boolean;
  readonly #hostSafety = new Map<string, Promise<boolean>>();

  constructor(allowPrivateHosts: boolean) {
    this.#allowPrivateHosts = allowPrivateHosts;
  }

  async assertAllowed(rawUrl: string): Promise<URL> {
    const url = parseWebUrl(rawUrl);
    if (this.#allowPrivateHosts) return url;

    const safe = await this.#isSafeHost(url.hostname);
    if (!safe) {
      throw new Error(
        `Blocked private or non-public host: ${url.hostname}. ` +
          "Set HADEN_ALLOW_PRIVATE_HOSTS=true only when local-network browsing is intended.",
      );
    }
    return url;
  }

  async #isSafeHost(hostname: string): Promise<boolean> {
    const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) {
      return false;
    }
    if (isIP(normalized)) return !isPrivateAddress(normalized);

    const cached = this.#hostSafety.get(normalized);
    if (cached) return cached;

    const resolution = lookup(normalized, { all: true, verbatim: true })
      .then((addresses) => addresses.length > 0 && addresses.every(({ address }) => !isPrivateAddress(address)))
      .catch(() => false);
    this.#hostSafety.set(normalized, resolution);
    return resolution;
  }
}
