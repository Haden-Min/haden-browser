import { describe, expect, it } from "vitest";

import { isPrivateAddress, parseWebUrl } from "../src/security/network-policy.js";

describe("network policy", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "::1",
    "fd00::1",
    "fe80::1",
  ])("blocks non-public address %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["1.1.1.1", "8.8.8.8", "203.1.2.3", "2606:4700:4700::1111"])(
    "allows public address %s",
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );

  it("accepts only credential-free HTTP(S) URLs", () => {
    expect(parseWebUrl("https://example.com/path").href).toBe("https://example.com/path");
    expect(() => parseWebUrl("file:///etc/passwd")).toThrow(/Only http and https/);
    expect(() => parseWebUrl("https://name:secret@example.com")).toThrow(/credentials/);
  });
});
