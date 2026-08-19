import { describe, expect, it } from "vitest";

import { escapeAttribute, normalizeText, truncateText } from "../src/utils/text.js";

describe("text utilities", () => {
  it("normalizes browser text without flattening paragraphs", () => {
    expect(normalizeText("  hello\u00a0  world \n\n\n next  ")).toBe("hello world\n\nnext");
  });

  it("truncates at a natural boundary and reports it", () => {
    const result = truncateText(`${"word ".repeat(300)}\nlast`, 1_000);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(1_000);
    expect(result.text).toContain("[output truncated");
  });

  it("escapes HTML attribute characters", () => {
    expect(escapeAttribute('<a title="x&y">')).toBe("&lt;a title=&quot;x&amp;y&quot;&gt;");
  });
});
